/**
 * What an unauthenticated caller may cause on a POPULATED database.
 *
 * /api/migrate opens an anonymous window when nobody could present a cookie,
 * because requiring one would put the fix out of reach. Two states qualified
 * and both got the same thing — the full migration pipeline:
 *
 *   - `users` absent or empty. No account, no customer data.
 *   - `users` populated but missing a column the auth path reads. A LIVE
 *     database. This is the state a deploy leaves behind when its migration has
 *     not run, and how users.token_version locked production out of login.
 *
 * The second has rows in it, so every ALTER in the pipeline — and until
 * recently a money-column type conversion that rewrites a balance table — was
 * anonymously reachable against live data. The recorded justification, that the
 * worst case was "the empty schema that deployment was about to create anyway",
 * was untrue of it.
 *
 * The assertion that matters here is a NEGATIVE one: on the repair path the
 * rest of the pipeline must not run. A test that only checked the auth columns
 * came back would pass just as well while the whole pipeline still executed,
 * which is precisely the defect. So these use a database that is populated and
 * missing auth columns AND missing objects the pipeline would otherwise create,
 * then assert those objects are still missing afterwards.
 */
import postgres from 'postgres';
import {
  AUTH_CRITICAL_USER_COLUMNS,
  anonymousRecoveryMode,
  initializeSchema,
  repairAuthCriticalColumns,
  resolveSslMode,
} from '../db';

const SCRATCH_DB = 'manna_anon_repair_test';

const baseUrl = process.env.DATABASE_URL!;
const scratchUrl = new URL(baseUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;

let admin: ReturnType<typeof postgres>;
let scratch: ReturnType<typeof postgres> | null = null;

function connect(url: string) {
  return postgres(url, { ssl: resolveSslMode(url), max: 1, onnotice: () => {} });
}

async function columnsOfUsers(): Promise<Set<string>> {
  const rows = await scratch!<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
  `;
  return new Set(rows.map((r) => r.column_name));
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await scratch!<{ exists: boolean }[]>`
    SELECT to_regclass(${'public.' + table}) IS NOT NULL AS exists
  `;
  return rows[0].exists === true;
}

/**
 * A live database stranded mid-deploy: it has a user, it is missing the auth
 * columns, and it is missing tables the pipeline would create. That last part
 * is what makes the negative assertion observable.
 */
async function strandLiveDatabase(): Promise<void> {
  await scratch!`DROP TABLE IF EXISTS users CASCADE`;
  await scratch!.unsafe(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT 'CA',
      balance_cad NUMERIC(14,2) NOT NULL DEFAULT 0,
      balance_usd NUMERIC(14,2) NOT NULL DEFAULT 0
    )
  `);
  await scratch!`
    INSERT INTO users (name, username, email, password_hash, country)
    VALUES ('Existing Customer', 'existing', 'existing@example.test', 'hash', 'CA')
  `;
  // Drop one auth-critical column; token_version was never added above.
  await scratch!`DROP TABLE IF EXISTS fx_rates`;
  await scratch!`DROP TABLE IF EXISTS velocity_checks CASCADE`;
}

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = connect(adminUrl.toString());
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  scratch = connect(scratchUrl.toString());
}, 120000);

afterAll(async () => {
  if (scratch) await scratch.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
}, 60000);

describe('anonymousRecoveryMode distinguishes the two states', () => {
  it('calls a populated database missing auth columns an auth-repair', async () => {
    await strandLiveDatabase();
    await expect(anonymousRecoveryMode(scratch!)).resolves.toBe('auth-repair');
  }, 60000);

  it('calls a populated, healthy database no recovery at all', async () => {
    await strandLiveDatabase();
    await repairAuthCriticalColumns(scratch!);
    await expect(anonymousRecoveryMode(scratch!)).resolves.toBe(null);
  }, 60000);
});

describe('repairAuthCriticalColumns is a fixed, minimal allowlist', () => {
  it('restores exactly the auth-critical columns', async () => {
    await strandLiveDatabase();

    const added = await repairAuthCriticalColumns(scratch!);

    expect(added).toEqual(['token_version']);
    const cols = await columnsOfUsers();
    for (const c of AUTH_CRITICAL_USER_COLUMNS) {
      expect(cols.has(c)).toBe(true);
    }
  }, 60000);

  it('does NOT run the rest of the pipeline', async () => {
    // The whole point. Checking only that the auth columns returned would pass
    // equally well while the full pipeline still executed.
    await strandLiveDatabase();
    expect(await tableExists('fx_rates')).toBe(false);
    expect(await tableExists('velocity_checks')).toBe(false);

    await repairAuthCriticalColumns(scratch!);

    expect(await tableExists('fx_rates')).toBe(false);
    expect(await tableExists('velocity_checks')).toBe(false);
  }, 60000);

  it('adds no column beyond the allowlist', async () => {
    await strandLiveDatabase();
    const before = await columnsOfUsers();

    await repairAuthCriticalColumns(scratch!);

    const after = await columnsOfUsers();
    const introduced = [...after].filter((c) => !before.has(c)).sort();
    expect(introduced).toEqual(['token_version']);
  }, 60000);

  it('covers every AUTH_CRITICAL_USER_COLUMNS entry', async () => {
    // The allowlist is written out statement by statement rather than looped,
    // so adding a third entry to AUTH_CRITICAL_USER_COLUMNS without a matching
    // statement would leave the repair unable to fix the state it exists for.
    // This fails loudly if the two ever drift.
    for (const column of AUTH_CRITICAL_USER_COLUMNS) {
      await strandLiveDatabase();
      const cols = await columnsOfUsers();
      if (cols.has(column)) await scratch!.unsafe(`ALTER TABLE users DROP COLUMN "${column}"`);

      await repairAuthCriticalColumns(scratch!);

      expect((await columnsOfUsers()).has(column)).toBe(true);
    }
  }, 120000);

  it('is idempotent', async () => {
    await strandLiveDatabase();
    await repairAuthCriticalColumns(scratch!);

    await expect(repairAuthCriticalColumns(scratch!)).resolves.toEqual([]);
  }, 60000);

  it('leaves existing rows in place', async () => {
    await strandLiveDatabase();
    await repairAuthCriticalColumns(scratch!);

    const rows = await scratch!<{ username: string; password_hash: string }[]>`
      SELECT username, password_hash FROM users
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('existing');
    // A repair must not clear a credential it did not set.
    expect(rows[0].password_hash).toBe('hash');
  }, 60000);

  it('adds password_hash NULLable, since NOT NULL would fail on a populated table', async () => {
    await strandLiveDatabase();
    await scratch!`ALTER TABLE users DROP COLUMN password_hash`;

    // The repair must complete here. A NOT NULL column with no default against
    // an existing row raises 23502 and the repair path would be unusable.
    await expect(repairAuthCriticalColumns(scratch!)).resolves.toContain('password_hash');

    const rows = await scratch!<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_hash'
    `;
    expect(rows[0].is_nullable).toBe('YES');
  }, 60000);

  it('still lets the authenticated full migration run afterwards', async () => {
    // The repair is a step toward the pipeline, not a replacement for it: an
    // operator logs in and runs the full migration, which must still work.
    await strandLiveDatabase();
    await repairAuthCriticalColumns(scratch!);

    await initializeSchema(scratch!);

    expect(await tableExists('fx_rates')).toBe(true);
    expect(await tableExists('velocity_checks')).toBe(true);
  }, 120000);
});
