import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getSql, initializeSchema } from '@/lib/db';
import { MIGRATIONS, fileChecksum, findMigration } from '@/lib/migrations/registry';
import {
  adoptBaseline,
  assertSafeToProceed,
  beginMigration,
  completeMigration,
  describeState,
  ensureMigrationTable,
  failMigration,
  readMigrationRecords,
  recordConvergenceRun,
  withMigrationLock,
} from '@/lib/migrations/tracking';
import type { MigrationSqlExecutor } from '@/lib/migrations/types';

/**
 * Migration versioning — decision 0005 Phase 2.
 *
 * Runs against real PostgreSQL throughout. Every property here is about what
 * the catalogue actually says or what a concurrent session actually observes,
 * and a mocked driver would be testing the mock: advisory locks, `ON CONFLICT`
 * behaviour and `information_schema` answers are the subject, not incidental.
 */

const sql = getSql();
const exec = sql as unknown as MigrationSqlExecutor;
const ROOT = process.cwd();

async function clearTracking() {
  await ensureMigrationTable(exec);
  await sql`DELETE FROM schema_migrations`;
}

/**
 * Run `fn` against a brand-new database that is dropped afterwards.
 *
 * Follows the pattern already in `migrate-route-security.test.ts`: a unique
 * name per invocation, so two runs sharing `DATABASE_URL` cannot destroy each
 * other's scratch database or a developer database that happens to match, and
 * it is only dropped if this call created it.
 */
