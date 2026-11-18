# Migration package — `velocity_claims` (PR #77)

**Status: REHEARSED, NOT APPLIED to production.** Every command below was run
against disposable local databases on 2026-11-18. None was run against
production, and `POST /api/migrate` is **not** authorized by this document.

**Owner-controlled.** The execution steps are the owner's to run or to
delegate explicitly.

---

## What this migration does

PR #77 (`0cdadfa`) added the `velocity_claims` table, the funding/withdrawal
exposure ledger that replaced `reverseVelocity()`. It is deployed as code but
**has not been verified against the production database**.

Statements, as `app/api/migrate/route.ts` issues them — 7 in total:

- `CREATE TABLE IF NOT EXISTS velocity_claims (…)` — 16 columns
- 4 × `ALTER TABLE velocity_claims ADD COLUMN IF NOT EXISTS …`
  (`claim_kind`, `released_amount`, `released_at`, `release_event_id`)
- `CREATE UNIQUE INDEX IF NOT EXISTS velocity_claims_reference_key
   ON velocity_claims (provider, reference)`
- `CREATE INDEX IF NOT EXISTS idx_velocity_claims_user_state`

It is **additive**: no column is dropped, no type altered, no row rewritten.
The risk is therefore not data loss but a failed *partial* application, since
the ~103 statements in that route do **not** run in a transaction.

This PR also adds `users.province` and `users.balance` to the migrate route.
Both are additive `ADD COLUMN IF NOT EXISTS`, and both already exist on the
live `users` table (created by `initializeSchema()`), so on production they
are no-ops. They exist for databases **rebuilt** from the route — restore
targets and new environments — where their absence breaks registration and
`/api/me`. See `docs/audits/2026-11-18-sandbox-beta-readiness.md`.

---

## Required schema changes

| Object | Kind | Destructive? |
|---|---|---|
| `velocity_claims` | new table, 16 columns | no |
| `velocity_claims_reference_key` | unique index on `(provider, reference)` | no |
| `idx_velocity_claims_user_state` | index | no |
| `users.province` | `ADD COLUMN IF NOT EXISTS TEXT` | no |
| `users.balance` | `ADD COLUMN IF NOT EXISTS NUMERIC(14,2) DEFAULT 100.00` | no |

`users.balance` is the legacy column. It already exists in production; it is
listed in `MONEY_COLUMNS` and checked by `verify-migrate.sql`. CLAUDE.md's
rule is unchanged — never use it in new code.

---

## 1. Pre-migration backup

```bash
export PROD_URL='…'            # never echoed, never pasted into a transcript
pg_dump "$PROD_URL" -Fc -f manna-preflight-$(date +%Y%m%d-%H%M).dump
ls -la manna-preflight-*.dump  # a zero-byte dump is a failed backup
```

**A completed `pg_dump` is not a verified backup.** Step 2 is what makes it
one, and it is not optional.

## 2. Isolated restore rehearsal

Restore into a **separate database**, never over anything live.

```bash
createdb manna_restore_rehearsal
pg_restore -d "postgres://…/manna_restore_rehearsal?sslmode=disable" \
           manna-preflight-YYYYMMDD-HHMM.dump
```

Rehearsed 2026-11-18 against the sandbox database: **0 errors**, and exact
parity — 13 users, 5 transactions, 14 ledger entries, `sum(balance_cad)`
3040.00 identical on source and target.

Parity check to run on both:

```sql
SELECT (SELECT count(*) FROM users)          AS users,
       (SELECT count(*) FROM transactions)   AS txns,
       (SELECT count(*) FROM ledger_entries) AS ledger,
       (SELECT sum(balance_cad) FROM users)  AS sum_cad;
```

## 3. Apply the migration

Against the **restore rehearsal database first**, then production.

```bash
# Production, after the rehearsal passes:
curl -X POST -b <auth-cookie> https://carloscab74.vercel.app/api/migrate
```

POST, not GET — a state-changing GET was reachable by CSRF. A command-line
call sends no `Origin`, which the route deliberately allows. The operator path
is rate limited to 6/hour on admin id.

