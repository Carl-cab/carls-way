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
import { admitVelocity, VelocityLimitError, VELOCITY_LIMITS } from '../auth';

// Its own user: vitest runs files in parallel and this file drives a payer to
// a ceiling, so sharing one with split-pay-velocity.test.ts would make each
// file's result depend on the other's timing.
const PAYER = 9121;

const sql = getSql();
const cad = (amount: string) => parsePositiveMoney(amount, 'CAD');

// 'pending' KYC, so the new_user ceilings apply: 500 hourly, 1000 daily,
// 5 daily count, 2500 weekly (major units).
const LIMITS = VELOCITY_LIMITS.new_user;

async function consumed(windowType: 'hourly' | 'daily' | 'weekly'): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
    WHERE user_id = ${PAYER} AND window_type = ${windowType} AND currency = 'CAD'
  `;
  return parseDatabaseMoney(String(rows[0].total), 'CAD');
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
  it('REFUSES ONE of two concurrent admissions that fit singly but not together', async () => {
    // 400 + 400 = 800 against a 500 hourly ceiling. Either one alone is
    // admissible; together they are not. Under check-then-record BOTH read
    // 0 consumed, both were admitted, and the payer moved 800 through a
    // control that says 500.
    const amount = cad('400.00');
    expect(amount * 2).toBeGreaterThan(LIMITS.hourly_max_amount * 100);
    expect(amount).toBeLessThanOrEqual(LIMITS.hourly_max_amount * 100);

    const outcomes = await Promise.allSettled([
      admitVelocity(PAYER, amount, 'CAD'),
      admitVelocity(PAYER, amount, 'CAD'),
    ]);

    const admitted = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(VelocityLimitError);

    // And the refused one consumed nothing: the ledger of budget shows one
    // payment, not two. This is the assertion that fails loudest under the
    // old ordering — it reads 800.
    expect(await consumed('hourly')).toBe(amount);
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

  it('rejects a non-positive or non-integer amount rather than admitting it', async () => {
    await expect(admitVelocity(PAYER, 0, 'CAD')).rejects.toThrow();
    await expect(admitVelocity(PAYER, -100, 'CAD')).rejects.toThrow();
    await expect(admitVelocity(PAYER, 10.5, 'CAD')).rejects.toThrow();
    expect(await rowCount()).toBe(0);
  });
});