async function withScratchDatabase(
  fn: (scratch: MigrationSqlExecutor) => Promise<void>,
): Promise<void> {
  const { resolveSslMode } = await import('@/lib/db');
  const postgres = (await import('postgres')).default;
  const { randomUUID } = await import('node:crypto');

  const base = new URL(process.env.DATABASE_URL!);
  const adminUrl = new URL(base.toString());
  adminUrl.pathname = '/postgres';
  const name = `manna_migration_versioning_${randomUUID().replaceAll('-', '')}`;
  const scratchUrl = new URL(base.toString());
  scratchUrl.pathname = `/${name}`;

  const connect = (u: string) =>
    postgres(u, { ssl: resolveSslMode(u), max: 1, onnotice: () => {} });

  const admin = connect(adminUrl.toString());
  let scratch: ReturnType<typeof postgres> | null = null;
  let created = false;

  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created = true;
    scratch = connect(scratchUrl.toString());

    const { initializeSchema } = await import('@/lib/db');
    await initializeSchema(scratch);

    await fn(scratch as unknown as MigrationSqlExecutor);
  } finally {
    if (scratch) await scratch.end();
    if (created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

describe('migration versioning', () => {
  beforeAll(async () => {
    await initializeSchema();
  });

  beforeEach(async () => {
    await clearTracking();
  });

  describe('the table is in every schema source', () => {
    it('exists on a database built by initializeSchema() alone', async () => {
      const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'schema_migrations'
        ) AS exists
      `;
      expect(rows[0].exists).toBe(true);
    });

    it('is named by the migrate route and the verifier, not only by lib/db.ts', async () => {
      // The three-source rule is enforced mechanically for the route by
      // schema-source-parity.test.ts. This asserts the two sources that test
      // does not cover, so a table added to lib/db.ts alone cannot pass.
      const { readFileSync } = await import('node:fs');
      expect(readFileSync('app/api/migrate/route.ts', 'utf8')).toContain(
        'CREATE TABLE IF NOT EXISTS schema_migrations',
      );
      expect(readFileSync('lib/__tests__/helpers/test-schema.sql', 'utf8')).toContain(
        'CREATE TABLE IF NOT EXISTS schema_migrations',
      );
      expect(readFileSync('scripts/verify-migrate.sql', 'utf8')).toContain(
        "('schema_migrations')",
      );
    });
  });

  describe('stable identifiers and checksums', () => {
    it('every registry migration names a file that exists and hashes', () => {
      for (const migration of MIGRATIONS) {
        const checksum = fileChecksum(ROOT, migration.file);
        expect(checksum, `${migration.id} -> ${migration.file}`).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('ids are unique and match their filenames, so a row can be traced to a file', () => {
      const ids = MIGRATIONS.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const migration of MIGRATIONS) {
        expect(migration.file).toBe(`migrations/${migration.id}.sql`);
      }
    });

    it('returns null rather than throwing for a file that is not there', () => {
      expect(fileChecksum(ROOT, 'migrations/does_not_exist.sql')).toBeNull();
    });

    it('refuses to record an id this repository cannot describe', async () => {
      await expect(
        beginMigration('20990101_invented', 'test', ROOT, exec),
      ).rejects.toThrow(/Unknown migration id/);
      expect(findMigration('20990101_invented')).toBeUndefined();
    });
  });

  describe('execution outcomes', () => {
    const id = MIGRATIONS[1].id;

    it('records partial BEFORE the work, so a crash leaves evidence', async () => {
      await beginMigration(id, 'operator:test', ROOT, exec);

      const row = (await readMigrationRecords(exec)).get(id);
      expect(row?.status).toBe('partial');
      expect(row?.startedAt).toBeInstanceOf(Date);
      expect(row?.finishedAt).toBeNull();
      // The checksum is captured at start, so the recorded hash is the file as
      // it stood when the run began rather than whatever it is later.
      expect(row?.checksum).toBe(fileChecksum(ROOT, MIGRATIONS[1].file));
    });

    it('completes with a duration', async () => {
      await beginMigration(id, 'operator:test', ROOT, exec);
      await completeMigration(id, exec);

      const row = (await readMigrationRecords(exec)).get(id);
      expect(row?.status).toBe('applied');
      expect(row?.finishedAt).toBeInstanceOf(Date);
      expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('records a failure as a reference, never the raw error', async () => {
      await beginMigration(id, 'operator:test', ROOT, exec);
      await failMigration(id, 'ref-abc123', exec);

      const row = (await readMigrationRecords(exec)).get(id);
      expect(row?.status).toBe('failed');
      expect(row?.errorReference).toBe('ref-abc123');
      // Nothing in the row should look like a postgres error message, which
      // can name tables, columns and constraints.
      expect(JSON.stringify(row)).not.toMatch(/ERROR:|relation .* does not exist/);
    });

    it('will not silently re-begin an applied migration', async () => {
      await beginMigration(id, 'operator:test', ROOT, exec);
      await completeMigration(id, exec);

      await expect(beginMigration(id, 'operator:test', ROOT, exec)).rejects.toThrow(
        /already applied/,
      );
    });

    it('will not silently re-begin a failed migration', async () => {
      await beginMigration(id, 'operator:test', ROOT, exec);
      await failMigration(id, 'ref-xyz', exec);

      await expect(beginMigration(id, 'operator:test', ROOT, exec)).rejects.toThrow(
        /is failed and blocks/,
      );
    });
  });

  describe('concurrency protection', () => {
    it('refuses a second holder rather than queueing behind it', async () => {
      // Each withMigrationLock reserves its own connection from the pool, so
      // the nested call is a genuinely different session and the session-level
      // lock excludes it. Without the reservation these two could share a
      // backend, the inner try-lock would succeed, and this would pass while
      // the real guarantee was absent.
      let innerRan = false;

      await withMigrationLock(async () => {
        await expect(
          withMigrationLock(async () => {
            innerRan = true;
          }),
        ).rejects.toThrow(/holds the advisory lock/);
      });

      expect(innerRan).toBe(false);
    });

    it('releases the lock even when the body throws', async () => {
      await expect(
        withMigrationLock(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // If the finally did not run, this second acquisition would fail.
      let reacquired = false;
      await withMigrationLock(async () => {
        reacquired = true;
      });
      expect(reacquired).toBe(true);
    });

    it('leaves no advisory lock behind, on success or on throw', async () => {
      // The defect this guards: a session-scoped lock taken on one pooled
      // connection and released on another leaks, blocking every later run
      // with no visible cause. Asserted against pg_locks rather than inferred
      // from a later acquisition succeeding, because a *different* pooled
      // connection would also succeed while the leak persisted.
      const held = async () => {
        const rows = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND objid = ${8123470015523001 % 2 ** 32}
        `;
        return rows[0].n;
      };

      await withMigrationLock(async (locked) => {
        // Inside, the lock exists on the reserved connection.
        const inside = await locked<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'
        `;
        expect(inside[0].n).toBeGreaterThan(0);
      });
      expect(await held()).toBe(0);

      await expect(
        withMigrationLock(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await held()).toBe(0);
    });

    it('serialises recording work done through the locked connection', async () => {
      const id = MIGRATIONS[0].id;
      await withMigrationLock(async (locked) => {
        await beginMigration(id, 'operator:locked', ROOT, locked);
        await completeMigration(id, locked);
      });

      const row = (await readMigrationRecords(exec)).get(id);
      expect(row?.status).toBe('applied');
      expect(row?.appliedBy).toBe('operator:locked');
    });
  });

  describe('baseline adoption of an existing database', () => {
    it('never writes applied, because no execution was observed', async () => {
      const written = await adoptBaseline(exec);

      expect(written.length).toBe(MIGRATIONS.length);
      for (const row of written) {
        expect(row.status).not.toBe('applied');
        expect(['baseline_detected', 'baseline_pending', 'baseline_unknown']).toContain(
          row.status,
        );
        // Evidence is recorded so the reason survives in the database.
        expect(row.detectionEvidence).toBeTruthy();
        // No checksum: there is no "the file as it was when we ran it".
        expect(row.checksum).toBeNull();
      }
    });

    it('detects the end state this test database actually has', async () => {
      await adoptBaseline(exec);
      const records = await readMigrationRecords(exec);

      // The fixture and initializeSchema() both build NUMERIC money columns,
      // so the conversion's end state is present — which is exactly the case
      // that must read as baseline_detected and NOT as applied. Nothing ever
      // ran 20260907 here; the schema was simply created that way.
      const money = records.get('20260907_money_real_to_numeric');
      expect(money?.status).toBe('baseline_detected');
      expect(money?.detectionEvidence).toMatch(/non-float/);

      const widened = records.get('20261003_widen_transactions_cross_border_amounts');
      expect(widened?.status).toBe('baseline_detected');
      expect(widened?.detectionEvidence).toMatch(/numeric\(14,2\)/i);
    });

    it('is idempotent and never overwrites a real execution record', async () => {
      const id = MIGRATIONS[2].id;
      await beginMigration(id, 'operator:test', ROOT, exec);
      await completeMigration(id, exec);

      await adoptBaseline(exec);

      const row = (await readMigrationRecords(exec)).get(id);
      expect(row?.status).toBe('applied');
      expect(row?.appliedBy).toBe('operator:test');

      // Running adoption twice changes nothing further.
      const before = await readMigrationRecords(exec);
      await adoptBaseline(exec);
      const after = await readMigrationRecords(exec);
      expect(after.size).toBe(before.size);
    });

    /**
     * These two need the correlation index absent or wrong, which means
     * mutating schema. On a disposable database, not the shared one.
     *
     * An earlier version of this file dropped the index from the shared
     * database and recreated it afterwards. That broke
     * `stripe-settlement.test.ts`, which relies on the uniqueness guarantee —
     * and recreating it in `afterAll` would not have fixed it, because vitest
     * runs files in parallel, so the window where the index was missing is a
     * race rather than an ordering problem. `initializeSchema()` does not
     * create this index (only the test fixture and the migration do), so a
     * scratch database has it naturally absent, which is exactly the state
     * these cases need.
     */
    describe('on a disposable database, so the shared one keeps its index', () => {
      it('reports absent end state as pending work, not as an error', async () => {
        await withScratchDatabase(async (scratch) => {
          const written = await adoptBaseline(scratch);
          const row = written.find(
            (r) => r.id === '20261004_early_webhook_metadata_correlation',
          );

          expect(row?.status).toBe('baseline_pending');
          expect(row?.detectionEvidence).toMatch(/not present/);
        });
      });

      it('reports a non-unique index of the same name as unknown, not as done', async () => {
        // The migration's purpose is the uniqueness guarantee. An index of the
        // right name without it must not read as the end state, or adoption
        // would record a guarantee this database does not have.
        await withScratchDatabase(async (scratch) => {
          await scratch`
            CREATE INDEX idx_transfer_intents_correlation_id
              ON transfer_intents (correlation_id)
          `;

          const detection = await findMigration(
            '20261004_early_webhook_metadata_correlation',
          )!.detect(scratch);

          expect(detection.outcome).toBe('unknown');
          expect(detection.evidence).toMatch(/not the one this migration creates/);
        });
      });

      it('reports the migration end state as present once the real index exists', async () => {
        await withScratchDatabase(async (scratch) => {
          // Verbatim from migrations/20261004_early_webhook_metadata_correlation.sql,
          // so this asserts against the shape the migration actually creates.
          await scratch`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_correlation_id
              ON public.transfer_intents(correlation_id)
              WHERE correlation_id IS NOT NULL
          `;

          const detection = await findMigration(
            '20261004_early_webhook_metadata_correlation',
          )!.detect(scratch);

          expect(detection.outcome).toBe('present');
          expect(detection.evidence).toMatch(/UNIQUE/);
        });
      });

      /**
       * A false `present` is worse than `baseline_unknown`: it records the
       * migration as satisfied while the uniqueness guarantee it exists to
       * create is absent, and that guarantee is what stops one verified Stripe
       * metadata value resolving to more than one local transfer.
       *
       * The earlier check tested `/UNIQUE/i` against `pg_indexes.indexdef`,
       * which both of these would have passed.
       */
      it('rejects a UNIQUE index of the right name on the WRONG column', async () => {
        await withScratchDatabase(async (scratch) => {
          await scratch`
            CREATE UNIQUE INDEX idx_transfer_intents_correlation_id
              ON public.transfer_intents(provider_reference_id)
              WHERE provider_reference_id IS NOT NULL
          `;

          const detection = await findMigration(
            '20261004_early_webhook_metadata_correlation',
          )!.detect(scratch);

          expect(detection.outcome).toBe('unknown');
          expect(detection.evidence).toMatch(/not the one this migration creates/);
        });
      });

      it('rejects a UNIQUE index on the right column but WITHOUT the partial predicate', async () => {
        await withScratchDatabase(async (scratch) => {
          await scratch`
            CREATE UNIQUE INDEX idx_transfer_intents_correlation_id
              ON public.transfer_intents(correlation_id)
          `;

          const detection = await findMigration(
            '20261004_early_webhook_metadata_correlation',
          )!.detect(scratch);

          // Conservative on purpose. A full unique index may well deliver the
          // same guarantee for non-null values, but it is not what the
          // migration creates, so a human should decide rather than tracking
          // silently recording it as done.
          expect(detection.outcome).toBe('unknown');
          expect(detection.evidence).toMatch(/not the one this migration creates/);
        });
      });

      it('rejects a multi-column UNIQUE index of the right name', async () => {
        await withScratchDatabase(async (scratch) => {
          await scratch`
            CREATE UNIQUE INDEX idx_transfer_intents_correlation_id
              ON public.transfer_intents(correlation_id, provider_reference_id)
              WHERE correlation_id IS NOT NULL
          `;

          const detection = await findMigration(
            '20261004_early_webhook_metadata_correlation',
          )!.detect(scratch);

          expect(detection.outcome).toBe('unknown');
        });
      });
    });
  });

  describe('drift detection', () => {
    it('flags a file that changed after being recorded as applied', async () => {
      const id = MIGRATIONS[0].id;
      await beginMigration(id, 'operator:test', ROOT, exec);
      await completeMigration(id, exec);

      // Simulate the file having been edited since: overwrite the stored hash.
      await sql`UPDATE schema_migrations SET checksum = ${'0'.repeat(64)} WHERE id = ${id}`;

      const state = await describeState(ROOT, exec);
      expect(state.drift.map((d) => d.id)).toContain(id);
      expect(state.current).toBe(false);
    });

    it('does not invent drift for a baseline row, which has no recorded hash', async () => {
      await adoptBaseline(exec);
      const state = await describeState(ROOT, exec);
      expect(state.drift).toEqual([]);
    });
  });

  describe('is this database current?', () => {
    it('an unadopted database is not current — empty means unknown', async () => {
      const state = await describeState(ROOT, exec);
      expect(state.untracked.sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
      expect(state.current).toBe(false);
    });

    it('refuses to proceed while the database is unadopted', async () => {
      await expect(assertSafeToProceed(ROOT, exec)).rejects.toThrow(
        /not adopted into migration tracking/,
      );
    });

    it('refuses to proceed while anything is blocking', async () => {
      await adoptBaseline(exec);
      const id = MIGRATIONS[1].id;
      await sql`UPDATE schema_migrations SET status = 'failed' WHERE id = ${id}`;

      await expect(assertSafeToProceed(ROOT, exec)).rejects.toThrow(/is failed/);
    });

    it('treats an unknown detection as blocking, because guessing applies twice', async () => {
      await adoptBaseline(exec);
      await sql`UPDATE schema_migrations SET status = 'baseline_unknown' WHERE id = ${MIGRATIONS[0].id}`;

      const state = await describeState(ROOT, exec);
      expect(state.blocked.map((r) => r.id)).toContain(MIGRATIONS[0].id);
      await expect(assertSafeToProceed(ROOT, exec)).rejects.toThrow(/baseline_unknown/);
    });

    it('is current only when every migration is satisfied with no drift or blocks', async () => {
      for (const migration of MIGRATIONS) {
        await sql`
          INSERT INTO schema_migrations (id, status, applied_by, updated_at)
          VALUES (${migration.id}, 'baseline_detected', 'test', NOW())
          ON CONFLICT (id) DO UPDATE SET status = 'baseline_detected'
        `;
      }

      const state = await describeState(ROOT, exec);
      expect(state.current).toBe(true);
      await expect(assertSafeToProceed(ROOT, exec)).resolves.toBeUndefined();
    });
  });

  describe('the convergent reconciler is recorded, not versioned', () => {
    it('is not a registry entry, because per-statement versions are meaningless', () => {
      expect(findMigration('convergent_api_migrate')).toBeUndefined();
      expect(MIGRATIONS.map((m) => m.id)).not.toContain('convergent_api_migrate');
    });

    it('records a run and updates in place rather than accumulating rows', async () => {
      await recordConvergenceRun('applied', 'admin:7', null, exec);
      await recordConvergenceRun('applied', 'admin:7', null, exec);

      const rows = await sql<{ count: string }[]>`
        SELECT COUNT(*) AS count FROM schema_migrations WHERE id = 'convergent_api_migrate'
      `;
      expect(Number(rows[0].count)).toBe(1);
    });

    it('records a failed run with its reference', async () => {
      await recordConvergenceRun('failed', 'migrate-route', 'ref-99', exec);

      const row = (await readMigrationRecords(exec)).get('convergent_api_migrate');
      expect(row?.status).toBe('failed');
      expect(row?.errorReference).toBe('ref-99');
    });

    it('does not make describeState() current on its own', async () => {
      // A convergence record says the reconciler ran. It says nothing about
      // the three authorization-gated migrations, so it must not satisfy them.
      await recordConvergenceRun('applied', 'admin:7', null, exec);
      const state = await describeState(ROOT, exec);
      expect(state.current).toBe(false);
      expect(state.untracked.length).toBe(MIGRATIONS.length);
    });
  });

  describe('against a populated database', () => {
    it('adoption reads the same on a database holding real rows', async () => {
      // The directive asks for fresh and representative populated databases.
      // Detection inspects the catalogue, so rows should be irrelevant — this
      // asserts that rather than assuming it, since a probe accidentally
      // written against data would pass on an empty database and change
      // answer under load.
      const [user] = await sql<{ id: number }[]>`
        INSERT INTO users (name, username, email, password_hash, country, balance_cad, balance_usd)
        VALUES ('Pop', ${`pop_${Date.now()}`}, ${`pop_${Date.now()}@x.test`}, 'h', 'CA', 10, 0)
        RETURNING id
      `;
      const [txn] = await sql<{ id: number }[]>`
        INSERT INTO transactions
          (sender_id, receiver_id, amount, currency, type, status, privacy, payment_rail)
        VALUES (${user.id}, ${user.id}, 5, 'CAD', 'payment', 'completed', 'private', 'internal')
        RETURNING id
      `;

      await clearTracking();
      const written = await adoptBaseline(exec);
      const byId = new Map(written.map((r) => [r.id, r]));

      expect(byId.get('20260907_money_real_to_numeric')?.status).toBe('baseline_detected');
      expect(
        byId.get('20261003_widen_transactions_cross_border_amounts')?.status,
      ).toBe('baseline_detected');

      await sql`DELETE FROM transactions WHERE id = ${txn.id}`;
      await sql`DELETE FROM users WHERE id = ${user.id}`;
    });
  });
});
