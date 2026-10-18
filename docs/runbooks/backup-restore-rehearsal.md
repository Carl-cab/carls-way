# Runbook — backup and restore verification (decision 0005, Phase 0)

**Status: NOT RUN.** This procedure has never been executed. It blocks the
credential split, and therefore blocks audit immutability.

**A successful backup job is not a verified restore.** Supabase reporting a
completed snapshot tells you a file was written. It does not tell you the file
restores, that the restore contains the schema the application reads, or how
long it takes — and those are the three things anyone actually needs during an
incident. The whole point of this procedure is to find that out while nothing
is on fire.

## Safety rules, before anything else

- **Never restore over the live database.** Every step below restores into a
  *new, separate* database. There is no step that writes to production.
- **Never export customer data into an insecure environment.** A production
  restore contains real customer records. It goes into a database with the same
  access controls as production, not onto a laptop, not into CI, and not into
  this engineering session.
- **This session cannot do this work.** It has no production access (the egress
  proxy refuses it) and must not have it for this. The commands are written out
  so you do not have to invent them, not so they can be delegated.
- No production privileges, ownership, or environment variables change here.
  Phase 0 is read-only with respect to production.

## Prerequisites — owner actions

1. **Confirm what backup actually exists.** In Supabase: Database → Backups.
   Record the type (daily snapshot vs point-in-time recovery), the retention
   window, and the timestamp of the most recent one. PITR and daily snapshots
   restore differently; the rest of this assumes you have noted which you have.
2. **Provision a restore target** in the same project or region, with
   production-equivalent access control. A new Supabase project, or a separate
   database in the existing one. It must not be reachable by the application.
3. **Decide who performs it.** One person with production access, ideally with
   a second observing — this is the first rehearsal of a recovery path, which
   is a reasonable place to want a witness.
4. **Pick a window.** The restore itself does not touch production, but you
   will be reading production backup artifacts and should not be doing it
   during a deploy.

## Procedure

### 1. Restore into the new target

Use Supabase's restore flow onto the **new** database, not the live one. For a
`pg_dump` artifact instead:

```bash
# Into the RESTORE TARGET. Never the production URL.
pg_restore --no-owner --no-privileges \
  --dbname "$RESTORE_TARGET_URL" \
  production-backup.dump
```

`--no-owner --no-privileges` matters: it avoids carrying production role
grants into a database whose roles differ, which otherwise produces a wall of
errors that hides real ones.

**Record the wall-clock time this takes.** That number is your recovery time
objective, measured rather than assumed, and it is the single most useful thing
this rehearsal produces.

### 2. Verify the schema the application actually reads

```bash
psql "$RESTORE_TARGET_URL" -f scripts/verify-migrate.sql
```

This is the existing read-only check. Every row must report present. An
`ABSENT` row means the backup predates a migration, which is exactly the
discovery worth making now rather than during an outage.

### 3. Verify the data is coherent, not merely present

```sql
-- Row counts on the tables that matter. Compare against production's own
-- counts, which you read separately — do not copy production data here to
-- compare it.
SELECT 'users' AS t, count(*) FROM users
UNION ALL SELECT 'transactions', count(*) FROM transactions
UNION ALL SELECT 'ledger_entries', count(*) FROM ledger_entries
UNION ALL SELECT 'transfer_intents', count(*) FROM transfer_intents
UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs;

-- Money columns must be NUMERIC, not float. A restore that silently brought
-- back float4 balances would be a corrupt recovery that looks fine.
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name IN ('balance_cad','balance_usd','amount','total_amount')
ORDER BY table_name, column_name;

-- The ledger should still reconcile against balances. This is the financial
-- invariant; a restore that breaks it is not a usable recovery.
-- Run the same check the cron route runs: lib/internal-reconciliation.ts
```

### 4. Run the application's own test suite against the restore

```bash
DATABASE_URL="$RESTORE_TARGET_URL" pnpm test
```

This is also the **grant enumeration** that decision 0005 Phase 4 depends on.
A fresh database built by `initializeSchema()` cannot reproduce a missing
`GRANT` on a pre-existing object; a restored copy can. Any permission failure
here is a grant the Phase 4 list is missing — and 0005 states plainly that its
grant list was derived from reading the schema, not from watching the
application fail, so expect additions.

### 5. Destroy the restore target

Delete it. It contains real customer data and has served its purpose. Record
that you deleted it, and when.

## What to record afterwards

Append to `PROJECT_MEMORY.md`, and update the Phase 0 row in
`scripts/status/readiness.json` from NOT RUN to VERIFIED **only if all of these
hold**:

| Finding | Why it matters |
|---|---|
| Restore completed, and how long it took | This is the measured RTO |
| `verify-migrate.sql` reported no ABSENT objects | The backup is current with the code |
| Row counts plausible against production | The backup is not truncated |
| Money columns are NUMERIC | The restore is not silently corrupt |
| Ledger reconciliation passes | The financial invariant survived |
| Test suite result, and every permission failure seen | These are the Phase 4 grants |
| Restore target destroyed | No stray copy of customer data |

If any row fails, Phase 0 stays **NOT RUN** and the failure is the next
engineering task. A partial pass is not a pass: the purpose of this exercise is
to find out whether recovery works, and "mostly" is not an answer anyone wants
to discover they relied on.
