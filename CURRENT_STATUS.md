# Manna — Current Status

Last updated: **2026-10-26** — verified against commit `e0f3f0d` on `master`,
the tip after Sprint 1's five pull requests were merged in the authorized
order:

| PR | Subject | Merge SHA |
|---|---|---|
| #69 | `next` bumped to 16.4.3 (three advisories) | `1bc81df` |
| #68 | Every GitHub Action pinned to a commit SHA | `ce7255a` |
| #67 | Redis degradation recovery (cooldown, not a latch) | `a08c82f` |
| #71 | Client identity validation | `0b609f4` |
| #70 | Synthetic backup restore verification | `e0f3f0d` |

Command-level evidence for the preceding baseline:
`docs/audits/2026-10-17-baseline.md`. Sprint 1's restore-rehearsal evidence:
`docs/audits/2026-10-25-restore-rehearsal-synthetic.md`.

Measured on the merged tree, on a database created fresh for the run and with
the CI fixture applied: **61 files / 907 tests** pass, typecheck 0 errors, lint 0
errors / 28 warnings. Earlier baselines on this file: 55 / 778 at `4e63bb9`,
56 / 788 at `42dbba6`, 57 / 821 claimed at `6d8861c`, 57 / 832 at `6927ebd`.

**An earlier header claimed verification against `6d8861c` and "57 files /
821 tests" while `master` had moved on three times (`1d4d783`, `c2859f6`,
`6927ebd`) and the suite had reached 832.** Both numbers were stale in the
direction that invites trust, which is the failure this file has already been
corrected for once. The note is kept because the same drift recurred during
Sprint 1: this header read `6927ebd` / 832 after five merges had moved
`master` five times.

## ⚠ Two things on this list are worse than "unverified"

(Item 1 was partly resolved on 2026-10-26: `master` is fixed, the running
deployment is not yet confirmed. Item 2 is unchanged and is now the
first-order gap.)

**1. `master` CARRIED two unauthenticated remote-code-execution advisories.**
`next@16.3.8` is inside the vulnerable range of three advisories — two
unauthenticated RCE (Image Optimization; `use cache` typed arrays,
GHSA-673q-mjm6-r5xr) and one DoS (GHSA-p3m5-59mp-jv5r) — all patched in
`>=16.4.1`. **PR #69 was merged on 2026-10-26 as `1bc81df`**, and `master`'s
`package.json` and `pnpm-lock.yaml` now both pin `16.4.3` — verified by reading
the merged tree. So `master` is fixed.

**The running deployment is a separate fact and is NOT yet verified.** It serves
whatever its last build produced, and the deployed version cannot be read from
this environment (`403 CONNECT` to both `api.vercel.com` and the deployment
host). Until the Vercel production rebuild from `1bc81df` or later is
confirmed, treat the two unauthenticated RCEs as potentially live on the public
deployment. The same bump also rides on #68, #70, #71 and #72, whose dependency
diff against `master` is now empty.

**2. Nothing watches an unchanged tree.** Both that advisory set and the
`follow-redirects` one five days earlier reached `master` *after* its last
green CI run, and both were found only because an unrelated PR happened to
re-run the audit. Dependabot alerts are named in `ci.yml` as the durable
backstop but have never been confirmed enabled.

**What is NOT verified, stated here because the rest of this file reads as
confirmation:** nothing about the deployment. `api.vercel.com` and the
production host both return `403 CONNECT` from this environment's egress proxy
— re-confirmed 2026-10-26 — so the production SHA, whether `REDIS_URL` or
`CRON_SECRET` is set, whether the cron fires, and deployment health are all
unverified rather than passing.

**Branch protection has since moved to VERIFIED, and this file previously said
the opposite.** It read "`master` is also still `protected: false` with no
rulesets, so none of the six passing CI checks is enforced." That is no longer
true. Read from the rulesets API on 2026-10-26: ruleset `25851827`, *"master CI
and security checks"*, `enforcement: active`, `target: branch`, included ref
`refs/heads/master`, `bypass_actors: []`, and one `required_status_checks` rule
with `strict_required_status_checks_policy: true` requiring exactly the four
contexts — `install · typecheck · lint · test · build`, `dependency audit`,
`secret scan`, `analyze javascript-typescript`. The owner acted; the four
checks are enforced and up-to-date-with-base is required.

