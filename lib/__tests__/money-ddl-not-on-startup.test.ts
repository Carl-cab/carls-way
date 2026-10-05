/**
 * Money-column DDL must never run as a startup or request side effect.
 *
 * initializeSchema() used to call upgradeLegacyMoneyColumns(), which issues
 * `ALTER TABLE … ALTER COLUMN … TYPE NUMERIC(14,2) USING …`. A USING clause
 * rewrites the entire table under ACCESS EXCLUSIVE, so warming a serverless
 * instance could begin rewriting a balance column — and because the call sat
 * outside the advisory-locked transaction, concurrent cold starts each
 * attempted it. Converting a financial column belongs to an authorized
 * maintenance procedure with a backup, a write drain and reconciliation.
 *
 * Asserting on a database that is already NUMERIC proves nothing, because the
 * conversion is a no-op there — which is exactly how this would pass while
 * broken. So these tests deliberately regress a column to REAL first, putting
 * the database in the one state where the old behaviour was observable.
 *
 * Both directions are checked: startup must leave the column alone, and the
 * authorized path must still be able to convert it. Removing the side effect
 * must not remove the capability.
 */
import postgres from 'postgres';
import {
  detectLegacyMoneyColumns,
  initializeSchema,
  resolveSslMode,
  upgradeLegacyMoneyColumns,
} from '../db';

const SCRATCH_DB = 'manna_money_ddl_test';

const baseUrl = process.env.DATABASE_URL!;
const scratchUrl = new URL(baseUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;

let admin: ReturnType<typeof postgres>;
let scratch: ReturnType<typeof postgres> | null = null;

function connect(url: string) {
  return postgres(url, { ssl: resolveSslMode(url), max: 1, onnotice: () => {} });
}

async function dataTypeOf(table: string, column: string): Promise<string | undefined> {
  const rows = await scratch!<{ data_type: string }[]>`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;
  return rows[0]?.data_type;
}

/** Put users.balance back to how a pre-NUMERIC deployment stored it. */
async function regressToReal(): Promise<void> {
  await scratch!.unsafe('ALTER TABLE public.users ALTER COLUMN balance TYPE REAL');
}

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = connect(adminUrl.toString());
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  scratch = connect(scratchUrl.toString());
  await initializeSchema(scratch);
}, 120000);

afterAll(async () => {
  if (scratch) await scratch.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
}, 60000);

describe('initializeSchema() does not convert money columns', () => {
  it('leaves a legacy REAL money column exactly as it found it', async () => {
    await regressToReal();
    expect(await dataTypeOf('users', 'balance')).toBe('real');

    // A second cold start. This is where the rewrite used to happen.
    await initializeSchema(scratch!);

    expect(await dataTypeOf('users', 'balance')).toBe('real');
  }, 60000);

  it('does not silently drop or rewrite rows in that column', async () => {
    // The old path converted with ROUND(…, 2), so a value surviving unchanged
    // is evidence no USING rewrite ran, not merely that the type label stuck.
    await scratch!`
      INSERT INTO users (name, username, email, password_hash, country, balance)
      VALUES ('DDL Probe', 'ddl_probe', 'ddl_probe@example.test', 'x', 'CA', 12.345)
    `;

    await initializeSchema(scratch!);

    const [row] = await scratch!<{ balance: number }[]>`
      SELECT balance FROM users WHERE username = 'ddl_probe'
    `;
    // REAL cannot hold 12.345 exactly; what matters is that it was not rounded
    // to 12.35 and re-stored, which conversion would have done.
    expect(Number(row.balance)).toBeCloseTo(12.345, 3);
    expect(Number(row.balance)).not.toBe(12.35);

    await scratch!`DELETE FROM users WHERE username = 'ddl_probe'`;
  }, 60000);

  it('reports the legacy column so an operator still learns about it', async () => {
    const legacy = await detectLegacyMoneyColumns(scratch!);

    expect(legacy).toEqual(
      expect.arrayContaining([{ table: 'users', column: 'balance', from: 'real' }]),
    );
  }, 60000);

  it('detection alone changes nothing', async () => {
    await detectLegacyMoneyColumns(scratch!);
    expect(await dataTypeOf('users', 'balance')).toBe('real');
  }, 60000);

  it('still converts when called deliberately, so the capability is intact', async () => {
    // Removing the side effect must not remove the ability. This is the path
    // the authorized maintenance procedure and /api/migrate use.
    const upgraded = await upgradeLegacyMoneyColumns(scratch!);

    expect(upgraded).toEqual(
      expect.arrayContaining([{ table: 'users', column: 'balance', from: 'real' }]),
    );
    expect(await dataTypeOf('users', 'balance')).toBe('numeric');
  }, 60000);
});
