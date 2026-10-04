/**
 * Parity between the two schema sources.
 *
 * CLAUDE.md requires every schema object to exist in both lib/db.ts
 * (initializeSchema(), which every cold start and test database runs) and
 * app/api/migrate/route.ts (which the live database is migrated from). Five
 * separate violations of that rule were found by hand in one session —
 * users.token_version, the C1.4 dead-letter set, correlation_id on four
 * tables, six fixture tables, and finally 21 columns plus the whole admin
 * RBAC surface. Each was found only after something broke or someone looked.
 *
 * So this stops asserting individual objects and asserts the rule itself: the
 * migrate route is parsed for everything it guarantees, and every one of those
 * objects must exist on a database built by initializeSchema() alone.
 *
 * Direction matters and only one direction is checked. The migrate route is
 * the authority on what the live database has, so anything it creates must
 * also reach a fresh environment. The reverse is not a defect: initializeSchema()
 * may legitimately create something the route has since folded in elsewhere.
 *
 * Parsing source rather than listing objects by hand is deliberate — a
 * hand-maintained list is one more thing that drifts, and it would have to be
 * updated by the same change that introduces a gap.
 */
import { readFileSync } from 'fs';
import path from 'path';
import postgres from 'postgres';
import { initializeSchema, resolveSslMode } from '../db';

const SCRATCH_DB = 'manna_schema_parity_test';
const MIGRATE_ROUTE = path.join(process.cwd(), 'app/api/migrate/route.ts');

const baseUrl = process.env.DATABASE_URL!;
const scratchUrl = new URL(baseUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;

let admin: ReturnType<typeof postgres>;
let scratch: ReturnType<typeof postgres> | null = null;

function connect(url: string) {
  return postgres(url, { ssl: resolveSslMode(url), max: 1, onnotice: () => {} });
}

const source = readFileSync(MIGRATE_ROUTE, 'utf8');

/** Every column `app/api/migrate/route.ts` guarantees, as [table, column]. */
const guaranteedColumns: [string, string][] = [
  ...source.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g),
].map((m) => [m[1], m[2]]);

/** Every table it creates. */
const guaranteedTables: string[] = [
  ...new Set([...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])),
];

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = connect(adminUrl.toString());
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  scratch = connect(scratchUrl.toString());

  // The whole point: what initializeSchema() produces unaided, with neither
  // the migrate route nor the test fixture involved.
  await initializeSchema(scratch);
}, 120000);

afterAll(async () => {
  if (scratch) await scratch.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
}, 60000);

describe('lib/db.ts covers everything app/api/migrate/route.ts guarantees', () => {
  it('parsed a plausible number of objects from the migrate route', () => {
    // Guards the parse itself. If a refactor changed how the route issues DDL
    // the regexes would quietly match nothing, and every assertion below would
    // pass against an empty list — a green test proving nothing.
    expect(guaranteedTables.length).toBeGreaterThan(10);
    expect(guaranteedColumns.length).toBeGreaterThan(40);
  });

  it('creates every table the migrate route creates', async () => {
    const rows = await scratch!<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const present = new Set(rows.map((r) => r.table_name));
    const missing = guaranteedTables.filter((t) => !present.has(t));

    // Named rather than counted, so a failure says which object to add.
    expect(missing).toEqual([]);
  });

  it('creates every column the migrate route adds', async () => {
    const rows = await scratch!<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns WHERE table_schema = 'public'
    `;
    const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = guaranteedColumns
      .map(([t, c]) => `${t}.${c}`)
      .filter((key) => !present.has(key));

    expect(missing).toEqual([]);
  });
});
