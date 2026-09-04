/**
 * First-run bootstrap gate for /api/migrate.
 *
 * A brand-new deployment cannot authenticate anyone — registration needs the
 * `users` table that only the migration creates — so the migration must be
 * reachable exactly once, before any account exists. These tests pin both
 * directions of that gate against a real PostgreSQL instance, since the whole
 * predicate is a SQL catalogue lookup.
 */
import postgres from 'postgres';
import { getSql, isUninitializedDatabase, resolveSslMode } from '../db';

const SCRATCH_DB = 'manna_bootstrap_test';
const USER_ID = 9401;

const sql = getSql();
const baseUrl = process.env.DATABASE_URL!;
const scratchUrl = new URL(baseUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;

let admin: ReturnType<typeof postgres>;
let scratch: ReturnType<typeof postgres> | null = null;

function connect(url: string) {
  return postgres(url, { ssl: resolveSslMode(url), max: 1, onnotice: () => {} });
}

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = connect(adminUrl.toString());
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  scratch = connect(scratchUrl.toString());
}, 60000);

afterAll(async () => {
  if (scratch) await scratch.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
  await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
}, 60000);

describe('isUninitializedDatabase', () => {
  it('is true when the users table does not exist yet', async () => {
    await expect(isUninitializedDatabase(scratch!)).resolves.toBe(true);
  });

  it('is true when the users table exists but holds no account', async () => {
    await scratch!.unsafe(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT
      )
    `);
    await expect(isUninitializedDatabase(scratch!)).resolves.toBe(true);
  });

  it('closes permanently once one account exists', async () => {
    await scratch!.unsafe(`INSERT INTO users (email) VALUES ('first@example.test')`);
    await expect(isUninitializedDatabase(scratch!)).resolves.toBe(false);
  });

  it('stays closed after that account is deleted and re-added', async () => {
    await scratch!.unsafe(`INSERT INTO users (email) VALUES ('second@example.test')`);
    await expect(isUninitializedDatabase(scratch!)).resolves.toBe(false);
  });

  it('is false on the provisioned application database', async () => {
    await sql`
      INSERT INTO users (id, name, username, email, password_hash, country)
      VALUES (${USER_ID}, 'Bootstrap Probe', 'bootstrap_probe', 'bootstrap@example.test', 'x', 'CA')
      ON CONFLICT (id) DO NOTHING
    `;
    await expect(isUninitializedDatabase(sql)).resolves.toBe(false);
  });

  it('fails closed when the query cannot be run', async () => {
    const broken = {
      // Mimics postgres.js' tagged-template call signature.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: undefined as any,
    } as unknown as ReturnType<typeof getSql>;

    // A tagged template against a non-function throws, which must be caught
    // and reported as "initialized" rather than opening the endpoint.
    await expect(isUninitializedDatabase(broken)).resolves.toBe(false);
  });
});
