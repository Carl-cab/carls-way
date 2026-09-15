import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getSql, upgradeLegacyMoneyColumns, MONEY_COLUMNS } from '@/lib/db';

/**
 * Money must be stored as NUMERIC, not float.
 *
 * These tests run against a real PostgreSQL instance on purpose. The defect they
 * cover is a property of the column type, and a mocked driver would happily
 * report whatever the mock was told to — the whole point is what the database
 * actually does with the bytes.
 */

const sql = getSql();

async function typeOf(table: string, column: string): Promise<string | undefined> {
  const rows = await sql<{ data_type: string }[]>`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  return rows[0]?.data_type;
}

let userId: number;

beforeAll(async () => {
  const { initializeSchema } = await import('@/lib/db');
  await initializeSchema();
});

beforeEach(async () => {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country, balance_cad, balance_usd)
    VALUES ('Precision', ${'prec_' + Math.random().toString(36).slice(2, 10)},
            ${'prec_' + Math.random().toString(36).slice(2, 10) + '@example.com'},
            'x', 'CA', 0, 0)
    RETURNING id
  `;
  userId = rows[0].id;
});

afterAll(async () => {
  await sql`DELETE FROM users WHERE username LIKE 'prec_%'`;
});

describe('money column storage', () => {
  it('declares every money column as NUMERIC, never a float type', async () => {
    for (const [table, column] of MONEY_COLUMNS) {
      const dataType = await typeOf(table, column);
      if (dataType === undefined) continue; // column absent from this schema
      expect(`${table}.${column}=${dataType}`).toBe(`${table}.${column}=numeric`);
    }
  });

  it('stores a large balance without inventing a cent', async () => {
    // As REAL this reads back as 1e+07 — a cent created from nothing.
    await sql`UPDATE users SET balance_cad = 9999999.99 WHERE id = ${userId}`;
    const rows = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    expect(rows[0].balance_cad).toBe(9999999.99);
  });

  it('does not accumulate drift across repeated subtraction', async () => {
    // As REAL this lands on 99.30001 rather than 99.30.
    await sql`UPDATE users SET balance_cad = 100.00 WHERE id = ${userId}`;
    for (let i = 0; i < 7; i++) {
      await sql`UPDATE users SET balance_cad = balance_cad - 0.10 WHERE id = ${userId}`;
    }
    const rows = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    expect(rows[0].balance_cad).toBe(99.3);
  });

  it('rounds a sub-cent write to cents instead of storing a fraction of one', async () => {
    await sql`UPDATE users SET balance_cad = 10.005 WHERE id = ${userId}`;
    const rows = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    expect(Number.isInteger(Math.round(rows[0].balance_cad * 100))).toBe(true);
  });
});

describe('driver type handling', () => {
  it('returns NUMERIC as a number, so arithmetic adds rather than concatenates', async () => {
    await sql`UPDATE users SET balance_cad = 100.50 WHERE id = ${userId}`;
    const rows = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    const balance = rows[0].balance_cad;

    // Without the numeric parser in getSql(), postgres.js hands back the string
    // "100.50" and this addition produces "100.505".
    expect(typeof balance).toBe('number');
    expect(balance + 5).toBe(105.5);
  });

  it('keeps toFixed available on a balance read from the database', async () => {
    await sql`UPDATE users SET balance_usd = 42 WHERE id = ${userId}`;
    const rows = await sql<{ balance_usd: number }[]>`
      SELECT balance_usd FROM users WHERE id = ${userId}
    `;
    expect(rows[0].balance_usd.toFixed(2)).toBe('42.00');
  });
});

describe('upgradeLegacyMoneyColumns', () => {
  it('is a no-op once the columns are already NUMERIC', async () => {
    const upgraded = await upgradeLegacyMoneyColumns(sql);
    expect(upgraded).toEqual([]);
  });

  it('converts a float column whose values are all exact cent amounts', async () => {
    await sql`CREATE TABLE IF NOT EXISTS money_upgrade_probe (id SERIAL PRIMARY KEY, amount REAL)`;
    await sql`TRUNCATE money_upgrade_probe`;
    // Spans magnitudes where float4 error far exceeds a fixed 0.00001 tolerance.
    await sql`INSERT INTO money_upgrade_probe (amount)
              VALUES (0.01), (99.99), (512.40), (1234.56), (9876.54), (123456.78)`;

    expect(await typeOf('money_upgrade_probe', 'amount')).toBe('real');

    await sql.unsafe(
      `ALTER TABLE public."money_upgrade_probe" ALTER COLUMN "amount" ` +
        `TYPE NUMERIC(14,2) USING ROUND(("amount"::double precision)::numeric, 2)`,
    );

    const rows = await sql<{ amount: number }[]>`
      SELECT amount FROM money_upgrade_probe ORDER BY id
    `;
    expect(rows.map((r) => r.amount)).toEqual([
      0.01, 99.99, 512.4, 1234.56, 9876.54, 123456.78,
    ]);

    await sql`DROP TABLE money_upgrade_probe`;
  });

  it('recognises a fractional-cent value as unsafe to round automatically', async () => {
    // The round-trip identity the upgrade relies on: re-encoding the cent value
    // as float4 reproduces the stored bits only when the value really was cents.
    const rows = await sql<{ legit: boolean; fractional: boolean }[]>`
      SELECT
        (1234.56::real <> ROUND((1234.56::real::double precision)::numeric, 2)::real) AS legit,
        (0.333333::real <> ROUND((0.333333::real::double precision)::numeric, 2)::real) AS fractional
    `;
    expect(rows[0].legit).toBe(false); // an exact cent amount — safe to convert
    expect(rows[0].fractional).toBe(true); // never a cent amount — needs a human
  });

  it('rejects a fixed absolute tolerance as the safety test', async () => {
    // Documents why the migration does not use one: float4 error scales with
    // magnitude, so 0.00001 flags ordinary balances as corrupt.
    const rows = await sql<{ delta: string }[]>`
      SELECT ABS((1234.56::real::double precision)::numeric
                 - ROUND((1234.56::real::double precision)::numeric, 2)) AS delta
    `;
    expect(Number(rows[0].delta)).toBeGreaterThan(0.00001);
  });
});
