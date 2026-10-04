import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getSql, upgradeLegacyMoneyColumns, MONEY_COLUMNS } from '@/lib/db';
import {
  MoneyValidationError,
  parseDatabaseMoney,
  parsePositiveMoney,
  toDatabaseDecimal,
} from '@/lib/money';

/**
 * Monetary NUMERIC values intentionally cross the postgres.js boundary as exact
 * decimal strings. Business logic parses those strings into integer minor units;
 * it must never revive the old global JS-number parser.
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
            'x', 'CA', '0.00', '0.00')
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
      if (dataType === undefined) continue;
      expect(`${table}.${column}=${dataType}`).toBe(`${table}.${column}=numeric`);
    }
  });

  it('stores a large balance as its exact decimal string', async () => {
    await sql`UPDATE users SET balance_cad = '9999999.99' WHERE id = ${userId}`;
    const rows = await sql<{ balance_cad: string }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    expect(rows[0].balance_cad).toBe('9999999.99');
    expect(parseDatabaseMoney(rows[0].balance_cad, 'CAD')).toBe(999999999);
  });

  it('does not accumulate drift across repeated exact decimal subtraction', async () => {
    await sql`UPDATE users SET balance_cad = '100.00' WHERE id = ${userId}`;
    for (let i = 0; i < 7; i++) {
      await sql`UPDATE users SET balance_cad = balance_cad - '0.10' WHERE id = ${userId}`;
    }
    const rows = await sql<{ balance_cad: string }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    expect(rows[0].balance_cad).toBe('99.30');
    expect(parseDatabaseMoney(rows[0].balance_cad, 'CAD')).toBe(9930);
  });

  it('rounds a direct SQL sub-cent assignment at the NUMERIC(14,2) column boundary', async () => {
    await sql`UPDATE users SET balance_cad = '10.005' WHERE id = ${userId}`;
    const rows = await sql<{ balance_cad: string }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    expect(rows[0].balance_cad).toBe('10.01');
  });
});

describe('canonical money boundary', () => {
  it('keeps NUMERIC values as strings and parses them only into exact cents', async () => {
    await sql`UPDATE users SET balance_cad = '100.50' WHERE id = ${userId}`;
    const rows = await sql<{ balance_cad: string }[]>`
      SELECT balance_cad FROM users WHERE id = ${userId}
    `;
    const balance = rows[0].balance_cad;

    expect(typeof balance).toBe('string');
    expect(parseDatabaseMoney(balance, 'CAD')).toBe(10050);
    expect(toDatabaseDecimal(parseDatabaseMoney(balance, 'CAD'))).toBe('100.50');
  });

  it('accepts exact two-decimal input and rejects fractions of a cent', () => {
    expect(parsePositiveMoney('0.01', 'CAD')).toBe(1);
    expect(parsePositiveMoney('100.10', 'USD')).toBe(10010);
    expect(() => parsePositiveMoney('10.005', 'CAD')).toThrow(MoneyValidationError);
    expect(() => parsePositiveMoney('1e2', 'CAD')).toThrow(MoneyValidationError);
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
    await sql`INSERT INTO money_upgrade_probe (amount)
              VALUES (0.01), (99.99), (512.40), (1234.56), (9876.54), (123456.78)`;

    expect(await typeOf('money_upgrade_probe', 'amount')).toBe('real');

    await sql.unsafe(
      `ALTER TABLE public."money_upgrade_probe" ALTER COLUMN "amount" ` +
        `TYPE NUMERIC(14,2) USING ROUND(("amount"::double precision)::numeric, 2)`,
    );

    const rows = await sql<{ amount: string }[]>`
      SELECT amount FROM money_upgrade_probe ORDER BY id
    `;
    expect(rows.map((r) => r.amount)).toEqual([
      '0.01', '99.99', '512.40', '1234.56', '9876.54', '123456.78',
    ]);

    await sql`DROP TABLE money_upgrade_probe`;
  });

  it('recognises a fractional-cent value as unsafe to round automatically', async () => {
    const rows = await sql<{ legit: boolean; fractional: boolean }[]>`
      SELECT
        (1234.56::real <> ROUND((1234.56::real::double precision)::numeric, 2)::real) AS legit,
        (0.333333::real <> ROUND((0.333333::real::double precision)::numeric, 2)::real) AS fractional
    `;
    expect(rows[0].legit).toBe(false);
    expect(rows[0].fractional).toBe(true);
  });
});