Two limits on that, so it is not read as more than it is. The ruleset contains
**only** `required_status_checks` — there is no required-review rule and no
force-push restriction, so a direct push to `master` that passes CI is not
blocked by it. And the **classic** branch-protection API answers `403` to this
environment, so a `protected: false` reading taken from that endpoint reflects
this session's token, not the absence of protection; the ruleset is the
authority.

The header previously read "2026-06-28 (Phase B3.2b Settlement Balance
Executor complete)" while the body had been revised as recently as
2026-10-09 — a stale date on current content, which is the more
misleading of the two failure modes.

---

## What's Working (Production Validated)

- **Auth**: Registration, login, JWT cookie, route guard via `proxy.ts`
  - `JWT_SECRET` now throws in production if unset (no silent dev fallback)
- **Payments**: Send / request / accept / decline — dual-currency (`balance_cad`/`balance_usd`), cross-border FX via Wise, velocity limits, audit logging
- **Transaction receipts**: `/transactions/[id]` — full receipt with status badge, FX breakdown, settlement date, copy-ID button; accessible only to sender/receiver (404 for others); feed and history cards tap to open receipt
- **Activity feed**: Public feed (`/api/feed` returns `privacy='public'` transactions); History page with working `sent / received / pending` filter chips
- **Notifications**: In-app notifications for friend requests, friend accept, payment received, money requested; unread badge in nav; `/notifications` page with mark-one / mark-all-read; click to navigate to related entity; 30-second polling in layout
- **Public receipt view**: Non-parties can see that a transaction is public but cannot access the full receipt; receipt page shows friendly message explaining privacy
- **Password reset**: Secure password reset flow via email; `POST /api/auth/forgot-password` (never reveals user existence), `POST /api/auth/reset-password` (validates token hash, single-use, 1-hour expiry); `/forgot-password` and `/reset-password` pages with full validation; login page has "Forgot password?" link; tokens are hashed (SHA-256) and stored with expiry
- **Friends**: Full approval flow — send request (pending), incoming requests with Accept/Decline, sent requests, accepted friends list; **Send button** beside each accepted friend routes to `/send?to=<username>` with username pre-filled
  - Production validated: accept ✅ decline ✅ self-add blocked ✅ duplicate blocked ✅
- **Bank linking**: Plaid Link flow, token exchange; tokens AES-256-GCM encrypted at rest (`is_token_encrypted = true` set on every new account)
- **KYC**: Stripe Identity session creation, webhook handler updating `kyc_status` server-side, profile KYC card with live states
- **Sandbox transfer readiness**: Production validated 2026-06-26
  - KYC verified gate ✅
  - Plaid sandbox bank linking ✅
  - Encrypted bank account gate (`is_token_encrypted = true`) ✅
  - Add Money button enables when gates pass ✅
  - Cash Out button enables when gates pass ✅
  - `transfer_intents` table live in production (migration applied) ✅
  - No balance changes after intent creation ✅
  - `POST /api/transfers/intent` creates `status='draft'`, `provider=NULL` ✅
  - Velocity limit gate in place (sandbox intents do NOT consume real velocity budget) ✅
  - Audit logging on intent creation and blocked attempts ✅
