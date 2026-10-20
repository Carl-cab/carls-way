/**
 * Migration versioning types — decision 0005 Phase 2.
 *
 * ── The distinction this whole module is built around ──────────────────────
 *
 * **Detecting a migration's end state is not the same as knowing it ran.**
 *
 * Two of the three files in `migrations/` produce an end state that something
 * else in this codebase can also produce. `upgradeLegacyMoneyColumns()` issues
 * the same `ALTER COLUMN … TYPE NUMERIC(14,2)` as
 * `20260907_money_real_to_numeric.sql`, and the migrate route calls it. So a
 * database whose money columns are `numeric` may have got there by the
 * authorized maintenance migration, by the route's convergence, or by having
 * been created that way. The schema cannot tell you which.
 *
 * That is why `baseline_detected` exists and is a different thing from
 * `applied`. `applied` means *this mechanism watched an execution succeed*.
 * `baseline_detected` means *the end state is present and re-applying would be
 * unnecessary*, with no claim about execution. Collapsing the two would
 * manufacture a migration history that was never observed, which is the
 * specific failure the directive for this phase rules out.
 *
 * ── What this module deliberately does NOT do ──────────────────────────────
 *
 * It does not execute migrations. There is no `apply()` here, by design: the
 * three files in `migrations/` are authorization-gated financial maintenance
 * (see `sql/README.md`), and the runner that executes them is Phase 3, built
 * against a restored copy from Phase 0. Phase 2 is the substrate that lets any
 * runner — or an operator with `psql` — record what happened and lets anyone
 * ask whether a given database is current.
 */

/**
 * Lifecycle of one migration against one database.
 *
 * Ordering note: these are not a progression. `baseline_*` values describe a
 * database adopted into tracking after the fact; `applied`/`failed`/`partial`
 * describe an execution this mechanism observed.
 */
export type MigrationStatus =
  /** This mechanism recorded an execution that completed successfully. */
  | 'applied'
  /**
   * Execution began and reported an error. The schema may be partly changed.
   * Blocks further migration work until an operator resolves it — never
   * retried automatically, because a failed financial DDL needs eyes.
   */
  | 'failed'
  /**
   * Execution began and no outcome was ever recorded — the process died
   * between start and finish. Indistinguishable from `failed` as far as the
   * schema is concerned, and deliberately a separate status so an operator can
   * see that nothing reported back rather than that something reported an
   * error. Also blocks.
   */
  | 'partial'
  /**
   * The migration's end state is present in this database, but no execution
   * was observed. Recorded by the adoption procedure for a pre-existing
   * database. **Not a claim that the migration ran.**
   */
  | 'baseline_detected'
  /**
   * The migration's end state is absent. It needs applying under the
   * maintenance procedure. Not an error — just work outstanding.
   */
  | 'baseline_pending'
  /**
   * Detection could not reach a conclusion — typically the table or column the
   * probe inspects does not exist, so neither "done" nor "outstanding" is
   * true. Requires an operator to look, and blocks, because acting on an
   * unknown is how a migration gets applied twice.
   */
  | 'baseline_unknown';

/** Statuses that must stop any further automated migration work. */
export const BLOCKING_STATUSES: ReadonlyArray<MigrationStatus> = [
  'failed',
  'partial',
  'baseline_unknown',
] as const;

/** Statuses meaning "this database already has this migration's end state". */
export const SATISFIED_STATUSES: ReadonlyArray<MigrationStatus> = [
  'applied',
  'baseline_detected',
] as const;

/**
 * The result of a detection probe.
 *
 * `evidence` is recorded verbatim so the reason for a baseline decision
 * survives in the database rather than living only in whoever ran it. It
 * carries catalogue facts — type names, index names — never data.
 */
export interface DetectionResult {
  /** present: end state found. absent: not found. unknown: cannot tell. */
  outcome: 'present' | 'absent' | 'unknown';
  evidence: string;
}

/** A migration this repository knows about. */
export interface MigrationDescriptor {
  /**
   * Stable identifier. The filename without `.sql`, which makes it sortable by
   * date and greppable against the file it names. Never renumbered: an id that
   * moves breaks every database already tracking it.
   */
  id: string;
  /** Path relative to the repository root. */
  file: string;
  /** One line on what it does, for operator-facing output. */
  summary: string;
  /**
   * Whether the file manages its own transaction. All three current migrations
   * do (`BEGIN`/`COMMIT` inside), and none uses `CREATE INDEX CONCURRENTLY`,
   * which cannot run inside a transaction block. A future migration that needs
   * `CONCURRENTLY` must set this false so a runner does not wrap it.
   */
  selfTransacting: boolean;
  /**
   * Probes whether this migration's end state is present, for adoption of a
   * pre-existing database. Must be read-only — it runs against production-like
   * databases during adoption.
   */
  detect: (sql: MigrationSqlExecutor) => Promise<DetectionResult>;
}

/**
 * The slice of `postgres.js` this module needs.
 *
 * Narrow on purpose: it keeps the tracking code testable and makes it obvious
 * that nothing here needs a privileged or DDL-capable connection beyond
 * creating its own table.
 */
export type MigrationSqlExecutor = {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  unsafe<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
};

/** One row of tracking state, as the application reads it. */
export interface MigrationRecord {
  id: string;
  status: MigrationStatus;
  /** sha256 of the file as it stood when the row was written; null for baselines. */
  checksum: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  /** An operator or runner label. Never a credential. */
  appliedBy: string | null;
  /** Ties a failure to a server-side log line. Never the raw error text. */
  errorReference: string | null;
  detectionEvidence: string | null;
  recordedAt: Date;
  updatedAt: Date;
}

/**
 * A migration whose file no longer matches the row that recorded it.
 *
 * `currentChecksum` is `null` when the file is absent entirely. That is drift,
 * not an absence of evidence: a row claims this mechanism applied a file that
 * is no longer in the tree, so nothing can say what was applied.
 */
export interface MigrationDrift {
  id: string;
  recordedChecksum: string;
  currentChecksum: string | null;
  status: MigrationStatus;
}

/** The whole picture, for an operator or a readiness report. */
export interface MigrationState {
  /** Rows present in `schema_migrations`, by id. */
  records: Map<string, MigrationRecord>;
  /** Registry entries with no row — this database has not been adopted for them. */
  untracked: string[];
  /** Rows whose file no longer matches the recorded checksum. */
  drift: MigrationDrift[];
  /** Rows in a blocking status, which must stop automated work. */
  blocked: MigrationRecord[];
  /**
   * True when every registry migration is satisfied, nothing is blocking and
   * nothing has drifted. The single question Phase 2 exists to answer: "is
   * this database current?"
   */
  current: boolean;
}
