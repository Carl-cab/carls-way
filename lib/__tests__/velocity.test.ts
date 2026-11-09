/**
 * Velocity accounting uses integer minor units in application code and exact
 * NUMERIC decimal strings in PostgreSQL. These tests intentionally avoid JS
 * major-unit arithmetic.
 */
import {
  VELOCITY_LIMITS,
  checkVelocityLimit,
  recordVelocity,
} from '../auth';
import { getSql, initializeSchema } from '../db';
import { parseSignedDatabaseMoney } from '../money';

const USER_ID = 9301;
const sql = getSql();

async function windowTotal(userId: number, windowType: string, currency = 'CAD') {
  const rows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS total,
           COALESCE(SUM(transaction_count), 0) AS count
    FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = ${windowType} AND currency = ${currency}
  `;
  return {
    total: parseSignedDatabaseMoney(String(rows[0].total), currency),
    count: Number(rows[0].count),
  };
}

beforeAll(async () => {
  await initializeSchema();
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
    VALUES (${USER_ID}, 'Velocity Tester', 'velocity_tester', 'velocity@example.test', 'x', 'CA', 'verified')
    ON CONFLICT (id) DO UPDATE SET kyc_status = 'verified'
  `;
});

beforeEach(async () => {
  await sql`DELETE FROM velocity_checks WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM velocity_checks WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
});

describe('velocity_checks schema', () => {
  it('is created by initializeSchema', async () => {
    const rows = await sql`SELECT to_regclass('public.velocity_checks') AS t`;
    expect(rows[0].t).toBe('velocity_checks');
  });

  it('carries the partial unique index recordVelocity upserts against', async () => {
    const rows = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'velocity_checks' AND indexname = 'velocity_checks_window_key'
    `;
    expect(rows).toHaveLength(1);
  });
});

describe('recordVelocity', () => {
  it('records the first transaction of a window exactly once', async () => {
    await recordVelocity(USER_ID, 10_000, 'CAD');

    for (const windowType of ['hourly', 'daily', 'weekly']) {
      const { total, count } = await windowTotal(USER_ID, windowType);
      expect({ windowType, total, count }).toEqual({ windowType, total: 10_000, count: 1 });
    }
  });

  it('accumulates cents exactly across transactions in the same window', async () => {
    await recordVelocity(USER_ID, 10_010, 'CAD');
    await recordVelocity(USER_ID, 2_550, 'CAD');

    const { total, count } = await windowTotal(USER_ID, 'daily');
    expect(total).toBe(12_560);
    expect(count).toBe(2);
  });

  it('keeps one accumulating row per window rather than appending', async () => {
    await recordVelocity(USER_ID, 1_000, 'CAD');
    await recordVelocity(USER_ID, 1_000, 'CAD');
    await recordVelocity(USER_ID, 1_000, 'CAD');

    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM velocity_checks
      WHERE user_id = ${USER_ID} AND window_type = 'daily' AND transaction_count >= 0
    `;
    expect(rows[0].n).toBe(1);
  });

  it('tracks each currency separately', async () => {
    await recordVelocity(USER_ID, 10_000, 'CAD');
    await recordVelocity(USER_ID, 4_000, 'USD');

    expect((await windowTotal(USER_ID, 'daily', 'CAD')).total).toBe(10_000);
    expect((await windowTotal(USER_ID, 'daily', 'USD')).total).toBe(4_000);
  });
});

describe('checkVelocityLimit', () => {
  it('allows a transaction inside the limits', async () => {
    await recordVelocity(USER_ID, 10_000, 'CAD');
    await expect(checkVelocityLimit(USER_ID, 10_000, 'CAD')).resolves.toEqual({ allowed: true });
  });

  it('counts a recorded transaction only once against the hourly limit', async () => {
    await recordVelocity(USER_ID, 30_000, 'CAD');
    const { total } = await windowTotal(USER_ID, 'hourly');
    expect(total).toBe(30_000);
  });

  it('blocks a transaction that would breach the hourly limit', async () => {
    const limitCents = VELOCITY_LIMITS.verified_user.hourly_max_amount * 100;
    await recordVelocity(USER_ID, limitCents, 'CAD');

    const result = await checkVelocityLimit(USER_ID, 1, 'CAD');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Hourly limit/);
  });

  it('blocks on the daily transaction count', async () => {
    const maxCount = VELOCITY_LIMITS.verified_user.daily_max_count;
    for (let i = 0; i < maxCount; i++) await recordVelocity(USER_ID, 1, 'CAD');

    const result = await checkVelocityLimit(USER_ID, 1, 'CAD');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/count limit/);
  });
});

// The `reverseVelocity` block that stood here has been REMOVED with its
// subject. It pinned the defective behaviour: "releases the reversed amount
// from every window" for an arbitrary caller-supplied amount, bounded only by
// the window total — which spans every money path, so it freed budget
// money:send and money:split-pay had consumed. Those assertions were correct
// about the code and wrong about what the code should do, so preserving them
// would have made the fix look like a regression.
//
// Claim-bounded release is covered by `velocity-claim-release.test.ts`.
// See `docs/decisions/0012-claim-bounded-velocity-release.md`.
