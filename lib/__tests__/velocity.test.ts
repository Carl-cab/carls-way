/**
 * Velocity accounting.
 *
 * These run against a real PostgreSQL instance, because every defect they
 * cover was a mismatch between the SQL in lib/auth.ts and the actual table —
 * exactly what a mocked driver cannot catch.
 */
import {
  VELOCITY_LIMITS,
  checkVelocityLimit,
  recordVelocity,
  reverseVelocity,
} from '../auth';
import { getSql, initializeSchema } from '../db';

const USER_ID = 9301;
const sql = getSql();

async function windowTotal(userId: number, windowType: string, currency = 'CAD') {
  const rows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS total,
           COALESCE(SUM(transaction_count), 0) AS count
    FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = ${windowType} AND currency = ${currency}
  `;
  return { total: Number(rows[0].total), count: Number(rows[0].count) };
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
    await recordVelocity(USER_ID, 100, 'CAD');

    for (const windowType of ['hourly', 'daily', 'weekly']) {
      const { total, count } = await windowTotal(USER_ID, windowType);
      expect({ windowType, total, count }).toEqual({ windowType, total: 100, count: 1 });
    }
  });

  it('accumulates across transactions in the same window', async () => {
    await recordVelocity(USER_ID, 100, 'CAD');
    await recordVelocity(USER_ID, 25.5, 'CAD');

    const { total, count } = await windowTotal(USER_ID, 'daily');
    expect(total).toBe(125.5);
    expect(count).toBe(2);
  });

  it('keeps one accumulating row per window rather than appending', async () => {
    await recordVelocity(USER_ID, 10, 'CAD');
    await recordVelocity(USER_ID, 10, 'CAD');
    await recordVelocity(USER_ID, 10, 'CAD');

    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM velocity_checks
      WHERE user_id = ${USER_ID} AND window_type = 'daily' AND transaction_count >= 0
    `;
    expect(rows[0].n).toBe(1);
  });

  it('tracks each currency separately', async () => {
    await recordVelocity(USER_ID, 100, 'CAD');
    await recordVelocity(USER_ID, 40, 'USD');

    expect((await windowTotal(USER_ID, 'daily', 'CAD')).total).toBe(100);
    expect((await windowTotal(USER_ID, 'daily', 'USD')).total).toBe(40);
  });
});

describe('checkVelocityLimit', () => {
  it('allows a transaction inside the limits', async () => {
    await recordVelocity(USER_ID, 100, 'CAD');
    await expect(checkVelocityLimit(USER_ID, 100, 'CAD')).resolves.toEqual({ allowed: true });
  });

  it('counts a recorded transaction only once against the hourly limit', async () => {
    // With the old double-counting write, one 300 send consumed 600 of the
    // 5000 verified hourly allowance.
    await recordVelocity(USER_ID, 300, 'CAD');
    const { total } = await windowTotal(USER_ID, 'hourly');
    expect(total).toBe(300);
  });

  it('blocks a transaction that would breach the hourly limit', async () => {
    const limit = VELOCITY_LIMITS.verified_user.hourly_max_amount;
    await recordVelocity(USER_ID, limit, 'CAD');

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

describe('reverseVelocity', () => {
  it('releases the reversed amount from every window', async () => {
    await recordVelocity(USER_ID, 500, 'CAD');
    await reverseVelocity(USER_ID, 200, 'CAD', 'transfer_returned');

    for (const windowType of ['hourly', 'daily', 'weekly']) {
      expect((await windowTotal(USER_ID, windowType)).total).toBe(300);
    }
  });

  it('restores headroom so a previously blocked transaction is allowed', async () => {
    const limit = VELOCITY_LIMITS.verified_user.hourly_max_amount;
    await recordVelocity(USER_ID, limit, 'CAD');
    expect((await checkVelocityLimit(USER_ID, 100, 'CAD')).allowed).toBe(false);

    await reverseVelocity(USER_ID, 100, 'CAD', 'transfer_returned');
    expect((await checkVelocityLimit(USER_ID, 100, 'CAD')).allowed).toBe(true);
  });

  it('appends a compensating row instead of mutating the original', async () => {
    await recordVelocity(USER_ID, 500, 'CAD');
    await reverseVelocity(USER_ID, 200, 'CAD');

    const rows = await sql`
      SELECT transaction_count, total_amount FROM velocity_checks
      WHERE user_id = ${USER_ID} AND window_type = 'daily'
      ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].total_amount)).toBe(500);
    expect(Number(rows[1].total_amount)).toBe(-200);
    expect(rows[1].transaction_count).toBe(-1);
  });

  it('never drives a window below zero', async () => {
    await recordVelocity(USER_ID, 50, 'CAD');
    await reverseVelocity(USER_ID, 500, 'CAD');

    expect((await windowTotal(USER_ID, 'daily')).total).toBe(0);
  });

  it('is a no-op when the window holds nothing to release', async () => {
    await reverseVelocity(USER_ID, 100, 'CAD');

    const rows = await sql`SELECT COUNT(*)::int AS n FROM velocity_checks WHERE user_id = ${USER_ID}`;
    expect(rows[0].n).toBe(0);
  });

  it('only releases the currency it was given', async () => {
    await recordVelocity(USER_ID, 300, 'CAD');
    await recordVelocity(USER_ID, 300, 'USD');
    await reverseVelocity(USER_ID, 100, 'CAD');

    expect((await windowTotal(USER_ID, 'daily', 'CAD')).total).toBe(200);
    expect((await windowTotal(USER_ID, 'daily', 'USD')).total).toBe(300);
  });

  it('rejects a non-positive amount', async () => {
    await expect(reverseVelocity(USER_ID, 0, 'CAD')).rejects.toThrow(/greater than zero/);
  });

  it('rejects an unsupported currency', async () => {
    await expect(reverseVelocity(USER_ID, 10, 'EUR')).rejects.toThrow(/Invalid currency/);
  });
});
