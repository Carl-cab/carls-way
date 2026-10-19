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
5. **Note which role `RESTORE_TARGET_URL` connects as.** Every command in this
   runbook uses it, and every one of them is an **owner-role** operation:
   `pg_restore`, `verify-migrate.sql`, the data checks, the test suite and the
   privilege enumeration. There is deliberately no second, application-role
   connection string, because with the grant check in step 4 nothing here
   needs one — see the note there.

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

The ledger must still reconcile against balances. These are the financial
invariants: a restore that breaks one is not a usable recovery.

`lib/internal-reconciliation.ts` has **no CLI entry point** — it is called by
`/api/cron/internal-reconciliation`, which needs the application running and
`CRON_SECRET`, and must not be pointed at this target. So run the committed
query file, which is the same query the application runs:

```bash
psql "$RESTORE_TARGET_URL" -f scripts/reconciliation-check.sql
```

**Every row must report `PASS`.** All seven, not a subset.

Two earlier versions of this runbook got this wrong in the same way, and the
reasons are worth keeping because they are easy to repeat:

- The first ran `user_wallets_exactly_match_ledger` alone and called it "its
  strongest check". But the two *aggregate* checks differ in scope and
  comparison — one compares each user's balance against that user's own wallet
  entries, the other compares aggregate debits against credits per currency on
  completed internal payments — so neither implies the other. A payment with
  unequal legs in one currency (sender debited 100 CAD, recipient credited
  95 CAD) leaves every balance agreeing with its own entries while the
  per-currency totals are 100 against 95.
- The second ran both aggregate checks and made only those two required,
  treating the five transaction-level checks as optional follow-up. **That is
  also unsound, because errors cancel in aggregates.** Two payments off by
  +5 and -5 leave the currency totals equal and every wallet matching its own
  entries, while `internal_payment_amounts_match_ledger` fails on both. An
  aggregate check passing is not evidence that the per-payment checks pass.

One caveat on reading the output, so nobody over-reports it:
`completed_internal_payments_in_scope` is a **scope counter**, not an
invariant — its status is the literal `'PASS'` in both implementations. Seven
`PASS` rows mean six invariants held and one count was reported. Do not cite
it as a seventh passing check.

The file is read-only, takes no parameters, and compares NUMERIC values
directly as the application does, with no tolerance. It is a second source of
the application's query, so
`lib/__tests__/reconciliation-sql-parity.test.ts` runs both against one
database and requires identical names, counts and statuses — including a case
that tampers with the file and asserts the comparison notices. That is what
makes "the same query the application runs" a checked claim rather than an
assurance.

If any row reports `FAIL`, confirm whether the same discrepancy exists in
production before concluding the restore caused it.

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

**And the test suite cannot be repurposed as the grant check either.** 32 of
the 55 test files perform DDL — many call `initializeSchema()` directly — so
running the suite as a least-privilege role fails on `CREATE TABLE` long before
it reaches the DML the application actually performs at runtime. Those failures
are artifacts of the harness building its own fixtures, not missing grants, and
they would bury the signal. A role that can pass this suite is a role that can
create and drop tables, which is the opposite of what Phase 4 is for.

So enumerate the grants directly, with no DDL and no application run.
`has_table_privilege` and `has_sequence_privilege` answer exactly the question
Phase 4 asks — can the application's role do what it needs on every object —
and they answer it deterministically:

```bash
# 1. As the restore target's owner, create a role standing in for the
#    application's future least-privilege role, then apply ONLY the grants
#    decision 0005 Phase 4 proposes. `GRANT ... ON DATABASE` needs a literal
#    identifier, so name the database rather than calling current_database().
psql "$RESTORE_TARGET_URL" <<SQL
CREATE ROLE manna_app_probe NOLOGIN;
GRANT CONNECT ON DATABASE "$RESTORE_TARGET_DB" TO manna_app_probe;
GRANT USAGE ON SCHEMA public TO manna_app_probe;
-- ... then paste the Phase 4 grant list here, unmodified ...
SQL

# 2. Report every object the role cannot reach. Rows returned are the grants
#    the Phase 4 list is missing. No rows is a pass.
psql "$RESTORE_TARGET_URL" <<'SQL'
SELECT c.relname AS object, 'table' AS kind, p.priv
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS p(priv)
WHERE c.relkind = 'r'
  AND NOT has_table_privilege('manna_app_probe', c.oid, p.priv)
UNION ALL
SELECT c.relname, 'sequence', p.priv
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
CROSS JOIN (VALUES ('USAGE'),('SELECT')) AS p(priv)
WHERE c.relkind = 'S'
  AND NOT has_sequence_privilege('manna_app_probe', c.oid, p.priv)
ORDER BY 2, 1, 3;
SQL
```

