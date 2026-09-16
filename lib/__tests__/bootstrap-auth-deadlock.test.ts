/**
 * The bootstrap window must open when authentication is impossible — not only
 * when the database is empty.
 *
 * Release 1.0 added `users.token_version`, which the auth path reads, and put
 * the ALTER that creates it behind an endpoint requiring authentication. On a
 * live database that closed a cycle: registration and login both fail on the
 * missing column, so no cookie can be obtained, so /api/migrate — the thing
 * that would add the column — cannot be reached. Production was locked out
 * until the ALTER was run by hand.
 *
 * These run against a real scratch database because the whole predicate is a
 * catalogue lookup, and because the failure being reproduced is a real
 * PostgreSQL error code (42703) that a mock would only imitate.
 */
import postgres from 'postgres';
import {
  resolveSslMode,
  isUninitializedDatabase,
  isAuthBlockedBySchema,
  isBootstrapAllowed,
  AUTH_CRITICAL_USER_COLUMNS,
} from '../db';

const SCRATCH_DB = 'manna_deadlock_test';

const baseUrl = process.env.DATABASE_URL!;
const scratchUrl = new URL(baseUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;

let admin: ReturnType<typeof postgres>;
let scratch: ReturnType<typeof postgres>;

function connect(url: string) {
  return postgres(url, { ssl: resolveSslMode(url), max: 1, onnotice: () => {} });
}

/** A live database: users table, real accounts, full auth-critical schema. */
async function seedLiveDatabase() {
  await scratch`DROP TABLE IF EXISTS users CASCADE`;
  await scratch`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'CA',
      balance_cad NUMERIC(14,2) NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0
    )
  `;
  await scratch`
    INSERT INTO users (name, username, email, password_hash, balance_cad)
    VALUES ('Existing Customer', 'existing', 'existing@example.test', 'x', 250.75)
  `;
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
  await scratch.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
}, 60000);

beforeEach(seedLiveDatabase);

describe('the deadlock this closes', () => {
  it('reproduces the production failure: auth queries 42703 without token_version', async () => {
    await scratch`ALTER TABLE users DROP COLUMN token_version`;

    // This is what registration and getAuthUser both do.
    await expect(
      scratch`SELECT token_version FROM users LIMIT 1`,
    ).rejects.toMatchObject({ code: '42703' });
  });

  it('is not caught by the empty-database check, because the database is not empty', async () => {
    await scratch`ALTER TABLE users DROP COLUMN token_version`;

    // The old gate looked only at whether accounts existed. They did — they
    // just could not be used — so the window stayed shut and the fix stayed
    // unreachable.
    await expect(isUninitializedDatabase(scratch)).resolves.toBe(false);
  });

  it('opens the bootstrap window instead of leaving production locked out', async () => {
    await scratch`ALTER TABLE users DROP COLUMN token_version`;

    await expect(isAuthBlockedBySchema(scratch)).resolves.toBe(true);
    await expect(isBootstrapAllowed(scratch)).resolves.toBe(true);
  });

  it('shuts the window again once the column is restored', async () => {
    await scratch`ALTER TABLE users DROP COLUMN token_version`;
    expect(await isBootstrapAllowed(scratch)).toBe(true);

    await scratch`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0`;

    expect(await isAuthBlockedBySchema(scratch)).toBe(false);
    expect(await isBootstrapAllowed(scratch)).toBe(false);
  });
});

describe('isAuthBlockedBySchema', () => {
  it('opens for every column the auth path depends on, not just one', async () => {
    for (const column of AUTH_CRITICAL_USER_COLUMNS) {
      await seedLiveDatabase();
      await scratch.unsafe(`ALTER TABLE users DROP COLUMN "${column}"`);
      await expect(isAuthBlockedBySchema(scratch)).resolves.toBe(true);
    }
  });

  it('stays shut on a healthy live database', async () => {
    await expect(isAuthBlockedBySchema(scratch)).resolves.toBe(false);
    await expect(isBootstrapAllowed(scratch)).resolves.toBe(false);
  });

  it('is not the answer for a database with no users table at all', async () => {
    // That state is isUninitializedDatabase's; keeping them distinct means a
    // missing table is never mistaken for a missing column.
    await scratch`DROP TABLE users CASCADE`;
    await expect(isAuthBlockedBySchema(scratch)).resolves.toBe(false);
    await expect(isUninitializedDatabase(scratch)).resolves.toBe(true);
    await expect(isBootstrapAllowed(scratch)).resolves.toBe(true);
  });

  it('fails closed when the catalogue cannot be read', async () => {
    const broken = connect('postgres://nobody:nobody@127.0.0.1:1/nope?sslmode=disable');
    await expect(isAuthBlockedBySchema(broken)).resolves.toBe(false);
    await expect(isBootstrapAllowed(broken)).resolves.toBe(false);
    await broken.end();
  });

  it('leaves an empty but well-formed database to the original check', async () => {
    await scratch`DELETE FROM users`;
    await expect(isAuthBlockedBySchema(scratch)).resolves.toBe(false);
    await expect(isUninitializedDatabase(scratch)).resolves.toBe(true);
    await expect(isBootstrapAllowed(scratch)).resolves.toBe(true);
  });
});

describe('the declared column list cannot drift from what auth reads', () => {
  it('names every users column lib/auth.ts selects', async () => {
    const source = await (await import('node:fs/promises')).readFile('lib/auth.ts', 'utf8');

    // Every `SELECT <cols> FROM users` in the auth path. If a future change
    // reads a column that is not declared auth-critical, the bootstrap window
    // will not open for it and this fails instead of production.
    const selects = [...source.matchAll(/SELECT\s+([\s\S]{1,200}?)\s+FROM\s+users\b/gi)];
    expect(selects.length).toBeGreaterThan(0);

    const ignored = new Set(['id', '*', 'kyc_status', 'locked_until', 'failed_login_attempts']);
    const read = new Set<string>();
    for (const [, cols] of selects) {
      for (const raw of cols.split(',')) {
        const col = raw.trim().replace(/^.*\s+as\s+/i, '').replace(/[^a-z_]/gi, '');
        if (col && !ignored.has(col)) read.add(col);
      }
    }

    for (const col of read) {
      expect(
        [...AUTH_CRITICAL_USER_COLUMNS].includes(col as never) || ignored.has(col),
      ).toBe(true);
    }
  });

  it('declares columns that actually exist on the users table', async () => {
    const rows = await scratch<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    const have = new Set(rows.map((r) => r.column_name));
    for (const col of AUTH_CRITICAL_USER_COLUMNS) {
      expect(have.has(col)).toBe(true);
    }
  });
});