**Rehearsed on an existing-schema database**, which is the realistic shape:
the production dump restored, then `velocity_claims` dropped to simulate
pre-#77, then the 7 statements applied.

- applied with **0 errors**
- table created with **16 columns** and all 3 indexes
  (`velocity_claims_pkey`, `velocity_claims_reference_key`,
  `idx_velocity_claims_user_state`)
- **idempotent**: applied twice more, 0 errors each time
- **data preserved exactly**: 13 users, 5 transactions,
  `sum(balance_cad)` 3040.00, unchanged

## 4. Verification

```bash
psql "$TARGET_URL" -f scripts/verify-migrate.sql
```

**Every row must read OK. Zero `ABSENT`, `MISSING` or `WRONG TYPE`.** Measured
0 non-OK rows on both the restore target and the migrated pre-#77 database.

Constraint check — the unique index is load-bearing, so prove it rather than
assume it. Insert a `velocity_claims` row, then insert the same
`(provider, reference)` again:

```
first insert  -> INSERT 0 1
second insert -> ERROR: duplicate key value violates unique constraint
                 "velocity_claims_reference_key"
```

Verified 2026-11-18. That index is what stops a duplicate confirmation
claiming twice; an absent or non-unique index would pass a presence check and
fail silently in production.

## 5. Reconciliation

```bash
psql "$TARGET_URL" -f scripts/reconciliation-check.sql
```

**Read this section before running it, or you will misread the output.**

CLAUDE.md requires all seven rows to report PASS. On any database where
someone has registered or paid a split portion, **three rows currently FAIL
for known reasons that are not this migration**:

| Check | Why it fails today |
|---|---|
| `internal_payment_amounts_match_ledger` | split payments write `entry_type='split_payment'`; the invariant counts only `payment_sent`/`payment_received` |
| `payer_recipient_direction_currency_and_type` | same cause |
| `user_wallets_exactly_match_ledger` | the registration seed balance is never booked to the ledger, so every user is out by their seed amount |

Both are documented in `docs/audits/2026-11-18-sandbox-beta-readiness.md`
(findings 6, 6b). **Establish the baseline before migrating**, so that a row
which newly fails afterwards is distinguishable from one that was already
failing. Run step 5 on the restore target *first*, record the counts, and
compare.

`completed_internal_payments_in_scope` is a scope counter hardcoded `'PASS'`,
not an invariant. Do not cite it as one.

## 6. Failure handling and recovery

**The ~103 statements do not run in a transaction**, so a failure part-way
leaves the schema between versions. That is a known open item.

| Symptom | Action |
|---|---|
| Route returns an error reference | Find it in the logs; the message is redacted by design and the log carries the detail. Do **not** retry blindly. |
| Partial application suspected | Run `scripts/verify-migrate.sql`. It names each missing object. The statements are `IF NOT EXISTS`, so **re-running is the designed recovery** — it is a convergent reconciler, not a versioned migration. |
| 429 | The operator limit is 6/hour on admin id, and it degrades to per-instance if Redis is unavailable. Wait; do not work around it. |
| 403 | `Origin` was present and not allowed, or authentication failed. A command-line call sends no `Origin` and is permitted. |
| Verification still fails after re-running | **Stop.** Do not improvise DDL against production. Restore the rehearsal database from the preflight dump and reproduce there. |

**Rollback.** This migration is additive, so there is nothing to undo: an
unused table and two unused columns are inert. Do **not** `DROP TABLE
velocity_claims` to "clean up" after a failure — if any claim rows were
written, that destroys the exposure ledger. Code rollback is independent:
Vercel → Deployments → promote the previous deployment.

---

## What this rehearsal does **not** establish

- Nothing was run against production. Timings here are from a trivial
  dataset — the restore took 0.09s on 82 KB — and are **not transferable**.
- Production ownership and privileges are unverified. The migrate route
  requires table **ownership**, which is the coupling decision 0005 Phases 2–5
  exist to resolve.
- Backup availability and recovery point in production are unverified; this
  rehearsal used a dump taken locally.
- The three known reconciliation failures are **not fixed** by this migration
  and will still be present afterwards.
