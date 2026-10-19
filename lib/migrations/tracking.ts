import { getSql } from '@/lib/db';
import { MIGRATIONS, fileChecksum } from '@/lib/migrations/registry';
import {
  BLOCKING_STATUSES,
  SATISFIED_STATUSES,
  type MigrationRecord,
  type MigrationSqlExecutor,
  type MigrationState,
  type MigrationStatus,
} from '@/lib/migrations/types';

/**
 * `schema_migrations` reads and writes — decision 0005 Phase 2.
 *
 * There is no `apply()` in this file and that is deliberate; see the header of
 * `./types`. This records outcomes and answers "is this database current?".
 *
 * ── Concurrency ────────────────────────────────────────────────────────────
 *
 * Two runners must not apply migrations at once. The guard is a PostgreSQL
 * advisory lock, taken with `pg_try_advisory_lock` — the *try* variant, so a
 * second runner is refused immediately instead of queueing. Queueing is the
 * wrong behaviour here for a reason already learned in `lib/db.ts`: a blocking
 * lock with no timeout holds connections open, and on serverless that turns
 * one slow migration into exhausted pool capacity. A refused second runner is
 * a clear operator signal; a hung one is not.
 *
 * ── Backward compatibility ─────────────────────────────────────────────────
 *
 * An existing database has no rows. That is not "no migrations applied" — it
 * is "not adopted into tracking", which `adoptBaseline()` resolves by probing
 * for each migration's end state. Until adoption runs, `describeState()`
 * reports those ids as `untracked` and `current` is false, because an
 * unanswered question is not a pass.
 */

/**
 * Stable key for the advisory lock. Any constant works, as long as it never
 * changes: a different key is a different lock, so two versions of this code
 * would not exclude each other.
 *
 * A plain number rather than a bigint literal, because the TypeScript target
 * here is below ES2020. It is well under `Number.MAX_SAFE_INTEGER`
 * (9,007,199,254,740,991) so it round-trips exactly, and the `::bigint` cast
 * at each call site gives PostgreSQL the type its advisory-lock functions
 * expect.
 */
const MIGRATION_LOCK_KEY = 8123470015523001;

/** Columns in the order `mapRow` expects. */
const COLUMNS = `
  id, status, checksum, started_at, finished_at, duration_ms,
  applied_by, error_reference, detection_evidence, recorded_at, updated_at
`;

interface MigrationRow {
  id: string;
  status: string;
  checksum: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | string | null;
  applied_by: string | null;
  error_reference: string | null;
  detection_evidence: string | null;
  recorded_at: Date;
  updated_at: Date;
}

