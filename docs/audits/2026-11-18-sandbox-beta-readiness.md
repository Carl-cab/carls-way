# Sandbox beta readiness — command-level audit

**Date:** 2026-11-18
**Baseline:** `master` at `55c8cee`, working branch `fix/sandbox-beta-blockers`
**Method:** built the application, ran it against an isolated local PostgreSQL
database seeded from `lib/__tests__/helpers/test-schema.sql`, and used it —
HTTP against the real routes, then a real browser. Plus a backup/restore
rehearsal with the repository's own verification scripts.
**Immutable.** Later findings go in a new audit or a marked addendum.

Live rails were off throughout (`PLAID_TRANSFER_LIVE` and `CA_EFT_LIVE`
unset/false, `MANNA_ENV=sandbox`). No production credential, database or
configuration was touched. `POST /api/migrate` was NOT run against production.

---

## Summary

Six defects, four of them user-visible 500s in the primary workflows, found
against a suite that was **68 files / 977 tests, all green**. Every one was
found by running the application rather than reading it.

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `users.province` missing from 2 of 3 schema sources → **registration 500** | **Blocker** | Fixed |
| 2 | `users.balance` missing from fixture → `GET /api/me` 500 | **Blocker** | Fixed |
| 3 | `transactions.fx_rate` / `estimated_settlement` missing from fixture → **send money 500**, feed 500 | **Blocker** | Fixed |
| 4 | Failed password-reset email is completely silent | **High** | Fixed |
| 5 | `backfillOpeningBalances()` corrupts the ledger for any user with activity | **High** | Reported, not fixed |
| 6 | Split payments permanently fail two reconciliation invariants | **High** | Reported, not fixed |

Plus: registration seed balances are never booked to the ledger (medium), 31
of 36 form labels have no programmatic association (medium), sandbox funding
and cash-out are unbounded (known gap, now measured).

---

## 1–3. The schema-source gap (BLOCKER, fixed)

### What happened

Built the app, pointed it at a fixture-built database, registered a user:

```
POST /api/auth/register
  -> 500 {"error":"Internal server error"}
  server log: column "province" of relation "users" does not exist   (42703)
```

Then, one at a time as each was cleared:

```
GET  /api/me            -> 500  column "balance" does not exist
GET  /api/feed          -> 500  column t.estimated_settlement does not exist
POST /api/transactions  -> 500  column "fx_rate" of relation "transactions" does not exist
```

Registration, profile, the social feed and **sending money** — four of the
workflows this sprint has to demonstrate.

### Why 977 passing tests did not catch it

`province` and `balance` are declared **only** inside `initializeSchema()`'s
`CREATE TABLE users` body in `lib/db.ts`. Each existing guard misses that for
its own reason, and all three were working as designed:

| Guard | Why it could not see this |
|---|---|
| `schema-source-parity.test.ts` | Compares the **migrate route's** objects against a db.ts-built database. One direction, deliberately. A column in db.ts and not the route is invisible from there. |
| `migrate-route-execution.test.ts` | Executes the migrate route's statements. There was no `province` statement to execute. |
| `verify-migrate.sql` | A hand-maintained list. `province` was not on it. |

CLAUDE.md already warned about this blind spot in as many words. The gap was
that **nothing ran the reader**.

### The full extent, measured rather than guessed

After fixing them one at a time proved to be the wrong method, the whole
schema was diffed instead — a database built from the fixture against one
built by `initializeSchema()`. Result: **4 missing tables and 24 missing
columns.**

- Tables: `admin_roles`, `admin_permissions`, `role_permissions`,
  `transfer_recovery_flags`
- Columns beyond those tables: `users.province`, `users.balance`,
  `users.kyc_provider`, `users.kyc_session_id`, `users.kyc_verified_at`,
  `users.kyc_rejection_reason`, `users.locked_until`, `users.last_login_at`,
  `transactions.fx_rate`, `transactions.fx_fee`,
  `transactions.estimated_settlement`, `bank_accounts.relink_required`,
  `bank_accounts.updated_at`

The missing admin RBAC tables meant permission checks (`exceptions:manage`,
the gate on the Redis-verification and ledger-backfill routes) could not be
exercised against a real database at all.

### Fix

- `app/api/migrate/route.ts`: `province`, `balance`
- `lib/__tests__/helpers/test-schema.sql`: all of the above
- `scripts/verify-migrate.sql`: `province`
- `lib/__tests__/registration-schema.test.ts` (6 cases) — runs the real route
- `lib/__tests__/fixture-schema-parity.test.ts` (4 cases) — **the missing
  third direction**: `initializeSchema() ∪ migrate route ⊆ fixture`

Production is **not** broken by #1: the live `users` table has `province`
because `initializeSchema()` created it. What the missing ALTER breaks is any
database **rebuilt** from the migrate route — a restore target, a new
environment, a Preview database. That is a provisioning and recovery hazard,
and it lands directly on this sprint's isolated-Preview work.

Mutation-checked: deleting the `province` line from the fixture alone fails 4
of the 6 registration cases, naming the column and all three sources.

---