The role is `NOLOGIN` deliberately. `has_table_privilege` and
`has_sequence_privilege` are evaluated *by the owner's connection, about
another role*, so no second connection string and no second credential is
needed — which is why this runbook has one `RESTORE_TARGET_URL` rather than an
owner URL and an application URL.

**What this check does not cover.** It reads ACLs on tables and sequences. It
does not prove the application *works* under only those grants: `EXECUTE` on a
function, privileges a trigger needs, or anything beyond table and sequence
DML would not appear here. Closing that gap means connecting as the role and
exercising real queries, and the test suite cannot stand in for that for the
DDL reason above. Treat a clean result as "the ACLs in the Phase 4 list are
present", not "the application runs least-privilege" — those are different
claims and only the first is measured here.

**That gap is Phase 4's to close, and it is open.** Verifying the application
actually runs under the grant list needs a connection as a non-owner role plus
a **permission-focused query set that performs only DML** — no `initializeSchema()`,
no `CREATE TABLE`. No such set exists in this repository today; the test suite
is the wrong instrument because 32 of its 56 files perform DDL. Building it
belongs with decision 0005 Phase 4, where the grant list is applied for real,
not with this rehearsal, which is read-only with respect to roles. Recorded
here so it is an open task rather than a caveat someone reads as "handled":

- [ ] **Phase 4 prerequisite:** a DML-only permission probe, run as the
      application role against a restored copy, covering every table the
      application reads and writes plus the functions and triggers it relies
      on. Until it exists, "least-privilege works" is unverified.

**Measured, on a database built from this repository's schema sources.** With
table grants applied via `GRANT ... ON ALL TABLES` and no sequence grants at
all, the query returns **40 rows covering all 20 `_id_seq` sequences** — by
name, in one result, instead of making you hit `permission denied for sequence`
one insert at a time. That is the omission to expect first: the grant list in
0005 was derived from reading the schema, not from watching the application
fail, so `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public` is load-bearing
and easy to leave out.

`CREATE ROLE` is a cluster-level change: do it on the restore target's cluster
only, never production's, and `DROP ROLE manna_app_probe` when you destroy the
target.

**Audit tables are the deliberate exception.** The Phase 4 list grants the
application `INSERT` but not `UPDATE` or `DELETE` on `audit_logs` and
`admin_audit_logs`, so exactly these four rows *should* appear in the output —
confirmed in the same measurement:

```
 admin_audit_logs | table | DELETE
 admin_audit_logs | table | UPDATE
 audit_logs       | table | DELETE
 audit_logs       | table | UPDATE
```

They are the control working, not a gap. Note them as expected rather than
"fixing" them — granting them back is precisely what decision 0004 exists to
prevent.

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
| **All seven** rows from `scripts/reconciliation-check.sql` report `PASS` — paste the output | The financial invariants survived. Aggregate and per-payment checks fail independently, and errors cancel in aggregates, so a subset is not evidence |
| Test suite result as the **owner** role | The application's SQL matches the restored schema. Not a grant check — the suite performs DDL |
| Output of the `has_table_privilege` / `has_sequence_privilege` query, with the expected audit-table rows marked as such | These are the Phase 4 grants; neither the owner run nor the suite can produce them. Covers table and sequence ACLs only — not function or trigger privileges |
| Restore target destroyed, and `manna_app_probe` dropped | No stray copy of customer data, no leftover role |

If any row fails, Phase 0 stays **NOT RUN** and the failure is the next
engineering task. A partial pass is not a pass: the purpose of this exercise is
to find out whether recovery works, and "mostly" is not an answer anyone wants
to discover they relied on.