- **Passive audit ledger** (Phase A1): Non-blocking audit log of all financial events
  - `ledger_entries` table: user_id, transaction_id (nullable), currency, account_type, entry_type, debit/credit, provider, description
  - `lib/ledger.ts`: `createLedgerEntry()`, `createLedgerPair()`, `getLedgerBalance()`, `validateLedgerPair()`, `getUserLedgerEntries()`, `backfillOpeningBalances()`
  - Entries created AFTER send-money balance updates (non-blocking, doesn't block transaction on failure)
  - Same-currency: one pair (debit+credit, same amount); cross-border: two entries (debit in sender currency, credit in receiver currency, amounts differ by FX)
  - `GET /api/ledger` — read-only, auth required, returns user's ledger entries only
  - `GET /api/ledger/balance-check` — compares `balance_cad`/`balance_usd` vs ledger totals (warning-only, no balance mutation)
  - Only for completed `pay` transactions (not requests, intents, failed, or Add Money/Cash Out)
  - Balance_cad/balance_usd remain authoritative source of truth ✅
- **Phase A2 Infrastructure**: Webhook event deduplication and velocity reversal (not yet wired to live providers)
  - `provider_webhook_events` table: id, provider, provider_event_id, event_type, related_provider_reference, raw_payload JSONB, processing_status, processing_error, processed_at, created_at
  - `lib/provider-events.ts`: `recordProviderEvent()`, `hasProcessedProviderEvent()`, `markProviderEventProcessed()`, `markProviderEventFailed()`, `getProviderEvent()`
  - `reverseVelocity()` in `lib/auth.ts`: creates compensating negative velocity records (immutable audit trail), calls `auditLog()`, non-blocking
  - Admin endpoint: `POST /api/admin/ledger/backfill-opening-balances` with BACKFILL_SECRET protection — creates opening_balance ledger entries for users with seed balances
  - All functions marked "Future Use Only" — infrastructure ready for live provider integration
- ✅ **Phase A3 Provider Execution Framework**: Complete provider abstraction and factory pattern
  - `lib/providers/TransferProvider.ts`: Core interface with 7 methods (createIntent, reviewTransfer, confirmTransfer, executeTransfer, cancelTransfer, getTransferStatus, handleWebhookEvent)
  - `lib/providers/TransferProviderFactory.ts`: Central selection logic — US+sandbox→SandboxUS, CA+sandbox→SandboxCA, US+live→Plaid, CA+live→CanadianEFT
  - `SandboxUSProvider` and `SandboxCAProvider` — fully implemented, behavior unchanged, no real API calls
  - `PlaidTransferProvider` and `CanadianEFTProvider` — **implemented, not placeholders.** This line read 'placeholder implementations (throw "Not implemented")', which was stale: measured 2026-10-26 the two files are 604 and 677 lines and contain **zero** occurrences of "Not implemented". Both are gated off by default (`PLAID_TRANSFER_LIVE`, `CA_EFT_LIVE`; any value other than `true`, including unset, selects sandbox), both persist an idempotency key before calling the provider and claim the intent under `SELECT … FOR UPDATE`, and both signal a successful submit by throwing an error carrying `__submitted` after recording `processing` themselves. Neither contains any reference to `balance_cad` or `balance_usd` — verified by grep — so the "no provider may update balances" constraint below holds for the live providers as written, not merely by their being unimplemented
  - **Critical constraint:** No provider may update balances — all balance changes happen ONLY via settlement webhooks
  - All provider selection routed through factory — no provider logic elsewhere in application
- ✅ **Phase A4 Settlement Processor Skeleton**: State machine and settlement event processing structure
  - `lib/settlement/types.ts`: Event types (submitted, authorized, pending, posted, settled, failed, returned, cancelled), outcome objects, transition rules
  - `lib/settlement/settlement-rules.ts`: Valid state transitions, terminal states, processing states, transition validation
  - `lib/settlement/SettlementProcessor.ts`: Core processor with `normalizeProviderEvent()`, `validateSettlementTransition()`, `processSettlementEvent()`, outcome preparation
  - Dev endpoint: `GET /api/dev/settlement-test` runs 6 transition validation tests (valid/invalid/idempotent cases)
  - **Critical constraint:** All methods return structured outcomes, never update balances, never create ledger entries, never call providers
  - Skeleton ready for Phase B1 (webhook handlers will use this processor to validate and prepare settlement events)
- ✅ **Phase B1 Webhook Receiver Framework**: Safe webhook intake with signature verification and idempotency
  - `POST /api/webhooks/plaid`: Plaid Transfer webhook receiver with HMAC-SHA256 signature verification (TODO: confirm signature format in sandbox), event deduplication via `provider_webhook_events`, stores raw event, marks as processed
  - `POST /api/webhooks/stripe`: Updated to handle financial events (charge.*, payout.*, etc.) while preserving KYC webhook logic (identity.verification_session.*), records events for Phase B2 processing
  - **Security:** No user auth required (webhooks are unauthenticated), raw body used for signatures, no secrets logged, all events returned 200 (prevents webhook retries on transient errors)
  - **Idempotency:** UNIQUE(provider, provider_event_id) enforces single processing per event; duplicate webhook delivery returns 200 immediately without re-processing
  - **Phase B1 scope:** Event intake and storage only — NO balance updates, NO ledger entries, NO settlement logic wired yet
  - Phase B2 will wire SettlementProcessor into webhook handlers to apply settlement side effects
- ✅ **Phase B2 Settlement Orchestrator**: Orchestration layer that plans settlement outcomes without executing them
  - `lib/settlement/SettlementOrchestrator.ts`: `orchestrateSettlement()` queries `transfer_intents`, calls `SettlementProcessor`, produces `SettlementPlan`
  - `SettlementPlan` contains: previousStatus, nextStatus, updateBalance (instructions, not execution), createLedgerEntries (instructions, not execution), notifyUser, reverseVelocity, requiresManualReview, idempotent, reason
  - `planBalanceUpdate()`: Describes Add Money/Cash Out balance changes (currency, amount, operation) but does not execute
  - `planLedgerEntries()`: Describes ledger entries (debit, credit, entryType) but does not create
  - `shouldNotify()`: Determines notification requirement (not sent, just flagged)
  - **Critical constraint:** All planning functions are purely informational — NO balance updates, NO ledger entries, NO notifications sent, NO velocity reversal, NO provider execution
  - Webhook handlers can use this to return settlement plans for Phase B3 execution
  - Phase B3 will implement balance updates, ledger creation, notifications, velocity reversal
- **Schema migration**: `/api/migrate` applied successfully in production — `friends.requested_by`, `friends.updated_at`, `bank_accounts.is_token_encrypted`, all KYC user columns live, `password_reset_tokens` table, `transfer_intents` table, `ledger_entries` table, `provider_webhook_events` table

---

## Security Gates in Place

- `requireEncryptedBankToken(userId, bankAccountId)` in `lib/plaid.ts`:
  - Returns decrypted token only when `is_token_encrypted = true`
  - Throws `RELINK_REQUIRED_MESSAGE` for legacy plaintext rows — callers must surface this to the user
- `kyc_status` can only be set server-side (webhook or create-session); no client path to set it
- Plaid access token never returned to the browser
- `JWT_SECRET` missing in production throws at request time
- Friend accept/decline: server enforces recipient-only authorization (`friend_id = user.userId`)
- Transfer intents: auth → KYC verified → encrypted bank account → velocity check → draft insert only (no money movement)

### CI controls (merged 2026-10-18, PR #57)

- **Secret scanning** — Gitleaks 8.21.2, checksum-verified, scanning full
  history rather than the PR diff. SARIF is sanitised before upload and the
  upload is gated on that sanitisation succeeding.
- **Static analysis** — CodeQL `javascript-typescript`, `security-extended`,
  in its own workflow so `security-events: write` is not granted to the job
  running the test suite.
- **NOW ENFORCING (corrected 2026-10-26).** This bullet read "ADVISORY, NOT
  ENFORCING … until the owner marks these four as required under branch
  protection." The owner has since done so: ruleset `25851827` requires all
  four contexts on `refs/heads/master` with `strict` on and no bypass actors
  (evidence in the header section above). A detection now blocks a merge, so
  secret scanning is a gate rather than only a signal. What remains advisory is
  the *dev-dependency* tier of `dependency audit` — see the audit note below —
  not the check itself.
- **SCOPED BY BASE BRANCH, and this is wider than the scanners.** Both
  workflow files carry a single `on:` block filtered to
  `branches: [master, 'integration/**']`. Because `ci.yml` holds the `verify`,
  `audit` and `secrets` jobs under that one block, a pull request targeting any
  other base branch runs **no CI at all** — not the scanners, and not
  typecheck, lint, tests or build either. Verified by reading both files. A PR
  into a feature branch is therefore unchecked; only the eventual PR into
  `master` is covered. Widening the filters, or accepting the gap knowingly, is
  an owner decision.
- **SHA-pinning is done (PR #68, `ce7255a`).** This bullet read "remains an
  open owner decision." Every `uses:` in every workflow file now names a
  40-character commit SHA with the human-readable tag in a trailing comment;
  measured on the merged tree by listing every `uses:` that does not match
  `@[0-9a-f]{40}`, which returns nothing.
  `lib/__tests__/workflow-action-pinning.test.ts` keeps it that way, and its
  matchers tolerate YAML-quoted keys — an earlier version did not, and would
  have passed over a quoted unpinned entry.

- **Dependency audit, both tiers, measured on the merged tree 2026-10-26.**
  Production dependencies: **no known vulnerabilities** (`pnpm audit --prod`).
  Full tree including dev: **24 advisories — 2 critical, 13 high, 8 moderate,
  1 low**, all in the dev chain (for example `vitest > @vitest/mocker`,
  GHSA-qxg6-89mg-rqv8). `ci.yml` fails the build only on production-dependency
  criticals and highs and reports the dev chain advisory-only; that is a
  documented tier split, not a suppression. The dev findings are real and are
  recorded here as open, not as clean.

### `/api/migrate` — Phase 1 hardening applied

Five of the six measured weaknesses are fixed. The assertions in
`lib/__tests__/migrate-route-security.test.ts` were inverted in the same
change, which was the stated purpose of writing them as assertions. Full
analysis in `docs/decisions/0005-migration-privilege-separation.md`.

**Fixed:**

- **POST only.** `GET` answers 405 with a pointer rather than failing
  silently, because the old runbook said GET. This is a **breaking
  operational change**: the command is now
  `curl -X POST -b <auth-cookie> https://<host>/api/migrate`.
- **Origin validated.** A browser request from another origin is refused
  before authentication runs, so a forged request never reaches a credential
  lookup or the database. An **absent** `Origin` is allowed deliberately — a
  browser always sends it on POST, so a request without one is not a
  cross-site forgery, and requiring it would disable the command-line
  auth-repair break-glass. No CSRF token: there is no browser client to
  supply one, so a token would add nothing and break recovery.
- **Operator path rate limited** — `schema:migrate-operator`, 6/hour keyed on
  admin id. Previously only the anonymous branch was limited.
- **Errors redacted.** The 500 returns a generic message plus a short
  reference; the full error is logged against that reference, so diagnostics
  survive without disclosing schema detail to the caller.

**Still present, by design:**

- **No transaction across the pipeline.** A failure part-way still leaves the
  schema neither old nor new. Wrapping ~103 statements in one transaction is
  a larger change than Phase 1, and some statements (`CREATE INDEX`) have
  their own locking consequences inside a long transaction. Unfixed and
  recorded, not forgotten.
- **The route requires table ownership.** This is the coupling that blocks
  audit immutability, and it is what Phases 2–5 exist to resolve. Phase 1
  does not touch it.
- **`clientIdentifier()` trusts `x-real-ip` first.** Whether Vercel's proxy
  overwrites a client-supplied header of that name is still **unverified**
  from this environment. If it does not, the anonymous 3/hour limit is
  bypassable by rotating one header. The operator limit is keyed on admin id
  and is unaffected.

---

## Resolved Bugs / Security Issues

- Request acceptance used legacy `balance` — fixed
- Activity filter chips non-functional — fixed
- Frontend password validation mismatch — fixed
- Plaid access tokens stored in plaintext — fixed (AES-256-GCM)
- `JWT_SECRET` silent dev fallback in production — fixed
- Friends auto-accepted with no approval flow — fixed
- Cash Out button permanently disabled even when gates passed — fixed
- Sandbox intents consuming real velocity budget — fixed (recordVelocity skipped for drafts)
- Sandbox provider field set to `'simulated'` string — fixed (now NULL to distinguish from real providers)

---

- **Transfer provider architecture** (2026-06-26): Region-aware `TransferProvider` interface in `lib/transfers/`; `SandboxUSProvider` for US (simulates Plaid Transfer) and `SandboxCAProvider` for CA (simulates Canadian EFT); provider router in `lib/transfers/router.ts`; 3-step flow: `POST /api/transfers/intent` → `GET /api/transfers/[id]/review` → `POST /api/transfers/[id]/confirm`; `transfer_intents` extended with `provider_region`, `provider_name`, `execution_mode`, `consent_confirmed_at`, `idempotency_key`, `bank_account_id`; no money movement, no external API calls; lint clean, build clean

## Ready for Production Deploy

- ✅ **Provider Execution Framework** (Phase A3 — complete)
  - `lib/providers/` directory with 4 providers (2 sandbox, 2 placeholder)
  - `TransferProvider` interface with 7 required methods
  - `TransferProviderFactory` for centralized provider selection
  - All sandbox behavior unchanged, no API calls, no balance mutations
  - Lint ✅ Build ✅ TypeScript ✅

- ✅ **Phase A2 Infrastructure** (review complete, bugs fixed)
  - `ledger_entries` table defined and migration ready
  - `createLedgerPair()` for same-currency (atomic via CTE)
  - `createCrossBorderLedgerPair()` for cross-border (atomic via CTE) — FIX APPLIED
  - `backfillOpeningBalances()` for opening balance ledger entries
  - Ledger entries created after successful P2P payments (non-blocking)
  - `GET /api/ledger` (auth required, user-scoped)
  - `GET /api/ledger/balance-check` (warning-only, no mutations)
  - All SQL uses postgres.js tagged templates
  - Lint ✅ Build ✅ TypeScript ✅

- ✅ **Phase A2 Infrastructure** (webhook events + velocity reversal)
  - `provider_webhook_events` table defined in `lib/db.ts` and migration route
  - `lib/provider-events.ts` helpers: `recordProviderEvent()`, `hasProcessedProviderEvent()`, `markProviderEventProcessed()`, `markProviderEventFailed()`
  - `reverseVelocity()` implemented in `lib/auth.ts` — creates compensating negative velocity records, non-blocking, audit logged
  - Admin endpoint: `POST /api/admin/ledger/backfill-opening-balances` with BACKFILL_SECRET protection
  - Webhook event deduplication ready for use by live providers
  - All SQL uses postgres.js tagged templates
  - Lint ✅ Build ✅ TypeScript ✅

- ✅ **Settlement Processor Skeleton** (Phase A4 — complete)
  - `lib/settlement/types.ts`: Event types, outcome objects, transition rules
  - `lib/settlement/settlement-rules.ts`: Valid transitions, terminal/processing states, validators
  - `lib/settlement/SettlementProcessor.ts`: Core processor, no balance mutations, no ledger entries
  - Dev endpoint: `GET /api/dev/settlement-test` validates 6 test cases (returns 404 in production)
  - No balance updates, no ledger entries, no provider calls — pure state machine
  - Lint ✅ Build ✅ TypeScript ✅

- ✅ **Webhook Receiver Framework** (Phase B1 — complete)
  - `POST /api/webhooks/plaid`: HMAC-SHA256 signature verification (ready for sandbox testing), event deduplication via UNIQUE(provider, provider_event_id), stores raw event payload
  - `POST /api/webhooks/stripe`: Updated to record financial events (charge.*, payout.*) while preserving KYC logic (identity.verification_session.*)
  - Event intake infrastructure: no balance updates, no ledger entries, no settlement logic wired (Phase B2)
  - All SQL uses postgres.js tagged templates
  - Lint ✅ Build ✅ TypeScript ✅

- ✅ **Settlement Orchestrator** (Phase B2 — complete)
  - `lib/settlement/SettlementOrchestrator.ts`: Queries transfer_intents, calls SettlementProcessor, produces SettlementPlan
  - `planBalanceUpdate()`: Describes balance changes (Add Money: +, Cash Out: -) without executing
  - `planLedgerEntries()`: Describes ledger entries (debit, credit, type) without creating
  - `shouldNotify()`: Determines notification requirement (not sent, just flagged)
  - Pure planning layer: no balance updates, no ledger entries, no notifications, no velocity reversal, no provider execution
  - Webhook handlers can return SettlementPlan for Phase B3 execution
  - All SQL uses postgres.js tagged templates
  - Lint ✅ Build ✅ TypeScript ✅

---

## In Progress / Next

- ✅ **Phase B3.1 Settlement Status Executor**: Execute status transitions only
  - `lib/settlement/SettlementExecutor.ts`: Core executor with `executeSettlementPlan()`
  - `SettlementExecutionResult`: success, intentId, previousStatus, newStatus, updated, reason, error
  - Updates `transfer_intents.status` and `transfer_intents.updated_at` only
  - Idempotent: if already at target status, returns success without updating
  - Wired into `POST /api/webhooks/plaid`: `TRANSFER`/`STATUS_UPDATE` handler
  - **Critical constraint:** Only status transitions — NO balance, NO ledger, NO notifications, NO velocity, NO provider calls
  - Lint ✅ Build ✅ TypeScript ✅

- ✅ **Phase B3.2a Settlement Ledger Executor**: Create ledger entries only
  - `lib/settlement/SettlementExecutor.ts` extended with `executeLedgerCreation(plan)`
  - `LedgerExecutionResult`: success, intentId, entriesCreated, reason, error
  - `ledger_entries` table: added `provider_event_id` column with UNIQUE constraint
  - **Critical constraint:** Ledger entries only — NO balance, NO notifications, NO velocity, NO provider calls
  - Lint ✅ Build ✅ TypeScript ✅

- ✅ **Phase B3.2b Settlement Balance Executor**: Update wallet balances only
  - `lib/settlement/SettlementExecutor.ts` extended with `executeBalanceUpdate(plan)`
  - `BalanceExecutionResult`: success, intentId, balanceUpdated, currency, amountApplied, operation, reason, error
  - `provider_webhook_events` table: added `balance_processed_at` and `balance_processing_error` columns
  - Idempotency via `balance_processed_at` tracking: same provider event never updates balance twice
  - Atomic update: single UPDATE to users.balance_cad/balance_usd using arithmetic (no read-then-update)
  - Validation: currency CAD/USD, positive amounts, user owns intent, status allows action
  - Special handling: Cash Out skipped (no live executeTransfer yet), Add Money adds balance, Returned reverses balance
  - No negative balances: relies on SQL arithmetic and validation (no precheck needed)
  - Wired into webhook handler: status → ledger → balance executor chain
  - **Critical constraint:** Balance updates only — NO ledger, NO notifications, NO velocity, NO provider calls
  - Lint ✅ Build ✅ TypeScript ✅

**Safe Next Milestone: Phase B3.3 — Notification & Velocity Executor**

Execute notifications and velocity reversal from SettlementPlan:

1. **Implement notification executor** (Phase B3.3)
   - Send notifications if plan.notifyUser
   - Non-blocking: failures don't fail settlement

2. **Implement velocity executor** (Phase B3.3)
   - Reverse velocity if plan.reverseVelocity (returned transfers only)
   - Non-blocking: failures don't fail settlement

**Critical Path:**
Event intake (B1) ✅ → Settlement planning (B2) ✅ → Status transitions (B3.1) ✅ → Ledger entries (B3.2a) ✅ → Balance updates (B3.2b) ✅ → Notifications/Velocity (B3.3) → Live providers

---

## Env Vars Required in Vercel

| Variable | Status |
|---|---|
| `DATABASE_URL` | Set ✅ |
| `JWT_SECRET` | Set ✅ |
| `PLAID_CLIENT_ID` | Set ✅ |
| `PLAID_SECRET` | Set ✅ |
| `PLAID_ENV` | Code reads `PLAID_ENV`. Unset means sandbox. |
| `WISE_API_KEY` | Set ✅ |
| `WISE_ENV` | Set ✅ |
| `PLAID_TOKEN_ENCRYPTION_KEY` | Set ✅ |
| `STRIPE_SECRET_KEY` | Needs to be set |
| `STRIPE_WEBHOOK_SECRET` | Needs to be set |
| `NEXT_PUBLIC_APP_URL` | Needs to be set |
| `RESEND_API_KEY` | Needs to be set |
| `EMAIL_FROM` | Needs to be set |
| `BACKFILL_SECRET` | Optional: for `POST /api/admin/ledger/backfill-opening-balances` |

---

## After `/api/migrate` Runs in Production

1. **Ledger table created** — `ledger_entries` table is now live
2. **Test same-currency payment** — Verify ledger entries created with balanced debit+credit
3. **Test cross-border payment** — Verify both entries created atomically (sender currency debit, receiver currency credit)
4. **Test GET /api/ledger** — Authenticated user sees only their own entries
5. **Test GET /api/ledger/balance-check** — Should show zero mismatch for new transactions
6. **Monitor for errors** — Check logs for any ledger creation failures (non-blocking, should not affect payments)

---

## After Stripe Webhook Setup

Register Stripe webhook: `https://carloscab74.vercel.app/api/webhooks/stripe`
- Events: `identity.verification_session.verified`, `identity.verification_session.requires_input`