## 4. Silent password-reset email failure (HIGH, fixed)

`resend.emails.send()` resolves to `{ data, error: null } | { data: null,
error }` — read off resend@6's own `Response<T>` type, not inferred. It does
**not** throw. `lib/email.ts` discarded the result.

`POST /api/auth/forgot-password` wraps the call in `try/catch` that logs, then
returns `{ success: true }` unconditionally — correctly, because revealing
whether an address exists is account enumeration. Combined:

- the SDK did not throw, so the catch never ran and nothing was logged
- the route answered `{"success": true}`
- a `password_reset_tokens` row was created
- no email was sent

Measured against an invalid key: route answered 200, server log contained
**zero** occurrences of its own "Password reset email error".

Direct probe of the SDK, which makes it worse than an API-rejection problem:

```
RESOLVED: {"data":null,"error":{"name":"application_error",
  "message":"Unable to fetch data. The request could not be resolved."}}
```

A total **network failure** also resolves quietly. So an outage at the email
provider is as silent as a bad key.

Reachable in a correct deployment: `invalid_from_address` is what Resend
answers when `EMAIL_FROM` is not on a verified sending domain.

**Fix:** check `result.error` and throw, which makes the caller's existing
catch mean something. The enumeration-resistant response is unchanged. After
the fix, same request:

```
Password reset email error: {
  message: 'Resend rejected the password-reset email: application_error — ...'
```

`lib/__tests__/email-send-failure.test.ts`, 5 cases. Mutation-checked:
disabling the error check fails 3 of 5.

---

## 5. `backfillOpeningBalances()` corrupts an active user's ledger (HIGH, reported)

`lib/ledger.ts:330` credits **`u.balance_cad`** — the user's *current*
balance — as an `opening_balance` entry, for any user lacking one. For a user
who has transacted, that books their entire history a second time.

Measured on the restored sandbox database:

| | wallet | ledger | discrepancy |
|---|---|---|---|
| alice, before backfill | 1370.00 | 1270.00 | **+100.00** |
| alice, after backfill | 1370.00 | 2640.00 | **−1270.00** |

The discrepancy went from +100 to −1270 — **twelve times worse, in the
opposite direction.**

**The trap is that it looks like it helped.** Aggregate
`user_wallets_exactly_match_ledger` violations went **6 → 3**, because the
three inactive fixture users were corrected properly. An operator reading the
count would conclude the operation worked.

It is reachable: `POST /api/admin/ledger/backfill-opening-balances`, gated on
`BACKFILL_SECRET` + `exceptions:manage` — i.e. designed to be run by an
operator — with no guard restricting it to users with no activity.

**Not fixed here.** It writes to the ledger, so the correct behaviour is a
financial decision: book the *original seed* (needs a source of truth for it),
restrict the operation to users with no other entries, or retire it. Owner's
call.

---

## 6. Split payments permanently fail two reconciliation invariants (HIGH, reported)

`scripts/reconciliation-check.sql` on the restored sandbox database:

```
internal_payment_amounts_match_ledger        3 in scope, 1 violation, FAIL
payer_recipient_direction_currency_and_type  3 in scope, 1 violation, FAIL
user_wallets_exactly_match_ledger           26 in scope, 6 violations, FAIL
```

CLAUDE.md requires all seven rows to report PASS.

The violating payment, isolated:

```
id | type    | amount | ledger entries
 1 | pay     |  25.00 | payment_sent:25/0   payment_received:0/25
 3 | payment |  15.00 | payment_sent:15/0   payment_received:0/15
 5 | payment |  30.00 | split_payment:30/0  split_payment:0/30
```

Transaction 5 is a **split payment**. It is in reconciliation scope
(`payment_rail='internal'`, `type='payment'`, `status='completed'`), but its
ledger entries carry `entry_type='split_payment'`, and both invariants count
only `payment_sent` / `payment_received`. So
`valid_sender_debit_count = 0 ≠ 1` and `sender_debit_total = 0 ≠ 30.00`.

**The ledger itself is correct** — 30.00 debited from the payer, 30.00
credited to the creator, right users, right currency, balanced. This is not a
money error. It is a **false-alarm generator**, and that is why it matters:
`money:split-pay` is a live user-facing feature, so the daily reconciliation
cron reports FAIL forever, and an operator cannot distinguish a real
discrepancy from routine split usage. A control that always fails is not a
control.

`lib/__tests__/reconciliation-sql-parity.test.ts` requires the SQL file and
`lib/internal-reconciliation.ts` to agree, and it passes — so the cron
behaves the same way.

**Not fixed here.** Both candidate fixes change what a financial invariant
asserts: widen the checks to recognise `split_payment`, or make
`paySplitPortion()` write `payment_sent`/`payment_received`. Either must be
applied to **both** sources together. Owner's call.

### 6b. Registration seed balances are never booked (MEDIUM, reported)

The remaining `user_wallets_exactly_match_ledger` violations:

```
 9133 alicesandbox  wallet 1370.00  ledger 1270.00  diff +100.00
 9135 carolsandbox  wallet  170.00  ledger   70.00  diff +100.00
```

