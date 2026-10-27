/**
 * `money:split-pay` — the durable volume control.
 *
 * Until 2026-10-26 `paySplitPortion()` moved real balances while calling
 * neither `checkVelocityLimit()` nor `recordVelocity()`. That made one premise
 * of decision 0007 false: the record says `velocity_checks` "is the control
 * that actually caps how much a user can move during an outage" for all three
 * money buckets, and for this bucket there was no such control — the
 * Redis-backed rate limit was the only one, and split-pay volume never entered
 * `velocity_checks` to consume any other path's budget either.
 *
 * Decision 0007 is Accepted, so these are the properties it now relies on:
 *
 *   1. a paid portion RECORDS velocity, so it consumes the payer's budget on
 *      every other money path;
 *   2. a portion over the ceiling is REFUSED and moves no money;
 *   3. when velocity cannot be EVALUATED at all, the payment fails CLOSED.
 *
 * (3) is the one the decision states explicitly and nothing enforced. It held
 * only incidentally — `checkVelocityLimit()` has no try/catch and no caller
 * wrapped it — so a later refactor that wrapped the call to "be resilient"
 * would have silently inverted a required fail-closed into fail-open with
 * every other test still green. That is the whole reason this file exists.
 *
 * Runs against a real PostgreSQL instance: the balances, the row lock and the
 * `velocity_checks` rows are the subject, and none of them exists in a fake.
 */

import { getSql } from '../db';
import {
  minorUnitsToMajorNumber,
  parseDatabaseMoney,
  parsePositiveMoney,
  toNarrowDatabaseDecimal,
} from '../money';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  // Passthrough spies: real behaviour by default, so nothing here is proved
  // against a fake. Individual tests override a single call.
  return {
    ...actual,
    checkVelocityLimit: vi.fn(actual.checkVelocityLimit),
    recordVelocity: vi.fn(actual.recordVelocity),
  };
});

const { checkVelocityLimit } = await import('../auth');
const { createSplit, paySplitPortion, SplitPaymentError } = await import('../splits');

// Distinct from the 9101-9104 block used by splits.test.ts so the two files
// cannot contend for the same rows or velocity windows.
const CREATOR = 9111;
const PAYER = 9112;

const sql = getSql();

const cad = (amount: string) => parsePositiveMoney(amount, 'CAD');

async function balance(userId: number): Promise<number> {
  const rows = await sql`SELECT balance_cad FROM users WHERE id = ${userId}`;
  return minorUnitsToMajorNumber(parseDatabaseMoney(String(rows[0].balance_cad), 'CAD'));
}

async function setBalance(userId: number, amount: string) {
  // parseDatabaseMoney, not parsePositiveMoney: a starting balance of '0' is a
  // legitimate fixture value and the positive parser rejects it.
  const minor = parseDatabaseMoney(amount, 'CAD');
  await sql`
    UPDATE users SET balance_cad = ${toNarrowDatabaseDecimal(minor)}
    WHERE id = ${userId}
  `;
}

