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

**Record the wall-clock time this takes.** It is *one input* to a recovery time
objective, not the objective itself. An RTO is a target you commit to; this
measurement is the restore step alone, and the real elapsed time during an
incident also includes detecting the problem, deciding to restore, provisioning
a target, repointing `DATABASE_URL`, redeploying and verifying. Treating the
restore duration as the RTO understates recovery by however long those take —
so record it as "restore duration", and set an RTO only once the other steps
have been timed too.

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

-- Money columns: already covered by step 2. `scripts/verify-migrate.sql`
-- section 5 checks users.balance, balance_cad, balance_usd,
-- transactions.amount, sender_amount, receiver_amount and
-- transfer_intents.amount, driven from a VALUES list so a column that is
-- ABSENT reports ABSENT instead of dropping out of the result set. An
-- `information_schema` query written here would be a weaker duplicate —
-- it matched on column_name alone, so it missed `users.balance`,
-- `transactions.sender_amount` and `transactions.receiver_amount`, and
-- read clean on a column that was gone.
```

The ledger must still reconcile against balances. This is the financial
invariant: a restore that breaks it is not a usable recovery.
`lib/internal-reconciliation.ts` has **no CLI entry point** — it is called by
`/api/cron/internal-reconciliation`, which needs the application running and
`CRON_SECRET`, and must not be pointed at this target. Run its strongest check,
`user_wallets_exactly_match_ledger`, directly instead. Every row returned is a
discrepancy; no rows is a pass:

```bash
psql "$RESTORE_TARGET_URL" <<'SQL'
WITH wallets AS (
  SELECT u.id AS user_id, 'CAD' AS currency, u.balance_cad AS wallet_balance,
         COALESCE(SUM(le.credit - le.debit) FILTER (
           WHERE le.currency = 'CAD' AND le.account_type = 'wallet'), 0) AS ledger_balance
  FROM users u LEFT JOIN ledger_entries le ON le.user_id = u.id
  GROUP BY u.id, u.balance_cad
  UNION ALL
  SELECT u.id, 'USD', u.balance_usd,
         COALESCE(SUM(le.credit - le.debit) FILTER (
           WHERE le.currency = 'USD' AND le.account_type = 'wallet'), 0)
  FROM users u LEFT JOIN ledger_entries le ON le.user_id = u.id
  GROUP BY u.id, u.balance_usd
)
SELECT user_id, currency, wallet_balance, ledger_balance
FROM wallets
WHERE wallet_balance IS DISTINCT FROM ledger_balance;
SQL
```

Compare NUMERIC values directly, as the application does — no tolerance. If
rows come back, confirm whether the same discrepancy exists in production
before concluding the restore caused it.

### 4. Run the application's own test suite against the restore

```bash
DATABASE_URL="$RESTORE_TARGET_URL" pnpm test
```

That confirms the application's SQL matches the restored schema.

**It does not enumerate grants, and an earlier version of this runbook claimed
it did.** `pg_restore --no-owner` makes the *restoring* role the owner of every
restored object, and an owner holds all privileges implicitly — so the suite
would pass with no `GRANT` statements present at all, and report a clean
grant list that is in fact empty. The same "ownership implies everything" fact
that decision 0005 Phase 4 is built around invalidates using the owner's own
connection as the test.

To actually enumerate grants, connect as a role that owns nothing:

```bash
# As the restore target's owner, create a non-owner role standing in for the
# application's future least-privilege role, and grant it nothing beyond
# schema usage.
# `GRANT ... ON DATABASE` needs a literal identifier, so name the restore
# target's database explicitly rather than calling current_database().
psql "$RESTORE_TARGET_URL" <<SQL
CREATE ROLE manna_app_probe LOGIN PASSWORD '$(openssl rand -hex 16)';
GRANT CONNECT ON DATABASE "$RESTORE_TARGET_DB" TO manna_app_probe;
GRANT USAGE ON SCHEMA public TO manna_app_probe;
SQL

# Then apply ONLY the grant list decision 0005 Phase 4 proposes, and run the
# suite as that role. Every permission failure is a grant the list is missing.
DATABASE_URL="postgres://manna_app_probe:...@<host>/<db>?sslmode=require" pnpm test
```

Two things to expect. The grant list in 0005 was derived from reading the
schema, not from watching the application fail, so additions are likely —
`permission denied for sequence` on every `SERIAL` insert is the usual first
one. And `CREATE ROLE` is a cluster-level change: do it on the restore target's
cluster only, never production's, and drop the role when you destroy the
target.

### 5. Destroy the restore target

Delete it. It contains real customer data and has served its purpose. Record
that you deleted it, and when.

## What to record afterwards

Append to `PROJECT_MEMORY.md`, and update the Phase 0 row in
`scripts/status/readiness.json` from NOT RUN to VERIFIED **only if all of these
hold**:

| Finding | Why it matters |
|---|---|
| Restore completed, and how long it took | Measured restore duration — one input to an RTO, not the RTO |
| `verify-migrate.sql` reported no ABSENT objects | The backup is current with the code |
| Row counts plausible against production | The backup is not truncated |
| Money columns are NUMERIC | The restore is not silently corrupt |
| Ledger reconciliation passes | The financial invariant survived |
| Test suite result as the **owner** role | The application's SQL matches the restored schema |
| Test suite result as the **non-owner probe** role, and every permission failure seen | These are the Phase 4 grants; the owner run cannot produce them |
| Restore target destroyed, and `manna_app_probe` dropped | No stray copy of customer data, no leftover login role |

If any row fails, Phase 0 stays **NOT RUN** and the failure is the next
engineering task. A partial pass is not a pass: the purpose of this exercise is
to find out whether recovery works, and "mostly" is not an answer anyone wants
to discover they relied on.
