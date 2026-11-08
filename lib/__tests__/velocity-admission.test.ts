/**
 * `admitVelocity()` — the atomic admission control.
 *
 * Every money path used to run `checkVelocityLimit()` → move money →
 * `recordVelocity()`. The read and the write were separate statements on
 * separate snapshots with nothing holding the payer's rows in between, so two
 * concurrent payments by one payer each observed the pre-payment total and
 * both were admitted. The ceiling bounded a request, not an account — a
 * time-of-check/time-of-use race (CWE-367) on the control that decision 0007
 * calls "the control that actually caps how much a user can move".
 *
 * The property this file exists for is the first test below: **two concurrent
 * admissions that fit individually but not together cannot both succeed.**
 * Everything else here is the supporting contract — refusal releases its
 * claim, a rollback releases it, a retry does not double-count.
 *
 * Mutation check, run against this file:
 *   - swap the order in admitVelocity() so it reads the totals BEFORE the
 *     upsert (the old check-then-record shape) → the concurrency test admits
 *     both and fails on the consumed total.
 *   - make a refusal `return` instead of `throw` → the refusal tests fail on
 *     budget consumed by a payment that was refused.
 *
 * Real PostgreSQL only. The whole subject is row locks, snapshot visibility
 * and transaction boundaries; a fake has none of them and would report this
 * code correct under either ordering.
 */

import { getSql } from '../db';
import { parseDatabaseMoney, parsePositiveMoney } from '../money';
import { admitVelocity, reverseVelocity, VelocityLimitError, VELOCITY_LIMITS } from '../auth';

// Its own user: vitest runs files in parallel and this file drives a payer to
// a ceiling, so sharing one with split-pay-velocity.test.ts would make each
// file's result depend on the other's timing.
const PAYER = 9121;

const sql = getSql();
const cad = (amount: string) => parsePositiveMoney(amount, 'CAD');

// 'pending' KYC, so the new_user ceilings apply: 500 hourly, 1000 daily,
// 5 daily count, 2500 weekly (major units).
const LIMITS = VELOCITY_LIMITS.new_user;

const usd = (amount: string) => parsePositiveMoney(amount, 'USD');

