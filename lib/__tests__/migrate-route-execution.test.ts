/**
 * Does GET /api/migrate actually run?
 *
 * This route is the only mechanism by which the production schema changes. Its
 * SQL was executed nowhere in the suite:
 *
 *   - migrate-route-anonymous-path.test.ts mocks `@/lib/db` wholesale, on
 *     purpose — it tests the handler's control flow, not its statements.
 *   - schema-source-parity.test.ts parses the file with regular expressions.
 *   - correlation-id-schema.test.ts runs initializeSchema(), not the route.
 *
 * So nothing executed roughly 66 ALTER and 17 CREATE TABLE statements that
 * production depends on. Measured, before this file existed: changing one
 * statement to `ADD COLUM` — a plausible typo, and valid TypeScript — left
 * typecheck clean, lint clean and all 735 tests passing. The failure would
 * have surfaced only when an operator ran /api/migrate against production,
 * which is the worst available place to discover it. CLAUDE.md already records
 * five separate incidents centred on this one file.
 *
 * These tests run the real handler with the real database layer. Only the admin
 * resolver is stubbed, to supply the operations role the route now requires;
 * `@/lib/db` is deliberately NOT mocked, because mocking it is what left the
 * gap.
 *
 * It runs against the shared test database rather than a scratch one. That is
 * deliberate twice over: getSql() memoises the first DATABASE_URL it sees, so a
 * scratch database would need module-registry gymnastics; and a populated
 * database is the realistic case, since production is populated. Every
 * statement in the route is additive and idempotent — that contract is exactly
 * what is being asserted, so exercising it here is the test, not a risk to it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { getSql } from '@/lib/db';

const MIGRATE_ROUTE = path.join(process.cwd(), 'app/api/migrate/route.ts');
const VERIFY_SCRIPT = path.join(process.cwd(), 'scripts/verify-migrate.sql');

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

// The operations role the route requires. Authorization itself is covered by
// lib/__tests__/migrate-route-anonymous-path.test.ts; this file is about the
// statements that run once authorization passes.
vi.mock('@/lib/rbac/admin-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rbac/admin-middleware')>();
  return {
    ...actual,
    resolveAdminBySessionId: async () => ({
      id: 9901,
      email: 'migration-operator@example.test',
      name: 'Migration Operator',
      role: 'SuperAdmin',
      status: 'active',
      failed_login_attempts: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
  };
});

const sql = getSql();
const source = readFileSync(MIGRATE_ROUTE, 'utf8');

/**
 * The objects application code reads unguarded, curated in
 * scripts/verify-migrate.sql as part of the schema-change rule.
 *
 * This is the cross-check the two parsed sets below cannot provide. Those are
 * derived from the route's own source, so deleting a statement also deletes its
 * own expectation.
 *
 * It is asserted STATICALLY, against the route's text, and that is not a
 * stylistic choice. Checking the database cannot detect a removal here:
 * test-schema.sql and initializeSchema() both create these same tables, so the
 * catalogue holds them whether or not the route still does. Measured — with a
 * database assertion, deleting the `webhook_dead_letters` CREATE passed all
 * seven cases. Only comparing the route's declarations against a list
 * maintained outside it catches that.
 */
const requiredByApplication = [
  ...new Set(
    [
      ...readFileSync(VERIFY_SCRIPT, 'utf8')
        .split('── 2.')[0]
        .matchAll(/\('(\w+)'\)/g),
    ].map((m) => m[1]),
  ),
];

/** Every table the route creates. */
const guaranteedTables = [
  ...new Set([...source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])),
];

/** Every column it adds, as `table.column`. */
const guaranteedColumns = [
  ...new Set(
    [...source.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    ),
  ),
];

interface MigrateBody {
  success?: boolean;
  error?: string;
  message?: string;
  warnings?: string[];
  moneyColumnsUpgraded?: string[];
}

async function runMigration(): Promise<{ status: number; body: MigrateBody }> {
  const { GET } = await import('@/app/api/migrate/route');
  const { NextRequest } = await import('next/server');
  const req = new NextRequest('https://manna.example.test/api/migrate', {
    headers: { authorization: 'Bearer operations-session' },
  });
  const res = await GET(req);
  return { status: res.status, body: (await res.json()) as MigrateBody };
}

beforeAll(async () => {
  // Guard the parse. If a refactor changed how the route issues DDL, the
  // regexes would match nothing and the coverage assertions below would pass
  // against empty lists — green, proving nothing.
  expect(guaranteedTables.length).toBeGreaterThan(10);
  expect(guaranteedColumns.length).toBeGreaterThan(40);
  expect(requiredByApplication.length).toBeGreaterThan(5);
}, 60000);

afterAll(async () => {
  await sql`DELETE FROM audit_logs WHERE action = 'schema_migration_run'`.catch(() => undefined);
}, 60000);

describe('GET /api/migrate executes its statements', () => {
  it('runs every statement without error', async () => {
    // The assertion the ADD COLUM typo fails. A 500 here means some statement
    // in the route is malformed, out of dependency order, or invalid against a
    // populated database — all of which were previously invisible until an
    // operator ran this against production.
    const { status, body } = await runMigration();

    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  }, 120000);

  it('reports no warnings, so the conditional indexes were created', async () => {
    // The route reports rather than fails when duplicate rows block
    // velocity_checks_window_key or fx_rates_pair_key. A "successful" migration
    // carrying either warning leaves recordVelocity()'s or getFxRate()'s upsert
    // still broken, because each names its index as the ON CONFLICT arbiter.
    const { body } = await runMigration();

    expect(body.warnings ?? []).toEqual([]);
  }, 120000);

  it('is idempotent: a second and third run behave identically', async () => {
    // CLAUDE.md promises every statement is additive and idempotent, and the
    // operational instruction is to call this endpoint after each deploy. A
    // statement that succeeds once and fails on re-run would break that.
    const second = await runMigration();
    const third = await runMigration();

    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(third.body.success).toBe(true);
    // Money conversion must not re-trigger: the columns are already NUMERIC, so
    // a repeat upgrade would mean the detector is misreading their type.
    expect(third.body.moneyColumnsUpgraded ?? []).toEqual([]);
  }, 180000);

  it('leaves every table it declares actually present', async () => {
    // Parsing proves the statement is written; only executing proves it worked.
    await runMigration();

    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const present = new Set(rows.map((r) => r.table_name));
    const missing = guaranteedTables.filter((t) => !present.has(t));

    expect(missing).toEqual([]);
  }, 120000);

  it('leaves every column it declares actually present', async () => {
    await runMigration();

    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns WHERE table_schema = 'public'
    `;
    const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const missing = guaranteedColumns.filter((key) => !present.has(key));

    expect(missing).toEqual([]);
  }, 120000);

  it('still declares every object application code reads unguarded', () => {
    // Static, for the reason given at requiredByApplication: a database check
    // is masked by the fixture and by initializeSchema(), both of which create
    // these tables independently. These are the objects whose absence from the
    // production migration path makes application code raise 42703 or 42P01 at
    // runtime — velocity_checks for every send, fx_rates for every cross-border
    // quote, plaid_transfer_event_cursors for the Plaid Transfer webhook.
    const created = new Set(guaranteedTables);
    const missing = requiredByApplication.filter((t) => !created.has(t));

    expect(missing).toEqual([]);
  });

  it('records the run in audit_logs, so an operator action is traceable', async () => {
    await runMigration();

    const rows = await sql`
      SELECT 1 FROM audit_logs WHERE action = 'schema_migration_run' LIMIT 1
    `;
    expect(rows).toHaveLength(1);
  }, 120000);
});