async function velocityRowCount(userId: number): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM velocity_checks WHERE user_id = ${userId}
  `;
  return rows[0].n as number;
}

async function participantStatus(splitId: number, userId: number): Promise<string> {
  const rows = await sql`
    SELECT status FROM split_participants
    WHERE split_id = ${splitId} AND user_id = ${userId}
  `;
  return rows[0].status as string;
}

async function newSplit(total: string): Promise<number> {
  // createSplit returns { split, participants } — not the split row directly.
  const created = await createSplit(CREATOR, cad(total), 'CAD', 'velocity probe', [
    { userId: PAYER, amountOwed: cad(total) },
  ]);
  return created.split.id;
}

async function cleanup() {
  // Same reference-cycle ordering as splits.test.ts: break transactions ->
  // splits before deleting, then ledger rows before the transactions they cite.
  await sql`
    UPDATE transactions SET split_id = NULL
    WHERE split_id IN (SELECT id FROM splits WHERE creator_id = ${CREATOR})
  `;
  await sql`DELETE FROM splits WHERE creator_id = ${CREATOR}`;
  await sql`DELETE FROM ledger_entries WHERE user_id IN (${CREATOR}, ${PAYER})`;
  await sql`DELETE FROM transactions
            WHERE sender_id IN (${CREATOR}, ${PAYER}) OR receiver_id IN (${CREATOR}, ${PAYER})`;
  // Velocity rows are now written by this path, so they are test state. Left
  // behind they would accumulate against `daily_max_count` (25 for a verified
  // user) and make a later run fail for reasons unrelated to its assertions.
  await sql`DELETE FROM velocity_checks WHERE user_id IN (${CREATOR}, ${PAYER})`;
}

beforeEach(async () => {
  vi.mocked(checkVelocityLimit).mockClear();
  await cleanup();
  await setBalance(CREATOR, '0');
  await setBalance(PAYER, '500');
});

afterAll(cleanup);

describe('split-pay is covered by the durable volume control', () => {
  it('records velocity, so a split payment consumes the payer budget', async () => {
    const splitId = await newSplit('40.00');
    expect(await velocityRowCount(PAYER)).toBe(0);

    await paySplitPortion(splitId, PAYER);

    // The money moved...
    expect(await balance(PAYER)).toBe(460);
    expect(await balance(CREATOR)).toBe(40);
    // ...and it is now visible to every other path's velocity ceiling, which
    // is the half of the gap that silent under-counting would have left open.
    expect(await velocityRowCount(PAYER)).toBeGreaterThan(0);

    const rows = await sql`
      SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
      WHERE user_id = ${PAYER} AND window_type = 'hourly' AND currency = 'CAD'
    `;
    expect(parseDatabaseMoney(String(rows[0].total), 'CAD')).toBe(cad('40.00'));
  });

  it('checks velocity before moving money, and ON THE TRANSACTION', async () => {
    const splitId = await newSplit('15.00');
    await paySplitPortion(splitId, PAYER);

    // The fourth argument is the executor, and asserting it is present is the
    // call-site half of the pool-deadlock fix: without it checkVelocityLimit()
    // falls back to getSql() and asks the 5-connection pool for a second
    // connection while `sql.begin` still holds one. The concurrency test below
    // covers the behaviour; this covers the wiring, so a refactor that drops
    // the argument fails here with a clear reason rather than as a timeout.
    expect(vi.mocked(checkVelocityLimit)).toHaveBeenCalledWith(
      PAYER,
      cad('15.00'),
      'CAD',
      expect.anything(),
    );
    const executor = vi.mocked(checkVelocityLimit).mock.calls[0][3];
    expect(executor).toBeDefined();
    expect(typeof executor).toBe('function');
  });

  it('refuses a portion over the ceiling and moves no money', async () => {
    const splitId = await newSplit('25.00');
    vi.mocked(checkVelocityLimit).mockResolvedValueOnce({
      allowed: false,
      reason: 'Hourly limit of CAD 5,000 exceeded',
    });

    // Exactly one call: `mockResolvedValueOnce` covers one, so a second
    // invocation here would run against the real (allowed) limit and actually
    // pay the portion — which is what an earlier draft of this test did,
    // leaving the payer at 475 and the assertion below failing for a reason
    // that had nothing to do with the code under test. The error code is
    // asserted by the next test.
    await expect(paySplitPortion(splitId, PAYER)).rejects.toThrow(SplitPaymentError);

    // Nothing moved, and the portion is still owed.
    expect(await balance(PAYER)).toBe(500);
    expect(await balance(CREATOR)).toBe(0);
    expect(await participantStatus(splitId, PAYER)).toBe('pending');
  });

  it('carries the VELOCITY_EXCEEDED code, which the route maps to 429', async () => {
    const splitId = await newSplit('25.00');
    vi.mocked(checkVelocityLimit).mockResolvedValueOnce({ allowed: false, reason: 'nope' });

    const err = await paySplitPortion(splitId, PAYER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SplitPaymentError);
    expect((err as InstanceType<typeof SplitPaymentError>).code).toBe('VELOCITY_EXCEEDED');
  });

  // The requirement decision 0007 states and nothing enforced.
  it('FAILS CLOSED when velocity cannot be evaluated at all', async () => {
    const splitId = await newSplit('30.00');
    vi.mocked(checkVelocityLimit).mockRejectedValueOnce(
      new Error('connection terminated unexpectedly'),
    );

    await expect(paySplitPortion(splitId, PAYER)).rejects.toThrow(
      /connection terminated unexpectedly/,
    );

    // Fail CLOSED means exactly this: no debit, no credit, portion still owed.
    // If anybody ever wraps the checkVelocityLimit() call in a try/catch to
    // "be resilient", these three assertions are what fails.
    expect(await balance(PAYER)).toBe(500);
    expect(await balance(CREATOR)).toBe(0);
    expect(await participantStatus(splitId, PAYER)).toBe('pending');

    // And nothing was recorded for a payment that never happened.
    expect(await velocityRowCount(PAYER)).toBe(0);
  });

  // Regression test for a pool deadlock this file's own feature introduced.
  // `lib/db.ts` sets `max: 5`. When the velocity read ran on its own
  // connection via getSql() while `sql.begin` held one, five concurrent
  // portion payments held all five connections and each waited for a sixth,
  // so none could finish and release — the pool deadlocked and every query on
  // the instance stalled, not just this path. Six concurrent payments is one
  // past that ceiling. Under the defect this test does not fail an assertion,
  // it HANGS until the vitest timeout, which is exactly what the bug does to a
  // request.
  it('does not exhaust the connection pool under concurrent payments', async () => {
    const splitIds = [];
    for (let i = 0; i < 6; i += 1) splitIds.push(await newSplit('5.00'));

    const results = await Promise.all(splitIds.map((id) => paySplitPortion(id, PAYER)));

    expect(results).toHaveLength(6);
    // 500 - (6 x 5)
    expect(await balance(PAYER)).toBe(470);
    expect(await balance(CREATOR)).toBe(30);
    // Every payment consumed budget, so none of the six was silently skipped.
    expect(await velocityRowCount(PAYER)).toBeGreaterThan(0);
    const rows = await sql`
      SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
      WHERE user_id = ${PAYER} AND window_type = 'hourly' AND currency = 'CAD'
    `;
    expect(parseDatabaseMoney(String(rows[0].total), 'CAD')).toBe(cad('30.00'));
  });

  it('records velocity atomically with the payment, not after it', async () => {
    // The record runs on the transaction, so it commits with the money or not
    // at all. Previously it ran after commit on its own connection, which left
    // two failure modes: a failure there returned 500 for a payment that had
    // already succeeded, and the payer's budget stayed unconsumed.
    const splitId = await newSplit('12.00');
    await paySplitPortion(splitId, PAYER);

    const rows = await sql`
      SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
      WHERE user_id = ${PAYER} AND window_type = 'hourly' AND currency = 'CAD'
    `;
    // Balance moved and budget consumed, in one commit.
    expect(await balance(PAYER)).toBe(488);
    expect(parseDatabaseMoney(String(rows[0].total), 'CAD')).toBe(cad('12.00'));
  });

  it('does not record velocity when the payment itself fails', async () => {
    // Insufficient balance aborts the transaction after the velocity gate has
    // already passed, which is the ordering that would over-count the payer's
    // budget if recordVelocity() ran inside the transaction.
    await setBalance(PAYER, '5');
    const splitId = await newSplit('50.00');

    await expect(paySplitPortion(splitId, PAYER)).rejects.toThrow(SplitPaymentError);

    expect(await balance(PAYER)).toBe(5);
    expect(await velocityRowCount(PAYER)).toBe(0);
  });
});