async function consumed(
  windowType: 'hourly' | 'daily' | 'weekly',
  currency: 'CAD' | 'USD' = 'CAD',
): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
    WHERE user_id = ${PAYER} AND window_type = ${windowType} AND currency = ${currency}
  `;
  return parseDatabaseMoney(String(rows[0].total), currency);
}

/** The window boundaries `admitVelocity()` normalizes to, computed the same way. */
function windowStarts(now: Date = new Date()) {
  const hour = new Date(now); hour.setMinutes(0, 0, 0);
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const week = new Date(now);
  week.setDate(now.getDate() - now.getDay()); week.setHours(0, 0, 0, 0);
  return { hour, day, week };
}

/**
 * Seeds a window row directly, to put the payer in a state a sequence of
 * admissions cannot reach — a *previous* hour's volume, or a weekly total with
 * no matching hourly volume. Without this the hourly ceiling (500) is always
 * the first one hit and the daily (1000) and weekly (2500) amount ceilings are
 * unreachable, so they would go untested.
 */
async function seedWindow(
  windowType: 'hourly' | 'daily' | 'weekly',
  start: Date,
  amountMinor: number,
  count = 1,
  currency: 'CAD' | 'USD' = 'CAD',
) {
  await sql`
    INSERT INTO velocity_checks (user_id, window_start, window_type, transaction_count, total_amount, currency)
    VALUES (${PAYER}, ${start.toISOString()}, ${windowType}, ${count}, ${(amountMinor / 100).toFixed(2)}, ${currency})
  `;
}

async function rowCount(): Promise<number> {
  const rows = await sql`SELECT COUNT(*)::int AS n FROM velocity_checks WHERE user_id = ${PAYER}`;
  return rows[0].n as number;
}

async function cleanup() {
  await sql`DELETE FROM velocity_checks WHERE user_id = ${PAYER}`;
}

beforeEach(cleanup);
afterAll(cleanup);

describe('admitVelocity is an atomic admission, not a check and a later write', () => {
  it('SERIALIZES admissions for one payer: the second cannot decide while the first holds', async () => {
    // This is the test the file exists for, and it is written as a blocking
    // assertion rather than a race on purpose.
    //
    // The obvious version — fire two concurrent admissions that fit singly
    // but not together and assert exactly one succeeds — was written first
    // and does NOT detect the defect. Mutation-checked: reversing
    // admitVelocity() to read-then-write (the old check-then-record shape)
    // leaves it green, because whether the two transactions actually
    // interleave is up to the event loop and the driver, and in practice the
    // first finished before the second read. A concurrency test that passes
    // under the bug is worse than no test: it certifies the thing it cannot
    // see.
    //
    // What distinguishes the two designs deterministically is the LOCK.
    // Write-first takes a row lock PostgreSQL holds to commit, so a second
    // admission for the same payer is blocked at its first statement and
    // cannot reach a decision until the first transaction settles.
    // Read-first takes no lock, so the second sails past and decides on a
    // stale total. Holding the first transaction open and observing that the
    // second has not settled is therefore a direct observation of the
    // property, with no reliance on scheduling.
    const amount = cad('400.00');
    expect(amount * 2).toBeGreaterThan(LIMITS.hourly_max_amount * 100);
    expect(amount).toBeLessThanOrEqual(LIMITS.hourly_max_amount * 100);

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = sql.begin(async (tx) => {
      await admitVelocity(PAYER, amount, 'CAD', tx as never);
      await holdFirst; // keep the transaction, and its row locks, open
    });

    // Let the first transaction take its locks.
    await new Promise((r) => setTimeout(r, 200));

    let secondSettled = false;
    const second = admitVelocity(PAYER, amount, 'CAD')
      .then(() => { secondSettled = true; return 'admitted' as const; })
      .catch((err: unknown) => {
        secondSettled = true;
        if (err instanceof VelocityLimitError) return 'refused' as const;
        throw err;
      });

    await new Promise((r) => setTimeout(r, 400));
    // Under read-then-write this is `true` by now, and 'admitted'.
    expect(secondSettled, 'second admission decided while the first held the rows').toBe(false);

    releaseFirst();
    await first;

    // Now it resumes, increments on top of a settled 400, and is refused.
    await expect(second).resolves.toBe('refused');
    expect(await consumed('hourly')).toBe(amount);
  });

  it('keeps the aggregate within budget under several concurrent admissions', async () => {
    // Best-effort companion to the test above: whether these six interleave
    // is up to the scheduler, so a pass proves less than it looks. It is kept
    // because the invariant it asserts cannot be satisfied by accident —
    // consumed budget must equal the admitted count times the amount, and
    // must not exceed the ceiling, however the six happen to be ordered.
    const amount = cad('100.00');
    const ceiling = LIMITS.hourly_max_amount * 100; // 500.00 -> 5 fit, 6 do not

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () => admitVelocity(PAYER, amount, 'CAD')),
    );
    const admitted = outcomes.filter((o) => o.status === 'fulfilled').length;

    for (const o of outcomes) {
      if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(VelocityLimitError);
    }
    expect(await consumed('hourly')).toBe(admitted * amount);
    expect(await consumed('hourly')).toBeLessThanOrEqual(ceiling);
  });

  it('admits while the payer is within budget', async () => {
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).resolves.toBeUndefined();
    expect(await consumed('hourly')).toBe(cad('100.00'));
    expect(await consumed('daily')).toBe(cad('100.00'));
    expect(await consumed('weekly')).toBe(cad('100.00'));
  });

  it('refuses the admission that would cross the hourly ceiling, and consumes nothing for it', async () => {
    await admitVelocity(PAYER, cad('450.00'), 'CAD');

    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(VelocityLimitError);

    // The refused admission claimed its three rows and then rolled them back.
    // If the refusal returned instead of throwing, this reads 550.
    expect(await consumed('hourly')).toBe(cad('450.00'));
  });

  it('refuses on the daily transaction COUNT, not only on amounts', async () => {
    for (let i = 0; i < LIMITS.daily_max_count; i += 1) {
      await admitVelocity(PAYER, cad('1.00'), 'CAD');
    }
    await expect(admitVelocity(PAYER, cad('1.00'), 'CAD')).rejects.toThrow(
      /transaction count limit/i,
    );
    expect(await consumed('daily')).toBe(cad('1.00') * LIMITS.daily_max_count);
  });

  it('releases the claim when the caller rolls back, and the retry is not double-counted', async () => {
    // The reservation must survive neither a rollback (lost money control in
    // the other direction: budget charged for money that never moved) nor a
    // retry (charged twice for one payment).
    await expect(
      sql.begin(async (tx) => {
        await admitVelocity(PAYER, cad('200.00'), 'CAD', tx as never);
        throw new Error('caller aborted after admission');
      }),
    ).rejects.toThrow(/caller aborted/);

    expect(await rowCount()).toBe(0);
    expect(await consumed('hourly')).toBe(0);

    // Retrying the same payment consumes exactly once.
    await sql.begin(async (tx) => {
      await admitVelocity(PAYER, cad('200.00'), 'CAD', tx as never);
    });
    expect(await consumed('hourly')).toBe(cad('200.00'));
  });

  it('commits the claim with the caller transaction, not independently of it', async () => {
    // The counterpart of the test above: on success, the claim is part of the
    // same commit as whatever the caller did. Passing `tx` is what makes both
    // directions true; without it the claim commits on its own connection and
    // the rollback case above leaves 3 rows behind.
    await sql.begin(async (tx) => {
      await admitVelocity(PAYER, cad('75.00'), 'CAD', tx as never);
      // Still inside the transaction — uncommitted to anyone else, but
      // visible to this transaction's own subsequent reads.
      const seen = await tx`
        SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
        WHERE user_id = ${PAYER} AND window_type = 'hourly'
      `;
      expect(parseDatabaseMoney(String(seen[0].total), 'CAD')).toBe(cad('75.00'));
    });

    expect(await consumed('hourly')).toBe(cad('75.00'));
  });

  it('keeps CAD and USD budgets separate', async () => {
    // Both the claim and the verification filter on currency. A USD payment
    // must not consume a CAD ceiling, or a dual-currency user would be
    // refused in one currency for volume moved in the other — and the two
    // ceilings are denominated amounts, not a shared number.
    await admitVelocity(PAYER, cad('450.00'), 'CAD');

    // Would breach the hourly ceiling if the budgets were shared.
    await expect(admitVelocity(PAYER, usd('450.00'), 'USD')).resolves.toBeUndefined();

    expect(await consumed('hourly', 'CAD')).toBe(cad('450.00'));
    expect(await consumed('hourly', 'USD')).toBe(usd('450.00'));

    // And each currency still enforces its own ceiling.
    await expect(admitVelocity(PAYER, usd('100.00'), 'USD')).rejects.toThrow(VelocityLimitError);
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(VelocityLimitError);
  });

  it('ignores a previous hour for the hourly ceiling but still counts it daily', async () => {
    // Window boundaries are the reason velocity is three rows and not one.
    // A previous hour's volume has rolled out of the hourly window and must
    // not refuse a payment, while the same volume is still inside today.
    const { hour, day, week } = windowStarts();
    const previousHour = new Date(hour.getTime() - 60 * 60 * 1000);

    await seedWindow('hourly', previousHour, cad('450.00'));
    await seedWindow('daily', day, cad('950.00'));
    await seedWindow('weekly', week, cad('950.00'));

    // 100 against a fresh hourly window: the stale 450 is out of scope...
    // ...but 950 + 100 breaches the 1000 daily ceiling, so this is refused
    // for the DAILY reason, not the hourly one.
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(/Daily limit/i);

    // Proof the hourly window really did roll: a 40 payment fits daily too.
    await expect(admitVelocity(PAYER, cad('40.00'), 'CAD')).resolves.toBeUndefined();
    // The current hour holds only the new payment; the previous hour's row is
    // untouched and still present as evidence.
    const current = await sql`
      SELECT total_amount FROM velocity_checks
      WHERE user_id = ${PAYER} AND window_type = 'hourly' AND window_start = ${hour.toISOString()}
    `;
    expect(parseDatabaseMoney(String(current[0].total_amount), 'CAD')).toBe(cad('40.00'));
  });

  it('refuses on the weekly ceiling when hourly and daily both have room', async () => {
    const { week } = windowStarts();
    await seedWindow('weekly', week, cad('2450.00'));

    // 100 is fine hourly (500) and daily (1000); 2450 + 100 breaches weekly.
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(/Weekly limit/i);
    // Refused, so nothing was consumed in any window.
    expect(await consumed('weekly')).toBe(cad('2450.00'));
    expect(await consumed('hourly')).toBe(0);
  });

  it('releases headroom when a transfer is reversed', async () => {
    // reverseVelocity() appends compensating rows with transaction_count < 0,
    // which the partial unique index deliberately excludes. admitVelocity()
    // sums ALL rows in a window rather than reading the accumulating row, so
    // a reversal actually frees budget. If it read only the upserted row —
    // the obvious shortcut, since the upsert can RETURNING its own totals —
    // a returned transfer would never release anything.
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(VelocityLimitError);

    await reverseVelocity(PAYER, cad('300.00'), 'CAD', 'transfer_returned');

    expect(await consumed('hourly')).toBe(cad('150.00'));
    // The payment refused a moment ago now fits.
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).resolves.toBeUndefined();
    expect(await consumed('hourly')).toBe(cad('250.00'));

    // Both rows are retained: the original and its compensating entry.
    const rows = await sql`
      SELECT transaction_count FROM velocity_checks
      WHERE user_id = ${PAYER} AND window_type = 'hourly' ORDER BY id
    `;
    expect(rows.map((r) => Number(r.transaction_count))).toContain(-1);
  });

  it('rejects a non-positive or non-integer amount rather than admitting it', async () => {
    await expect(admitVelocity(PAYER, 0, 'CAD')).rejects.toThrow();
    await expect(admitVelocity(PAYER, -100, 'CAD')).rejects.toThrow();
    await expect(admitVelocity(PAYER, 10.5, 'CAD')).rejects.toThrow();
    expect(await rowCount()).toBe(0);
  });
});
