/**
 * The CI fixture must hold every column the application reads.
 *
 * THE MISSING DIRECTION. The repository had two schema-parity guards and this
 * is the third:
 *
 *   - `schema-source-parity.test.ts` — migrate route ⊆ initializeSchema()
 *   - `migrate-route-execution.test.ts` — the route's statements really run
 *   - this file — initializeSchema() ∪ migrate route ⊆ the CI fixture
 *
 * Nothing checked the fixture against anything, so the fixture was free to
 * drift from both authoritative sources. It had, and the suite could not say
 * so: a column missing only from the fixture makes a route fail at runtime
 * while every test that does not call that route stays green.
 *
 * WHAT THAT COST, found in one sitting by booting the application against a
 * fixture-built database and using it:
 *
 *   - `users.province` → `POST /api/auth/register` 500 (42703). Registration
 *     is the first step of every workflow, so nobody could sign up.
 *   - `users.balance` → `GET /api/me` 500. The legacy column; `/api/me`
 *     selects it, and `MONEY_COLUMNS` and `verify-migrate.sql` both require it.
 *   - `transactions.estimated_settlement` → `GET /api/feed` 500.
 *   - `transactions.fx_rate` → `POST /api/transactions` 500, i.e. sending
 *     money at all.
 *   - six KYC and account-lockout columns, which made those routes untestable
 *     here rather than broken.
 *
 * Four user-visible 500s in the primary workflows, with 977 tests passing.
 *
 * WHY THIS COMPARES AGAINST BOTH SOURCES AND NOT JUST ONE. `province` and
 * `balance` live only in `initializeSchema()`'s CREATE TABLE bodies;
 * `estimated_settlement` and `fx_rate` are in both. Checking the fixture
 * against the migrate route alone would have missed the first two — which is
 * the same one-directional mistake that let this happen.
 *
 * Real PostgreSQL. The fixture is a SQL file and the subject is what a server
 * actually creates from it, including every ALTER further down the file. A
 * parse of the text would have its own blind spots, which is the whole problem
 * being fixed.
 */

import { readFileSync } from 'fs';
import path from 'path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema, resolveSslMode } from '../db';

const FIXTURE_DB = 'manna_fixture_parity_fixture';
const CANON_DB = 'manna_fixture_parity_canonical';
const FIXTURE = path.join(process.cwd(), 'lib/__tests__/helpers/test-schema.sql');
const MIGRATE_ROUTE = path.join(process.cwd(), 'app/api/migrate/route.ts');

const baseUrl = process.env.DATABASE_URL!;

function urlFor(db: string) {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

function connect(url: string) {
  return postgres(url, { ssl: resolveSslMode(url), max: 1, onnotice: () => {} });
}

let admin: ReturnType<typeof postgres>;
let fixture: ReturnType<typeof postgres> | null = null;
let canonical: ReturnType<typeof postgres> | null = null;

/**
 * Columns the migrate route adds by ALTER. Same regex as
 * `schema-source-parity.test.ts`, deliberately: if a refactor breaks the parse
 * both files should go quiet together and the guard below catches it, rather
 * than the two drifting into disagreement about what the route says.
 */
const routeColumns = [
  ...readFileSync(MIGRATE_ROUTE, 'utf8').matchAll(
    /ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)\s+([^`]+?)\s*`/g,
  ),
].map((m) => ({ table: m[1], column: m[2] }));

/**
 * Tables the fixture is not expected to carry.
 *
 * `schema_migrations` is created by the migration-tracking code itself, and
 * `migration-versioning.test.ts` builds its own disposable database for it. A
 * fixture copy would be a fourth source of that table.
 */
const NOT_IN_FIXTURE = new Set<string>(['schema_migrations']);

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = connect(adminUrl.toString());

  for (const db of [FIXTURE_DB, CANON_DB]) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
    await admin.unsafe(`CREATE DATABASE ${db}`);
  }

  // Disposable databases, per CLAUDE.md: this file creates and drops schema,
  // and vitest runs files in parallel, so touching the shared database would
  // be a race rather than an ordering problem.
  fixture = connect(urlFor(FIXTURE_DB));
  canonical = connect(urlFor(CANON_DB));

  // The fixture exactly as CI applies it, statements in file order.
  await fixture.unsafe(readFileSync(FIXTURE, 'utf8'));

  // The canonical schema: what initializeSchema() builds unaided. The migrate
  // route's ALTERs are read from source rather than executed, because the
  // route needs an authenticated request; `migrate-route-execution.test.ts`
  // already proves those statements run.
  await initializeSchema(canonical);
}, 180000);

afterAll(async () => {
  if (fixture) await fixture.end();
  if (canonical) await canonical.end();
  for (const db of [FIXTURE_DB, CANON_DB]) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
  }
  await admin.end();
}, 60000);

async function columnsOf(sql: ReturnType<typeof postgres>) {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns WHERE table_schema = 'public'
  `;
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

async function tablesOf(sql: ReturnType<typeof postgres>) {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `;
  return new Set(rows.map((r) => r.table_name));
}

describe('the CI fixture covers the authoritative schema sources', () => {
  it('both databases were actually built', async () => {
    // Guards the setup. Without this, a fixture that failed to apply would
    // leave an empty database, every set difference below would be computed
    // against nothing, and the file would pass while proving the opposite.
    const f = await tablesOf(fixture!);
    const c = await tablesOf(canonical!);
    expect(f.size).toBeGreaterThan(15);
    expect(c.size).toBeGreaterThan(15);
    expect(routeColumns.length).toBeGreaterThan(40);
  });

  it('has every table initializeSchema() creates', async () => {
    const f = await tablesOf(fixture!);
    const c = await tablesOf(canonical!);
    const missing = [...c].filter((t) => !f.has(t) && !NOT_IN_FIXTURE.has(t)).sort();

    expect(
      missing,
      `the fixture is missing ${missing.length} table(s) that ` +
        `initializeSchema() creates: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has every column initializeSchema() declares', async () => {
    const f = await columnsOf(fixture!);
    const c = await columnsOf(canonical!);
    const missing = [...c]
      .filter((k) => !f.has(k) && !NOT_IN_FIXTURE.has(k.split('.')[0]))
      .sort();

    // This is the assertion that would have caught `users.province` and
    // `users.balance` — both declared only inside a CREATE TABLE body, where
    // the other two guards cannot see them.
    expect(
      missing,
      `the fixture is missing ${missing.length} column(s) that ` +
        `initializeSchema() declares: ${missing.join(', ')}. Add each to ` +
        `lib/__tests__/helpers/test-schema.sql. A column missing only here ` +
        `makes a route answer 500 at runtime while the suite stays green.`,
    ).toEqual([]);
  });

  it('has every column the migrate route guarantees', async () => {
    const f = await columnsOf(fixture!);
    const missing = routeColumns
      .map((c) => `${c.table}.${c.column}`)
      .filter((k) => !f.has(k) && !NOT_IN_FIXTURE.has(k.split('.')[0]))
      .filter((k, i, a) => a.indexOf(k) === i)
      .sort();

    // The migrate route is the authority on what the live database holds, so a
    // column here and not in the fixture means CI tests against a schema
    // production does not have — the drift that can hide a real failure or
    // manufacture a fake one.
    expect(
      missing,
      `the fixture is missing ${missing.length} column(s) the migrate route ` +
        `guarantees: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
