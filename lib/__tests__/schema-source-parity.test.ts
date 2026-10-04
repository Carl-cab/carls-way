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

interface GuaranteedColumn {
  table: string;
  column: string;
  /** The type as the migrate route writes it, e.g. `NUMERIC(14,2)`. */
  declared: string;
}

/** Every column `app/api/migrate/route.ts` guarantees, with its declared type. */
const guaranteedColumns: GuaranteedColumn[] = [
  ...source.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)\s+([^`]+?)\s*`/g),
].map((m) => ({ table: m[1], column: m[2], declared: m[3] }));

/** Every table it creates. */
const guaranteedTables: string[] = [
  ...new Set([...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])),
];

/**
 * The shape information_schema reports for a declared type.
 *
 * Only the leading type is read; constraint clauses (NOT NULL, DEFAULT,
 * REFERENCES) are deliberately ignored, since this compares storage and not
 * constraints.
 *
 * An unrecognised type THROWS rather than returning null. Skipping it would
 * mean a type this does not understand silently passes, which is the failure
 * mode that let the earlier drift through: an unchecked case reading as clean.
 */
function expectedShape(declared: string): {
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  character_maximum_length: number | null;
} {
  const head = declared.trim().match(/^([A-Za-z ]+?)(?:\s*\((\d+)(?:\s*,\s*(\d+))?\))?(?:\s|$)/);
  if (!head) throw new Error(`Could not parse a type from: ${declared}`);

  const base = head[1].trim().toUpperCase();
  const a = head[2] ? Number(head[2]) : null;
  const b = head[3] ? Number(head[3]) : null;

  switch (base) {
    case 'TEXT':
      return { data_type: 'text', numeric_precision: null, numeric_scale: null, character_maximum_length: null };
    case 'BOOLEAN':
      return { data_type: 'boolean', numeric_precision: null, numeric_scale: null, character_maximum_length: null };
    case 'INTEGER':
      // PostgreSQL reports integer precision as 32; it is not a declared width.
      return { data_type: 'integer', numeric_precision: 32, numeric_scale: 0, character_maximum_length: null };
    case 'TIMESTAMPTZ':
      return {
        data_type: 'timestamp with time zone',
        numeric_precision: null,
        numeric_scale: null,
        character_maximum_length: null,
      };
    case 'JSONB':
      return { data_type: 'jsonb', numeric_precision: null, numeric_scale: null, character_maximum_length: null };
    case 'NUMERIC':
      return { data_type: 'numeric', numeric_precision: a, numeric_scale: b, character_maximum_length: null };
    case 'VARCHAR':
      return {
        data_type: 'character varying',
        numeric_precision: null,
        numeric_scale: null,
        character_maximum_length: a,
      };
    default:
      throw new Error(
        `expectedShape() does not know the type ${base} (from "${declared}"). ` +
          'Add it rather than letting an unchecked type pass as correct.',
      );
  }
}

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
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !present.has(key));

    // Named rather than counted, so a failure says which object to add.
    expect(missing).toEqual([]);
  });

  it('gives each of those columns the same type the migrate route declares', async () => {
    // Presence is not enough. transactions.sender_amount existed in both
    // sources as NUMERIC while production sat at NUMERIC(12,2) and the sources
    // said (14,2) — a capacity difference the presence check above passes
    // straight through. ADD COLUMN IF NOT EXISTS never alters an existing
    // column's type, so nothing in either source corrects such a mismatch;
    // only a dedicated migration does. This is the check that notices.
    const rows = await scratch!<
      {
        table_name: string;
        column_name: string;
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
        character_maximum_length: number | null;
      }[]
    >`
      SELECT table_name, column_name, data_type,
             numeric_precision, numeric_scale, character_maximum_length
      FROM information_schema.columns WHERE table_schema = 'public'
    `;
    const actual = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));

    const mismatches: string[] = [];
    for (const { table, column, declared } of guaranteedColumns) {
      const key = `${table}.${column}`;
      const live = actual.get(key);
      // Absence is the previous case's failure, not this one's.
      if (!live) continue;

      const want = expectedShape(declared);
      const differs =
        live.data_type !== want.data_type ||
        live.numeric_precision !== want.numeric_precision ||
        live.numeric_scale !== want.numeric_scale ||
        live.character_maximum_length !== want.character_maximum_length;

      if (differs) {
        const show = (t: {
          data_type: string;
          numeric_precision: number | null;
          numeric_scale: number | null;
          character_maximum_length: number | null;
        }) =>
          t.data_type === 'numeric'
            ? `numeric(${t.numeric_precision},${t.numeric_scale})`
            : t.character_maximum_length !== null
              ? `${t.data_type}(${t.character_maximum_length})`
              : t.data_type;
        mismatches.push(`${key}: lib/db.ts gives ${show(live)}, migrate route declares ${show(want)}`);
      }
    }

    expect(mismatches).toEqual([]);
  });
});