Exactly the CA$100 registration grant. `app/api/auth/register/route.ts` writes
it straight into `balance_cad`/`balance_usd` with no ledger entry, so **every
registered user's wallet is permanently out of step with their ledger by their
seed amount**. (Users 9102/9103/9112 at 500.00 with no ledger are CI-fixture
seed rows, not an application defect.)

The repository's intended remedy is `backfillOpeningBalances()` — which is
finding 5.

---

## What works correctly, verified

Worth recording with the same rigour as the failures.

**Money movement and its invariants.** A CA$25 send: payer 100.00 → 75.00,
recipient 100.00 → 125.00, a balanced ledger pair
(`payment_sent` 25 debit / `payment_received` 25 credit), and velocity
consumed on all three windows **for the payer only**, in CAD.

**Velocity, end to end.** After send + cross-border + request-accept +
split-pay: hourly total 80.00 across 4 transactions, payer only. Split
payments consume budget (decision 0008 working). Funding consumed **nothing**
— confirming the transfer rail writes no velocity, as documented.

**Cross-border FX with provenance.** CA$10 → US$7.29 at 0.7326. The Wise key
was synthetic, so the hardcoded fallback served it — and that is recorded
properly: `fx_rate_resolved` with `provider: fallback`, plus a dedicated
`fx_rate_fallback_used` audit event. Good design, working.

**Audit metadata is real jsonb.** `jsonb_typeof(metadata) = 'object'` on every
row, and `metadata->>'provider'` returns `fallback` — the jsonb fix holds.

**Authorization and failure paths.** Unauthenticated `/feed` → 307. Wrong
password → 401. Insufficient balance → 400. Self-send → refused. Unknown
recipient → 404. Negative amount → rejected by `parsePositiveMoney`. Another
user's private transaction → 404 (not 403, correctly not confirming it
exists). Logout invalidates the session: `/api/me` → 401. Double split
payment → **409 `ALREADY_PAID`**, idempotent.

**KYC and rail gates.** Funding intent without KYC → "KYC verification
required". Without a linked encrypted bank account → 403. A CA user's consent
language says "Canadian EFT" and never ACH.

**Backup and restore.** `pg_dump -Fc` → `pg_restore` into an isolated target:
0 errors, exact parity (13 users, 5 transactions, 14 ledger entries,
sum(balance_cad) 3040.00 on both). `verify-migrate.sql` on the restore target:
**0 non-OK rows**.

**Browser, desktop and mobile.** 16 of 18 checks pass. All five mobile pages
render at iPhone-13 width with **no horizontal overflow** (scrollWidth 390 =
clientWidth 390) and no page errors.

---

## The sandbox funding gap, now measured

Previously recorded as "the transfer rail consumes no velocity budget". It is
now a number.

A single verified user funded their wallet repeatedly:

```
+50   settled   balance 70
+100  settled   balance 170
+200  settled   balance 370
+500  settled   balance 870
+1000 settled   balance 1870
```

**CA$1,850 across 5 confirmations** against decision 0013's approved
**CA$100 cumulative** ceiling — 18.5× over, with no control anywhere, and the
P2P velocity counter untouched throughout.

Sandbox **cash-out**, which 0013 requires disabled, is fully reachable:
`cash_out` of CA$500 settled and debited the balance.

Neither is a regression. Both are the documented open gaps, now with evidence
attached instead of a description.

---

## Environment constraints on this audit

- **Plaid Link and Stripe.js cannot load here.** The pages request
  `cdn.plaid.com/link/v2/stable/link-initialize.js` and
  `js.stripe.com/dahlia/stripe.js`; both answer `ERR_TUNNEL_CONNECTION_FAILED`
  through this environment's egress proxy. So **bank linking was not
  exercised** — a synthetic `bank_accounts` row was inserted directly to reach
  the funding flow behind it. There is no simulated linking path in the
  application, so a beta participant cannot link an account without working
  Plaid sandbox credentials.
- `POST /api/plaid/create-link-token` answers **500** with synthetic
  credentials. A configuration failure arguably deserves 503; minor, not filed
  as a defect.
- Vercel remains unreachable (`403 CONNECT`), so nothing here is evidence
  about production.
- `next build` aborts once per cache with `SecurityFatalError` naming a
  Next.js advisory, and succeeds on retry. `pnpm audit --prod` reports **2
  moderate** advisories against `next@16.4.3`, patched in `>=16.4.5` —
  including a cache-leak across root param values. CI's dependency-audit job
  passes, so it does not gate on moderate.

## Two of my own verification steps were wrong, recorded

Both produced a wrong intermediate conclusion that further work corrected.

1. A `psql ... | head -3` pipeline killed `psql` with SIGPIPE partway through
   the fixture, leaving a half-built database. I briefly read that as the
   fixture failing to apply. It applies cleanly.
2. `pkill -f "next start"` did not match the running process, which is named
   `next-server`. The old build kept port 3000, the new server failed to bind
   with `EADDRINUSE`, and I tested the pre-fix binary and read the absence of
   a log line as the fix not working. It works.

Recorded because an audit that hides its own false starts is not evidence.
