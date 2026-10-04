/**
 * Correlation id columns, across every table that is filtered on one.
 *
 * Milestone 2 threads a single correlation id through a financial event's
 * whole lifecycle so an operator can trace an intent to its webhooks to its
 * ledger rows. Four admin services issue `WHERE correlation_id = ...`:
 * AdminTransferService (transfer_intents), AdminProviderEventService and
 * AdminWebhookService (provider_webhook_events), and AdminSettlementService
 * (transactions).
 *
 * The columns were declared only in app/api/migrate/route.ts, so a fresh
 * environment — which comes up through initializeSchema() — had none of them.
 * transactions.correlation_id was in no schema source at all, so the
 * settlement trace endpoints raised 42703 on every database including
 * production.
 *
 * Asserting the column exists is not enough on its own: the migrate route had
 * three of the four and the one it missed was still reachable. So this runs
 * the actual filter each service issues, against a database built the way a
 * fresh deployment builds one. A query is the only assertion that cannot pass
 * while the endpoint is broken.
 *
 * Uses its own scratch database rather than the shared test one: the point is
 * what initializeSchema() produces unaided, and the shared database has been
 * through the fixture.
 */
import postgres from 'postgres';
import { initializeSchema, resolveSslMode } from '../db';

const SCRATCH_DB = 'manna_correlation_test';

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

  // Build the schema the way a fresh deployment does — through the library,
  // against this empty database, with the test fixture nowhere in it.
  await initializeSchema(scratch);
}, 120000);

afterAll(async () => {
  if (scratch) await scratch.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
}, 60000);

const FILTERED_TABLES = [
  ['transfer_intents', 'AdminTransferService'],
  ['provider_webhook_events', 'AdminProviderEventService / AdminWebhookService'],
  ['ledger_entries', 'settlement tracing'],
  ['transactions', 'AdminSettlementService'],
] as const;

describe('correlation_id on a database built by initializeSchema()', () => {
  it.each(FILTERED_TABLES)('%s carries correlation_id (%s filters on it)', async (table) => {
    const rows = await scratch!`
      SELECT data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = 'correlation_id'
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('character varying');
    expect(rows[0].character_maximum_length).toBe(255);
  });

  it.each(FILTERED_TABLES)('the correlation filter against %s executes', async (table) => {
    // The real shape each admin service issues. Without the column this
    // raises 42703 rather than returning no rows, which is exactly how the
    // settlement trace endpoints failed.
    const rows = await scratch!.unsafe(
      `SELECT * FROM ${table} WHERE correlation_id = $1`,
      ['corr_absent'],
    );
    expect(rows).toEqual([]);
  });

  it('keeps the column nullable, so existing rows survive the ALTER', async () => {
    // Backfilling is out of scope: rows written before Milestone 2 have no
    // correlation id and a NOT NULL would have failed the migration outright
    // on any non-empty production table.
    const rows = await scratch!`
      SELECT table_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'correlation_id'
      ORDER BY table_name
    `;

    expect(rows.length).toBeGreaterThanOrEqual(FILTERED_TABLES.length);
    for (const row of rows) {
      expect(row.is_nullable).toBe('YES');
    }
  });
});
