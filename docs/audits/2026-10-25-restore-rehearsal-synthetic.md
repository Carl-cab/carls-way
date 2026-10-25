# Audit — Phase 0 restore rehearsal, executed against synthetic data

**Date:** 2026-10-25
**Base:** `master` at `6927ebd`
**Scope:** decision 0005 Phase 0; `docs/runbooks/backup-restore-rehearsal.md`

## What this is, and what it is not

Every command in the Phase 0 runbook had been written without ever being run,
because running it needs a production backup and an owner-provisioned target.
This audit ran the whole procedure against a **synthetic** source database, so
the commands and — more importantly — the *verification steps* could be proven
to work.

**This is not a production rehearsal.** No customer data, no production
credential, no production host. Phase 0 therefore remains **NOT RUN**. What is
now established is narrower and still worth having: the runbook's procedure
executes, and each of its checks detects the failure it claims to detect.

A verification step that cannot fail is decoration, so the negative cases below
are the substance of this audit rather than an appendix to it.

## Environment

Local PostgreSQL 16.15, two throwaway databases per run, destroyed afterwards.
Source built from `lib/__tests__/helpers/test-schema.sql` plus
`scripts/restore-rehearsal-synthetic.sql`.

## Positive case

| Step | Command | Result |
|---|---|---|
| 1 | `pg_dump --format=custom` then `pg_restore --no-owner --no-privileges` | exit **0**, **0** stderr lines, **0.20 s** |
| 2 | `psql -f scripts/verify-migrate.sql` | **0** rows reading `MISSING` or `ABSENT` |
| 3a | row counts, source vs target | identical: `users=7 tx=1 ledger=6 audit=1` |
| 3b | `psql -f scripts/reconciliation-check.sql` | **7/7 `PASS`** |
| 4 | `DATABASE_URL=<target> pnpm test` | **58 files / 836 tests passing** |
| 5 | drop both databases and the probe role | 0 rehearsal databases, 0 probe roles remain |

The dataset is deliberately the smallest one that satisfies the invariants
**non-trivially** — an empty database passes all seven checks vacuously. It has
one completed internal payment (99001 → 99002, 25 CAD) with both ledger legs
and opening balances, so each wallet column equals that user's own ledger
entries, per-currency debits equal credits, and the per-payment checks have a
payment to examine.

**Restore duration is 0.20 s on a trivial dataset and is not a usable input to
a production RTO.** It measures the restore step alone, at a data volume
nothing like production's. Recorded for method, not for capacity planning.

## Negative cases — do the checks actually catch a bad restore?

| Injected fault | Step that should catch it | Result |
|---|---|---|
| `ALTER TABLE transactions DROP COLUMN correlation_id` | 2 | **caught** — `transactions.correlation_id │ MISSING` |
| receiver credited 20.00 against a 25.00 payment (the "unequal legs" case the runbook describes) | 3b | **caught** — 3 of 7 checks `FAIL`: `internal_ledger_currency_debits_equal_credits`, `internal_payment_amounts_match_ledger`, `user_wallets_exactly_match_ledger` |
| privilege probe with **no** grants applied | 4 (grants) | **114** unreachable rows (20 tables × 4 privileges + 17 sequences × 2) |
| privilege probe with the full application grant set | 4 (grants) | **0** unreachable rows |

The last two matter together: a probe that returns 0 is only meaningful if it
can return non-zero, and it does.

## Findings

### 1. The runbook told operators to look for the wrong word — corrected here

Step 2's pass criterion read *"Every row must report present. An `ABSENT` row
means the backup predates a migration"*, and the record table said
*"`verify-migrate.sql` reported no ABSENT objects"*.

`scripts/verify-migrate.sql` emits **two** words. Sections 1-4 (tables,
columns, upsert indexes) report `MISSING`; only section 5 (money column types)
reports `ABSENT`. So a dropped table, column or index is invisible to an
operator checking for `ABSENT`.

This is not hypothetical: the first negative case above was initially scored as
*"the check failed to detect a dropped column"* because the measurement grepped
for `absent` and found none. The script was right and the measurement was
wrong — and an operator following the runbook literally would make the
mirror-image error during an incident, concluding a damaged restore was clean.

Corrected to require every row to read `OK`, with the two failure words
tabulated and a counting command that catches both.

### 2. `users.balance` diverges across the three schema sources

| Source | `users.balance` |
|---|---|
| `scripts/verify-migrate.sql:106` | **requires** present |
| `lib/db.ts:82` (`initializeSchema()`) | **creates** `NUMERIC(14,2) DEFAULT 100.00` |
| `lib/__tests__/helpers/test-schema.sql` | **absent** |

`lib/__tests__/schema-source-parity.test.ts` compares the migrate route against
`initializeSchema()` only, so nothing flags the fixture direction.

**Deliberately not "fixed".** The omission may be protective: `CLAUDE.md`
forbids new code touching the legacy column, and a fixture without it makes any
such read fail loudly in CI with `42703`. Adding it would remove that signal.
Recorded as a judgement call for the owner, not changed. The rehearsal adds the
column to its own source database only, because a restore rehearsal should
exercise a production-shaped schema.

### 3. Step 4 will fail against a real restore that carries audit history

`audit_logs.user_id INTEGER REFERENCES users(id)` has no `ON DELETE` clause, so
it restricts. **23 test files run `DELETE FROM users`** with hard-coded ids in
the 9001-9807 band.

Observed: one synthetic `audit_logs` row referencing user `9501` made
`stripe-settlement.test.ts` fail with
`update or delete on table "users" violates foreign key constraint
"audit_logs_user_id_fkey"` — because that file's `USER_ID` is also `9501`. In
this audit that was an id collision of the rehearsal's own making, fixed by
moving the synthetic ids to `99001+`.

**The general hazard is real and is not fixed.** Production user ids increment
from 1, so once the table passes roughly 9000 users the test suite's fixed ids
overlap live ones. A restore whose `audit_logs` reference any user in that band
will fail step 4 with an FK error that reads like *the application is
incompatible with the backup*, when it is the test harness assuming it may
delete users it did not create. An operator should expect this and not
misdiagnose it. No code change proposed here — the options (renumber test ids,
or `ON DELETE` behaviour on an audit table) both deserve their own review, and
changing an audit-table FK is not a thing to slip into a rehearsal.

### 4. The test fixture's own seeds do not reconcile — correctly

`splitpayera` and `splitpayerb` are seeded at `balance_cad = 500.00` with no
ledger entries, so `user_wallets_exactly_match_ledger` reports 2 discrepancies
against an unmodified fixture-built database. That is right for a
split-payment test, which has no interest in the ledger, and wrong for anything
used as a reconciliation source.

Worth knowing because it was found *before* any fault was injected: the check
caught an inconsistency nobody planted, which is the strongest evidence in this
audit that step 3b works. It also vindicates the runbook's existing
instruction — *"If any row reports `FAIL`, confirm whether the same discrepancy
exists in production before concluding the restore caused it"*.

## Status after this audit

| Item | Status |
|---|---|
| Runbook procedure executes as written | **VERIFIED** (synthetic) |
| Each verification step detects its failure mode | **VERIFIED** (synthetic, negative cases above) |
| Phase 0 production backup/restore rehearsal | **NOT RUN** — requires owner action |
| Recovery point / backup availability | **NOT RUN** — no production backup inspected |
| Production restore duration | **NOT RUN** — 0.20 s here is not transferable |
| Table ownership and privileges in production | **NOT RUN** — probe exercised on synthetic target only |
