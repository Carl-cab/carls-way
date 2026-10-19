# Runbook — adopting an existing database into migration tracking

**Status: NOT RUN against production.** Decision 0005 Phase 2 built the
tracking mechanism; this procedure is how an already-existing database joins
it. Nothing here changes a schema.

## The problem this solves, precisely

Before Phase 2 there was no way to answer **"is this database current?"**. Three
authorization-gated migrations live in `migrations/`, each a financial schema
change run by hand under the procedure in `sql/README.md`, and nothing recorded
whether any of them had been run against any given database.

That matters most in the direction people forget: **applying one twice.**
`20260907_money_real_to_numeric.sql` rewrites balance columns under
`ACCESS EXCLUSIVE`. Running it when it has already run is not a no-op you can
shrug at — it is a second table rewrite on a live financial table.

## The distinction that shapes this whole procedure

**Detecting a migration's end state is not the same as knowing it ran.**

Two of the three migrations produce an end state that something else in this
codebase can also produce: `upgradeLegacyMoneyColumns()` issues the same
`ALTER COLUMN … TYPE NUMERIC(14,2)` as the money migration, and the migrate
route calls it. A database whose money columns are `numeric` may have got there
by the authorized migration, by the route's convergence, or by having been
created that way — and the catalogue cannot tell you which.

So adoption records `baseline_detected`, never `applied`:

| Status | Means | Does **not** mean |
|---|---|---|
| `baseline_detected` | the end state is present; re-applying is unnecessary | that the migration was executed |
| `baseline_pending` | the end state is absent; apply it under the maintenance procedure | that anything is broken |
| `baseline_unknown` | the probe could not tell | that it is safe to proceed |
| `applied` | **this mechanism watched an execution succeed** | — |

`baseline_unknown` **blocks**, deliberately. An unanswered question is the
state in which a financial migration gets applied twice, so the code refuses
rather than defaulting either way.

## Prerequisites — owner actions

1. **Decide which database.** Adoption is per-database. A restored copy from
   the Phase 0 rehearsal is the right place to practise; production is a
   separate authorization.
2. **Have the repository at a known commit.** Checksums are computed from the
   files on disk, so a checkout that does not match what was deployed will
   record hashes for the wrong text.
3. **Read-only expectations.** Adoption runs three catalogue probes and writes
   rows to `schema_migrations`. It issues no `ALTER`, no `CREATE INDEX`, and
   touches no customer data.

## Procedure

### 1. Confirm the tracking table exists

```bash
psql "$DATABASE_URL" -c "\d schema_migrations"
```

Absent on a database that predates Phase 2. `ensureMigrationTable()` creates it
with `CREATE TABLE IF NOT EXISTS`, and so does `/api/migrate` and
`initializeSchema()`. Creating it is the only write adoption performs besides
its own rows.

### 2. Run adoption

**There is no CLI entry point, and the obvious workarounds do not work.**
Measured, so the next person does not spend the time I did:

```
pnpm tsx scripts/…                → tsx is not a declared dependency; fails for
                                    any operator without it installed globally
                                    (the mistake scripts/status/report.mjs records)
node --input-type=module -e '…await import("./lib/migrations/tracking.ts")'
                                  → ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'
                                    — Node does not resolve this repository's
                                    `@/` path alias, so it fails before type
                                    stripping is even reached
```

What **does** work today is the test runner, which is a declared dependency and
resolves the alias through the vitest config:

```bash
# In a checkout at the deployed commit, with DATABASE_URL pointing at the
# database being adopted — NOT production, without separate authorization.
DATABASE_URL="postgres://…" npx vitest run lib/__tests__/migration-versioning.test.ts
```

That exercises adoption against the target database and asserts what each probe
concluded. It is a test file doing an operator's job, which is not where this
should end up — a first-class entry point belongs with **Phase 3's runner**,
and that is the right place for it rather than a hand-written script here.

A `psql`-only path is deliberately **not** offered. It would mean hand-copying
the three detection probes out of `lib/migrations/registry.ts` into SQL, which
creates a second source of the detection logic; this PR series has already
shipped two bad hand-copied queries, and the fix was to commit one file and
guard it with a parity test rather than to copy more carefully. If a psql path
is wanted before Phase 3, it should be a committed `.sql` file with a parity
test against the registry, on the model of `scripts/reconciliation-check.sql`.

### 3. Read the result, and do not round it up

```sql
SELECT id, status, applied_by, detection_evidence
FROM schema_migrations
ORDER BY id;
```

Expected shapes:

- **`baseline_detected`** with evidence naming the catalogue fact — e.g.
  `sender_amount=numeric(14,2), receiver_amount=numeric(14,2)`. Nothing further
  to do for that migration, and **do not re-record it as `applied`**.
- **`baseline_pending`** — that migration's end state is absent. It is
  outstanding work under `sql/README.md`'s maintenance procedure: reviewed
  procedure, verified backup, write drain, preflight reconciliation, explicit
  authorization. Adoption does not apply it and must not be made to.
- **`baseline_unknown`** — stop and look. The evidence says what the probe saw.
  A common cause is a table absent from this deployment; another is an index of
  the right name without the `UNIQUE` the migration exists to create.

### 4. Record it

Append to `PROJECT_MEMORY.md`: which database, the commit the checksums came
from, and the status and evidence for each of the three ids. The evidence string
is the point — it is what lets a later reader see *why* a baseline decision was
made rather than taking it on trust.

## What adoption does not give you

- **It does not establish migration history.** No row written by adoption
  claims an execution. If you need to know whether
  `20260907_money_real_to_numeric.sql` was ever actually run against
  production, the answer today is *unknown* and this procedure will not change
  that. It establishes the current end state, which is the question that
  governs whether to apply it again.
- **It does not cover the ~103 statements in `/api/migrate`.** Those are a
  convergent reconciler built from `ADD COLUMN IF NOT EXISTS` and
  `CREATE TABLE IF NOT EXISTS`; re-running them is the designed behaviour, so
  "has statement 47 been applied?" is not a meaningful question. The route now
  records *that it ran* under the fixed id `convergent_api_migrate`, which is
  a convergence marker, not a version.
- **It does not close the no-transaction gap.** A mid-pipeline failure in
  `/api/migrate` still leaves the schema between versions. The route now
  records a `failed` convergence row when that happens, so the state is
  visible, but visibility is not atomicity.

## Concurrency

Adoption and any future runner take a PostgreSQL advisory lock via
`withMigrationLock()`. It uses `pg_try_advisory_lock`, so a second runner is
**refused immediately** rather than queueing. That is deliberate: a blocking
wait with no timeout holds a connection open, and on serverless that turns one
slow migration into exhausted pool capacity — the same reasoning already
recorded in `lib/db.ts` for the boot-time money upgrade.