function mapRow(row: MigrationRow): MigrationRecord {
  return {
    id: row.id,
    status: row.status as MigrationStatus,
    checksum: row.checksum,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    appliedBy: row.applied_by,
    errorReference: row.error_reference,
    detectionEvidence: row.detection_evidence,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create the tracking table if absent.
 *
 * Kept here as well as in the three schema sources because this module must
 * work against a database that predates the table — including a restored
 * production copy during the Phase 0 rehearsal, where running the whole
 * migrate route would be the wrong instrument.
 */
export async function ensureMigrationTable(
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      checksum TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      duration_ms BIGINT,
      applied_by TEXT,
      error_reference TEXT,
      detection_evidence TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

/**
 * Run `fn` holding the migration advisory lock, or throw if another holder has
 * it. The callback receives the locked connection and should use it, so its
 * work is serialised by the same lock that admitted it.
 *
 * ── Why this reserves a connection ─────────────────────────────────────────
 *
 * `pg_try_advisory_lock` takes a **session**-scoped lock, and `postgres.js` is
 * a connection *pool*: consecutive queries on the pool handle can land on
 * different backends. Taking the lock on one connection and releasing it on
 * another leaves the first still holding it until that connection is recycled
 * — a leaked lock that blocks every later migration run with no visible cause.
 * Measured: with a reserved connection, `pg_locks` shows one advisory row
 * after the lock and zero after the unlock; without one there is no guarantee
 * the two statements even reach the same backend.
 *
 * `initializeSchema()` sidesteps this by using `pg_advisory_xact_lock`, which
 * releases at transaction end and is therefore pool-safe. That is not usable
 * here: a migration runner must hold the lock across statements that manage
 * their own `BEGIN`/`COMMIT` (all three files in `migrations/` do), and those
 * cannot be nested inside an outer transaction. So the lock is session-scoped
 * and the connection is pinned instead.
 *
 * `try` rather than a blocking wait, deliberately: a second runner is refused
 * immediately. A blocking wait with no timeout holds a connection open, which
 * on serverless turns one slow migration into exhausted pool capacity — the
 * same reasoning `lib/db.ts` records for the boot-time money upgrade.
 */
export async function withMigrationLock<T>(
  fn: (locked: MigrationSqlExecutor) => Promise<T>,
  db: { reserve: () => Promise<ReservedConnection> } = getSql() as unknown as {
    reserve: () => Promise<ReservedConnection>;
  },
): Promise<T> {
  const reserved = await db.reserve();
  const sql = reserved as unknown as MigrationSqlExecutor;

  try {
    const got = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY}::bigint) AS locked
    `;
    if (!got[0]?.locked) {
      throw new Error(
        'Another migration runner holds the advisory lock. Refusing rather than queueing: ' +
          'a blocking wait would hold this connection open. Retry once the other run finishes.',
      );
    }

    try {
      return await fn(sql);
    } finally {
      // Same reserved connection, so this releases the lock we actually took.
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    }
  } finally {
    reserved.release();
  }
}

/** The part of `postgres.js`'s reserved connection this module uses. */
type ReservedConnection = {
  release: () => void;
};

/** Every tracking row, by id. */
export async function readMigrationRecords(
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<Map<string, MigrationRecord>> {
  const rows = await sql.unsafe<MigrationRow>(
    `SELECT ${COLUMNS} FROM schema_migrations ORDER BY id`,
  );
  return new Map(rows.map((r) => [r.id, mapRow(r)]));
}

/**
 * Mark a migration as started.
 *
 * Writes `partial` *before* the work begins, so a process that dies mid-DDL
 * leaves evidence that something started and never reported back. The
 * alternative — writing only on completion — is indistinguishable from "never
 * ran", which is precisely the state that gets a financial migration applied
 * twice.
 *
 * Refuses to overwrite a satisfied or blocking row: re-running something
 * already applied, or already known broken, is an operator decision.
 */
export async function beginMigration(
  id: string,
  appliedBy: string,
  repoRoot: string,
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<void> {
  const descriptor = MIGRATIONS.find((m) => m.id === id);
  if (!descriptor) {
    throw new Error(
      `Unknown migration id '${id}'. Add it to lib/migrations/registry.ts rather than ` +
        'recording an id this repository cannot describe.',
    );
  }

  const existing = await readMigrationRecords(sql);
  const row = existing.get(id);
  if (row && (SATISFIED_STATUSES as string[]).includes(row.status)) {
    throw new Error(
      `Migration '${id}' is already ${row.status}. Re-applying is an operator decision; ` +
        'clear or annotate the row deliberately first.',
    );
  }
  if (row && (BLOCKING_STATUSES as string[]).includes(row.status)) {
    throw new Error(
      `Migration '${id}' is ${row.status} and blocks further work. Resolve it by hand ` +
        'before retrying — a failed or unresolved financial DDL is not retried automatically.',
    );
  }

  const checksum = fileChecksum(repoRoot, descriptor.file);

  await sql`
    INSERT INTO schema_migrations
      (id, status, checksum, started_at, applied_by, updated_at)
    VALUES
      (${id}, 'partial', ${checksum}, NOW(), ${appliedBy}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      status = 'partial',
      checksum = EXCLUDED.checksum,
      started_at = NOW(),
      finished_at = NULL,
      duration_ms = NULL,
      applied_by = EXCLUDED.applied_by,
      error_reference = NULL,
      updated_at = NOW()
  `;
}

/** Record a successful execution. */
export async function completeMigration(
  id: string,
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<void> {
  await sql`
    UPDATE schema_migrations
    SET status = 'applied',
        finished_at = NOW(),
        duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::bigint),
        updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Record a failure.
 *
 * Takes a reference, not an error. The raw text of a DDL failure can carry
 * schema and occasionally value detail, and this table is read by more places
 * than the log is — same reasoning as the redacted 500 in the migrate route.
 */
export async function failMigration(
  id: string,
  errorReference: string,
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<void> {
  await sql`
    UPDATE schema_migrations
    SET status = 'failed',
        finished_at = NOW(),
        duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::bigint),
        error_reference = ${errorReference},
        updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Adopt a pre-existing database into tracking by probing each migration's end
 * state.
 *
 * Writes `baseline_detected` where the end state is present, `baseline_pending`
 * where it is absent, and `baseline_unknown` where the probe cannot tell.
 * **It never writes `applied`**, because no execution was observed — see the
 * header of `./types` for why that distinction is load-bearing rather than
 * pedantic.
 *
 * Only fills gaps: a row this mechanism already wrote is left alone, so
 * adoption is idempotent and cannot overwrite a real execution record with a
 * weaker inference.
 */
export async function adoptBaseline(
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<MigrationRecord[]> {
  await ensureMigrationTable(sql);
  const existing = await readMigrationRecords(sql);
  const written: MigrationRecord[] = [];

  for (const migration of MIGRATIONS) {
    if (existing.has(migration.id)) continue;

    const detection = await migration.detect(sql);
    const status: MigrationStatus =
      detection.outcome === 'present'
        ? 'baseline_detected'
        : detection.outcome === 'absent'
          ? 'baseline_pending'
          : 'baseline_unknown';

    await sql`
      INSERT INTO schema_migrations
        (id, status, checksum, detection_evidence, applied_by, updated_at)
      VALUES
        (${migration.id}, ${status}, NULL, ${detection.evidence}, 'baseline-adoption', NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    const refreshed = await readMigrationRecords(sql);
    const row = refreshed.get(migration.id);
    if (row) written.push(row);
  }

  return written;
}

/**
 * Record a run of the convergent `/api/migrate` pipeline.
 *
 * Not a registry migration — see the header of `./registry` for why the ~103
 * idempotent statements are not versioned individually. This exists so the
 * question "when did this database last have the reconciler run against it,
 * and did it succeed?" has an answer, which it previously did not.
 *
 * The id is fixed, so the row is updated in place rather than accumulating one
 * row per deploy: this is a convergence marker, not an audit log, and
 * `audit_logs` already records the operator action.
 */
export async function recordConvergenceRun(
  outcome: 'applied' | 'failed',
  appliedBy: string,
  errorReference: string | null = null,
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<void> {
  await sql`
    INSERT INTO schema_migrations
      (id, status, started_at, finished_at, applied_by, error_reference, detection_evidence, updated_at)
    VALUES
      ('convergent_api_migrate', ${outcome}, NOW(), NOW(), ${appliedBy}, ${errorReference},
       'convergent reconciler (app/api/migrate/route.ts); not a versioned migration', NOW())
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      finished_at = EXCLUDED.finished_at,
      applied_by = EXCLUDED.applied_by,
      error_reference = EXCLUDED.error_reference,
      updated_at = NOW()
  `;
}

/**
 * The whole picture: what is tracked, what drifted, what blocks, and whether
 * this database is current.
 *
 * Drift is only meaningful for rows carrying a checksum — a baseline row has
 * none, because no execution was observed and so there is no "the file as it
 * was when we ran it" to compare against. Reporting drift on a baseline row
 * would be inventing a comparison.
 */
export async function describeState(
  repoRoot: string,
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<MigrationState> {
  await ensureMigrationTable(sql);
  const records = await readMigrationRecords(sql);

  const untracked: string[] = [];
  const drift: MigrationState['drift'] = [];

  for (const migration of MIGRATIONS) {
    const row = records.get(migration.id);
    if (!row) {
      untracked.push(migration.id);
      continue;
    }
    if (row.checksum) {
      const current = fileChecksum(repoRoot, migration.file);
      if (current && current !== row.checksum) {
        drift.push({
          id: migration.id,
          recordedChecksum: row.checksum,
          currentChecksum: current,
          status: row.status,
        });
      }
    }
  }

  const blocked = [...records.values()].filter((r) =>
    (BLOCKING_STATUSES as string[]).includes(r.status),
  );

  const allSatisfied = MIGRATIONS.every((m) => {
    const row = records.get(m.id);
    return row ? (SATISFIED_STATUSES as string[]).includes(row.status) : false;
  });

  return {
    records,
    untracked,
    drift,
    blocked,
    current: allSatisfied && untracked.length === 0 && drift.length === 0 && blocked.length === 0,
  };
}

/**
 * Throw unless it is safe to proceed with migration work.
 *
 * Fails closed on a blocking row, on drift, and on an unadopted database,
 * because each means a question about this database is unanswered and the
 * failure mode of guessing is applying a financial migration twice.
 */
export async function assertSafeToProceed(
  repoRoot: string,
  sql: MigrationSqlExecutor = getSql() as unknown as MigrationSqlExecutor,
): Promise<void> {
  const state = await describeState(repoRoot, sql);

  if (state.blocked.length > 0) {
    throw new Error(
      'Refusing: ' +
        state.blocked
          .map((r) => `${r.id} is ${r.status}`)
          .join('; ') +
        '. Resolve by hand — these are not retried automatically.',
    );
  }
  if (state.drift.length > 0) {
    throw new Error(
      'Refusing: migration files changed after being recorded as applied (' +
        state.drift.map((d) => d.id).join(', ') +
        '). Either the file was edited post-application or the row is from a different ' +
        'version of it; both need an operator to decide which.',
    );
  }
  if (state.untracked.length > 0) {
    throw new Error(
      'Refusing: this database is not adopted into migration tracking (' +
        state.untracked.join(', ') +
        '). Run the adoption procedure in docs/runbooks/migration-baseline-adoption.md first. ' +
        'An empty tracking table means "unknown", not "nothing applied".',
    );
  }
}
