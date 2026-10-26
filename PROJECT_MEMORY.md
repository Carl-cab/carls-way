# Manna — Project Memory

> Running project log and live-state summary. For full architecture, coding standards, and conventions, see `CLAUDE.md`. Update this file at the end of every session.

---

## 1. Current Product Purpose

Manna is a peer-to-peer payment app for cross-border money transfers between the US and Canada. Users register with a country (CA or US), get a $100 seed balance in their local currency, and can send/request money. Cross-border transfers use live Wise FX rates. Bank accounts link via Plaid.

---

## 2. Current Stack

- Next.js 16 (App Router, Turbopack), TypeScript 5, React 19, Tailwind CSS v4
- Auth: custom JWT in httpOnly cookie `manna-token` (`lib/auth.ts`), route guard via `proxy.ts`
- Database: Supabase PostgreSQL via `postgres.js` (`lib/db.ts`, `getSql()` singleton)
- FX: Wise API (`lib/fx.ts`, `buildFxQuote()`)
- Bank linking: Plaid (`lib/plaid.ts`), access tokens AES-256-GCM encrypted via `lib/encryption.ts`
- KYC: Stripe Identity (`lib/stripe.ts`, `getStripe()`)
- Deployed on Vercel: https://carloscab74.vercel.app
- Repo: https://github.com/Carl-cab/carls-way

---

## 3. Current Architecture

- `proxy.ts` gates all `(app)` routes and `/`, checking `manna-token` via `getAuthUser()`
- `lib/db.ts` exports `getSql()` (singleton) and `initializeSchema()` (CREATE TABLE IF NOT EXISTS)
- Schema migrations are ad-hoc: add columns to `initializeSchema()` AND `app/api/migrate/route.ts` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), then hit `/api/migrate` once after deploy
- Dual-currency: `balance_cad` / `balance_usd` on `users`; legacy `balance` column must never be used in new code
- Cross-border payments call `buildFxQuote()` and record `fx_rate`, `fx_fee`, `sender_amount`, `receiver_amount`, `is_cross_border`, `payment_rail`, `estimated_settlement`
- Velocity limits (`checkVelocityLimit()` / `recordVelocity()`) gate `type='pay'` transactions, vary by `kyc_status`
- All API routes return `NextResponse.json({ error })` / `{ success: true, ... }`; all queries use `postgres.js` tagged templates

---

## 4. Database Tables

- `users` — auth fields, `balance_cad`/`balance_usd`, legacy `balance`, `kyc_status` / `kyc_provider` / `kyc_session_id` / `kyc_verified_at` / `kyc_rejection_reason`, `failed_login_attempts`, `locked_until`, country, avatar
- `transactions` — payments/requests, FX details (`fx_rate`, `fx_fee`, sender/receiver currency & amount, `is_cross_border`, `payment_rail`, `estimated_settlement`)
- `bank_accounts` — Plaid-linked accounts (`plaid_access_token_enc` — AES-256-GCM encrypted)
- `friends` — relationships with `status` column
- `velocity_checks` — rolling hourly/daily/weekly totals per user
- `audit_logs` — audit trail of sensitive actions

---

## 5. Completed Features

- Core auth (register/login/JWT cookie), route protection via `proxy.ts`
- Dual-currency balances (`balance_cad`/`balance_usd`) migration applied to production
- Cross-border FX quoting and transaction recording via Wise
- Plaid bank account linking and display on profile page
- Velocity limit checks and audit logging on payments
- June 2026 UX audit fixes: `bank_accounts` table added to schema (fixed hanging profile page); Request Money page now sends `receiverUsername`; fixed "NaNd ago"/"Invalid Date" timestamp bugs on Feed and History pages; layout header now reads `balance_cad`/`balance_usd`
- KYC foundation (Stripe Identity): `POST /api/kyc/create-session` creates hosted Identity session; `POST /api/webhooks/stripe` verifies Stripe signature and updates `kyc_status` server-side; profile page shows live KYC card with status, reason for failure, and "Verify Identity →" button
- Transfer readiness UI: "+ Add Money" and "Cash Out" buttons on profile page are always disabled; hint text below buttons shows one of three states — KYC not verified, bank account needs re-link (legacy plaintext token), or "Transfers are coming soon." No money movement routes created. `bank_accounts` API now returns `is_token_encrypted` (boolean, safe) so the client can detect re-link requirement without touching the token.
- Friend request approval flow: `friends` table gained `requested_by` and `updated_at` columns; `POST /api/friends` now inserts with `status='pending'` instead of auto-accepting; `POST /api/friends/[id]/accept` and `POST /api/friends/[id]/decline` enforce recipient-only authorization; friends page UI shows three sections — incoming requests (with Accept/Decline), sent requests (pending), and accepted friends list.

---

## 6. Known Bugs

None currently tracked. ~~Request acceptance used legacy `balance` field~~, ~~Activity filter chips non-functional~~, and ~~frontend password validation mismatch~~ are all **fixed** (see Session History).

---

## 7. Security Risks

- Ad-hoc migration system relies on manually hitting `/api/migrate` after every deploy — risk of schema drift between environments if forgotten.
- Bank accounts linked **before** the encryption fix have `is_token_encrypted = false`. Calling `requireEncryptedBankToken()` on them returns a safe re-link message; they cannot be silently used for transfers. Users must re-link via Plaid Link.
- `JWT_SECRET` missing in production now throws at request time (not silently falling back to dev secret).

~~Plaid access tokens stored in plaintext~~ — **fixed**. ~~JWT_SECRET silent dev fallback in production~~ — **fixed**.

---

## 8. Deployment Notes

- Vercel auto-deploys `master` on push
- Required env vars (set in Vercel): `DATABASE_URL`, `JWT_SECRET`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `NEXT_PUBLIC_PLAID_ENV`, `WISE_API_KEY`, `WISE_ENV`, `PLAID_TOKEN_ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`
- After any schema change: deploy, then call `GET /api/migrate` (authenticated)
- After adding Stripe env vars: register webhook in Stripe Dashboard → `https://carloscab74.vercel.app/api/webhooks/stripe`, events: `identity.verification_session.verified`, `identity.verification_session.requires_input`
- After any schema change: deploy, then call `GET /api/migrate` once to apply `ALTER TABLE` statements to production

---

## 9. Current Priorities

1. **Run `/api/migrate` in production** — Apply schema changes: `provider_webhook_events` table (Phase A2 infrastructure), and new `transfer_intents` columns (Phase A3) — required before webhook handling and live provider execution work in production
2. **Implement Phase B1: Webhook Receiver Framework** — Create `/api/webhooks/plaid` and `/api/webhooks/stripe` with signature verification, event deduplication, and settlement balance updates (before live providers can execute)
3. **Validate 3-step transfer flow in production** — US and CA users through intent → review → confirm; confirm regional consent language works
4. **KYC live test** — Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` in Vercel; register Stripe webhook at `/api/webhooks/stripe`
5. **PlaidTransferProvider implementation** — After B1 webhook framework; implement `executeTransfer()` and `handleWebhookEvent()` calling Plaid Transfer API; requires Plaid Link products updated to include `Transfer`
6. **CanadianEFTProvider implementation** — After B1 webhook framework; implement Stripe ACSS (Add Money) and VoPay Interac (Cash Out) integration

---

- **Sandbox transfer readiness layer**: `transfer_intents` table added (id, user_id, type, amount, currency, status, provider, provider_reference_id, failure_reason, created_at, updated_at); `POST /api/transfers/intent` creates draft intents with security gates (auth → KYC verified → encrypted bank account → velocity limits) without actual Plaid Transfer or Stripe ACH calls; `GET /api/transfers` lists user's intents; `GET /api/transfers/[id]` retrieves single intent; profile UI enables "Add Money" and "Cash Out" buttons only when KYC verified and encrypted account exists; new `/transfers` page for sandbox simulation with form to create intents and view history; audit logging on intent creation and blocked attempts

## 10. Session History

- **Initial build**: SQLite-based MVP for CA/US P2P payments, later renamed Carl's Way → Venmac → Manna
- **Postgres migration**: moved from SQLite to Neon, then to Supabase via `postgres.js` for Vercel compatibility
- **Dual-currency + FX + Plaid build-out**: added `balance_cad`/`balance_usd`, Wise FX quoting, Plaid bank linking, velocity limits, audit logging (on `master`/`documentation/handoff-package`)
- **Auth cookie fix** (`claude/cool-cerf-ErxD3`): fixed `proxy.ts`/`lib/auth.ts` cookie name mismatch (`carls-way-token` vs `venmac-token` → unified to `manna-token`), resolving broken auth routing
- **June 2026 UX audit**: fixed hanging profile page, Request Money field name mismatch, timestamp formatting bugs on Feed/History
- **Docs session**: confirmed `CLAUDE.md` matches handoff spec (no change needed); rewrote `PROJECT_MEMORY.md` into a concise 10-section live-state summary per updated project memory format
- **Request acceptance fix**: rewrote the `accept` branch in `app/api/transactions/[id]/route.ts` to use `balance_cad`/`balance_usd`, run velocity checks, build an FX quote via `buildFxQuote()` for cross-border requests, and record `fx_rate`/`fx_fee`/`sender_amount`/`receiver_amount`/`payment_rail`/`estimated_settlement` plus audit logging — closing the highest-priority known bug
- **Activity filter chips fix**: `GET /api/transactions` now honors `?filter=sent|received|pending` (in addition to `all`) via a composed `postgres.js` query fragment, matching what `app/(app)/history/page.tsx` already sends
- **Password validation fix**: `app/(auth)/register/page.tsx` password field now uses `minLength={8}` and updated placeholder text, matching `validatePassword()` in `lib/auth.ts` (8+ chars, 1 uppercase, 1 number)
- **Plaid token encryption**: replaced interim `lib/crypto.ts` with `lib/encryption.ts` exposing `encryptToken`/`decryptToken` (AES-256-GCM, keyed by `PLAID_TOKEN_ENCRYPTION_KEY`); `app/api/plaid/exchange-token/route.ts` encrypts the Plaid access token before INSERT — decrypted value is never returned to the client
- **KYC foundation — Stripe Identity**: added `lib/stripe.ts` (`getStripe()` singleton); `POST /api/kyc/create-session` creates a hosted Stripe Identity session (metadata: user_id, type: document+selfie, return_url → /profile?kyc=complete), stores `kyc_session_id` and sets `kyc_status='pending'`; `POST /api/webhooks/stripe` verifies signature with raw body, handles `verified` and `requires_input` events, updates DB server-side — client never touches status; profile page KYC card shows live status, rejection reason, and wired "Verify Identity →" / "Retry →" button; 5 new users columns added to both `initializeSchema()` and `/api/migrate`; `CURRENT_STATUS.md` created
- **Pre-Add Money security hardening**: added `bank_accounts.is_token_encrypted BOOLEAN DEFAULT false` to schema + migrate; `exchange-token` route now sets `is_token_encrypted = true` on insert; `requireEncryptedBankToken(userId, bankAccountId)` helper in `lib/plaid.ts` — returns decrypted token only when `is_token_encrypted = true`, throws `RELINK_REQUIRED_MESSAGE` for legacy plaintext rows; `JWT_SECRET` now throws in production instead of silently falling back to dev value (lazy evaluation, no build-time error); Add Money / Cash Out API routes confirmed absent; lint clean; build clean
- **Transfer readiness UI**: profile page "+ Add Money" / "Cash Out" buttons always disabled with contextual hint; three states driven by `kyc_status` and `bank_accounts.is_token_encrypted`; `GET /api/bank-accounts` now returns `is_token_encrypted` boolean; no money movement routes created; lint clean; build clean
- **Friend request approval flow**: `friends.requested_by` + `updated_at` columns added to schema + migrate; `POST /api/friends` sends pending request; `POST /api/friends/[id]/accept` and `/decline` enforce recipient-only auth; friends page redesigned with incoming/outgoing/accepted sections; production validated — accept ✅ decline ✅ self-add blocked ✅ duplicate blocked ✅; lint clean; build clean; merged to master
- **Transaction receipt page**: `GET /api/transactions/[id]` returns full receipt data gated to sender/receiver only (404 for others); `/transactions/[id]` page shows all fields — amounts, FX rate/fee, settlement date, rail, note, status badge, copy-ID button; feed and history cards are now clickable; accept/decline buttons stop propagation to prevent accidental navigation
- **Send from friends list**: Send button beside each accepted friend on friends page routes to `/send?to=<username>`; send page reads `?to=` query param via `useSearchParams` and pre-fills the recipient field; no new API routes or money movement logic added; `Suspense` wrapper added to send page to satisfy Next.js `useSearchParams` requirement
- **Public feed fixed**: New `/api/feed` route returns public transactions only (`WHERE privacy = 'public' AND status = 'completed'`); feed page now calls `/api/feed` instead of `/api/transactions?feed=true`; non-parties viewing a public transaction receipt see friendly "Receipt is private to participants" message with sender/receiver info
- **In-app notifications**: `notifications` table added to schema + migrate; `lib/notifications.ts` helper (non-blocking); notifications created on friend request send, friend accept, payment received, money requested; `GET /api/notifications`, `POST /api/notifications/[id]/read`, `POST /api/notifications/read-all` added; `/notifications` page with click-to-navigate; unread badge with 30s polling in layout nav
- **Sandbox transfer readiness layer — security fixes + production validation** (2026-06-26): Cash Out button fixed to become Link when `canTransfer` is true (was permanently disabled); `recordVelocity()` removed from sandbox intent creation (drafts no longer consume real velocity budget); `provider` set to `NULL` for sandbox intents (not `'simulated'`); production validated — KYC gate ✅, encrypted bank gate ✅, Add Money button active ✅, Cash Out button active ✅, `transfer_intents` table live ✅, balance unchanged after intent ✅; merged to master and deployed
- **Transfer provider architecture** (2026-06-26): `TransferProvider` interface (`lib/transfers/types.ts`) with `createIntent`, `reviewTransfer`, `confirmTransfer`, `executeTransfer`, `handleWebhookEvent`; `SandboxUSProvider` (US, simulates ACH, no real calls) and `SandboxCAProvider` (CA, simulates EFT, no real calls); provider router (`lib/transfers/router.ts`) maps `country='US'` → US provider, all others → CA provider; 3-step UI flow (form → review with consent language → confirmed); two new API routes: `GET /api/transfers/[id]/review`, `POST /api/transfers/[id]/confirm`; `transfer_intents` extended: `provider_region`, `provider_name`, `execution_mode`, `consent_confirmed_at`, `idempotency_key`, `bank_account_id`; CA users never see ACH language; `executeTransfer()` throws on both sandbox providers; no balance mutations anywhere; lint clean, build clean
- **Phase A1: Passive Audit Ledger** (2026-06-26): `ledger_entries` table added with columns: user_id, transaction_id (nullable), transfer_intent_id (nullable), currency, account_type, entry_type, debit/credit (default 0), provider (nullable), provider_reference (nullable), description, created_at; `lib/ledger.ts` with helpers: `createLedgerEntry()` (single entry, validates amounts), `createLedgerPair()` (balanced debit+credit pair, atomicity), `getLedgerBalance(userId, currency)` (computed sum), `validateLedgerPair()` (optional validation), `getUserLedgerEntries(limit)`; ledger entries added passively AFTER send-money balance updates (non-blocking, failure doesn't block transaction); same-currency transfers create one pair (sender debit, receiver credit, same amount), cross-border transfers create two separate entries (sender debit in sender currency, receiver credit in receiver currency, amounts differ by FX); entries linked to transaction_id for auditability; no ledger entries for requests, sandbox intents, Add Money, Cash Out, or failed transactions; `GET /api/ledger` (read-only, auth required, user's entries) and `GET /api/ledger/balance-check` (warning-only, no balance mutations); balance_cad/balance_usd remain authoritative source of truth; lint clean, build clean
- **Phase A2: Webhook Infrastructure + Velocity Reversal** (2026-06-27): `provider_webhook_events` table added with UNIQUE(provider, provider_event_id) constraint to prevent duplicate processing; `lib/provider-events.ts` with deduplication helpers: `recordProviderEvent()`, `hasProcessedProviderEvent()`, `markProviderEventProcessed()`, `markProviderEventFailed()`; `reverseVelocity()` implemented in `lib/auth.ts` to create compensating negative velocity records (immutable audit trail, non-blocking); `POST /api/admin/ledger/backfill-opening-balances` implemented with BACKFILL_SECRET protection (via x-backfill-secret header), 401 on missing auth, 403 on wrong secret, 500 on missing env var, idempotent query, ?dryRun=true support; all infrastructure marked "Future Use Only" (not yet wired to live providers); lint clean, build clean, deployed to master
- **Phase A3: Provider Execution Framework** (2026-06-28): `lib/providers/` directory created with complete provider abstraction; `TransferProvider` interface with 7 standardized methods (createIntent, reviewTransfer, confirmTransfer, executeTransfer, cancelTransfer, getTransferStatus, handleWebhookEvent); `TransferProviderFactory` provides centralized provider selection (US+sandbox→SandboxUS, CA+sandbox→SandboxCA, US+live→Plaid if env-gated, CA+live→CanadianEFT if env-gated); `SandboxUSProvider` fully implemented (US region, sandbox mode, no real API calls, no balance mutations, throws on executeTransfer); `SandboxCAProvider` fully implemented (CA region, sandbox mode, no real API calls, no balance mutations, throws on executeTransfer); `PlaidTransferProvider` placeholder (throws "Not implemented" on all methods); `CanadianEFTProvider` placeholder (throws "Not implemented" on all methods); `lib/transfers/router.ts` refactored as backward-compatibility layer (re-exports from factory); Critical constraint enforced: no provider may mutate balances; all balance changes happen ONLY via settlement webhooks; existing routes unmodified (use router.ts which delegates to factory); lint clean, build clean, deployed to master; test plan: verified zero live API calls, zero balance mutations, PlaidTransferProvider/CanadianEFTProvider are pure placeholders, all sandbox behavior unchanged; Next milestone: Phase B1 Webhook Receiver Framework before live provider implementation
- **Phase A4: Settlement Processor Skeleton** (2026-06-28): `lib/settlement/` module created with types.ts (SettlementStatus, SettlementEventType, ProviderEvent, SettlementOutcome, NormalizedEvent, SettlementTransitionRule), settlement-rules.ts (SETTLEMENT_TRANSITIONS, isValidTransition, getTransitionRule, isTerminalStatus, isProcessingStatus), SettlementProcessor.ts (normalizeProviderEvent, validateSettlementTransition, processSettlementEvent, applySettlementSideEffects-ready structure); 8 settlement event types supported (submitted, authorized, pending, posted, settled, failed, returned, cancelled); state transitions defined (draft→reviewed→confirmed→submitted→authorized→pending→posted→settled/failed, posted→failed, settled→returned, confirmed→cancelled); SettlementOutcome always returns shouldUpdateBalance: false and shouldCreateLedgerEntry: false (Phase A4 skeleton constraint); dev endpoint GET /api/dev/settlement-test validates 6 test cases (valid transitions, invalid transitions, idempotency, returns 404 in production); no balance updates anywhere, no ledger entries, no provider calls; all methods return structured results without throwing; lint clean, build clean; Next: Phase B1 will wire this processor into webhook handlers for actual settlement event processing
- **Phase B1: Webhook Receiver Framework** (2026-06-28): `POST /api/webhooks/plaid` created with HMAC-SHA256 signature verification (verifyPlaidSignature function, signature format ready for sandbox validation), raw body parsing, event deduplication via recordProviderEvent (UNIQUE constraint prevents duplicate processing), idempotent 200 response for duplicates, mapPlaidEventType maps provider events to settlement types; `POST /api/webhooks/stripe` updated to preserve KYC webhook logic (identity.verification_session.verified/requires_input) while adding financial event recording (charge.*, payout.* events stored via recordProviderEvent for Phase B2 processing); all webhooks return 200 immediately to prevent provider retries, no auth required (unauthenticated endpoints), raw body used for signature verification, no secrets logged, no balance updates, no ledger entries, no settlement logic wired yet (structure ready for Phase B2); error handling returns 200 with logging (prevents webhook storms), event storage via provider_webhook_events table ensures idempotency; lint clean (0 new errors, 8 pre-existing warnings), build clean; Phase B2 will wire SettlementProcessor into webhook handlers to apply settlement side effects (balance updates, ledger entries, notifications)
- **Phase B2: Settlement Orchestrator** (2026-06-28): `lib/settlement/SettlementOrchestrator.ts` created with pure planning layer (no execution); `orchestrateSettlement(event)` method queries transfer_intents by provider_reference_id, calls SettlementProcessor.processSettlementEvent(), enriches outcome with side effect instructions, returns SettlementPlan; `SettlementPlan` interface contains: intentId, previousStatus, nextStatus, transition, updateBalance (instruction: shouldUpdate, currency, amount, operation), createLedgerEntries (instruction: shouldCreate, entries array with debit/credit/type), notifyUser (boolean), reverseVelocity (boolean), requiresManualReview (boolean), idempotent (boolean), reason (string); `planBalanceUpdate()` describes balance changes (Add Money: +, Cash Out: -) based on nextStatus but does not execute; `planLedgerEntries()` describes settlement/reversal entries but does not create; `shouldNotify()` determines notification requirement; critical constraint: zero financial side effects (no balance updates, no ledger entries, no notifications sent, no velocity reversal, no provider execution); webhook handlers can use orchestrator to return plans for Phase B3 execution; lint clean (0 new errors, 8 pre-existing warnings), build clean; Phase B3 will implement execution of the plans (balance updates, ledger creation, notifications, velocity reversal, transfer_intents status update)
- **Phase B3.1: Settlement Status Executor** (2026-06-28): `lib/settlement/SettlementExecutor.ts` created with `executeSettlementPlan(plan)` method that applies status transitions from SettlementPlan to transfer_intents table (Phase B3.1 scope: status-only, no balance/ledger/notifications/velocity); `SettlementExecutionResult` interface contains: success (boolean), intentId (string), previousStatus (SettlementStatus), newStatus (SettlementStatus), updated (whether status actually changed), reason (string), error (optional); executor queries transfer_intents by intentId, checks if plan has error (returns failure), checks if already at target status (idempotent: returns success without update), executes UPDATE transfer_intents SET status = nextStatus, updated_at = NOW(), returns success result; handles plan errors gracefully with structured error responses; wired into `POST /api/webhooks/plaid` TRANSFER/STATUS_UPDATE handler; `handleTransferEventStatusUpdate()` creates NormalizedEvent with provider='plaid', provider_event_id=webhookId, provider_reference_id=transferId, eventType from mapPlaidTransferStatus, timestamp=now, isRetry=false; calls orchestrator.orchestrateSettlement(event) to get plan, calls executor.executeSettlementPlan(plan) to apply status, logs result via auditLog; `mapPlaidTransferStatus()` maps Plaid status strings to SettlementEventType (submitted→submitted, authorized→authorized, pending→pending, posted→posted, settled→settled, failed→failed, returned→returned, cancelled→cancelled, default→submitted); critical constraint: status transitions only — NO balance updates, NO ledger entries, NO notifications, NO velocity reversal, NO provider API calls; lint clean (0 new errors, 8 pre-existing warnings), build clean; Phase B3.2 will implement balance and ledger executors; Phase B3.3 will implement notification and velocity executors; full settlement flow: webhook receive (B1) → orchestrate plan (B2) → execute status (B3.1) → execute balance/ledger (B3.2) → execute notifications/velocity (B3.3)
- **Phase B3.2a: Settlement Ledger Executor** (2026-06-28): `lib/settlement/SettlementExecutor.ts` extended with `executeLedgerCreation(plan)` method for Phase B3.2a (ledger entries only, no balance updates); `LedgerExecutionResult` interface: success, intentId, entriesCreated (count), reason, error; added `provider_event_id` column to ledger_entries table with UNIQUE constraint `(transfer_intent_id, provider_event_id, entry_type)` to prevent duplicate ledger entries from duplicate webhook events; SettlementPlan interface updated to include provider (string) and provider_event_id (string) fields passed from NormalizedEvent; SettlementOrchestrator.orchestrateSettlement updated to pass provider and provider_event_id through enrichOutcomeWithSideEffects to SettlementPlan; ledger executor maps entry_type from plan format (transfer_settlement, transfer_reversal) to database format (add_money_settled, cash_out_settled, transfer_returned, transfer_failed) based on nextStatus; executor atomically inserts all ledger entries via Promise.all with postgres.js queries; uses ON CONFLICT (transfer_intent_id, provider_event_id, entry_type) DO NOTHING for idempotency (duplicate webhook events safely skipped); entries link to transfer_intents via transfer_intent_id, include provider and provider_reference for audit trail; wired into webhook handler: handleTransferEventStatusUpdate calls executor.executeSettlementPlan (B3.1) then executor.executeLedgerCreation (B3.2a); ledger result logged alongside status result in auditLog; critical constraint: ledger entries only — NO balance updates, NO notifications, NO velocity reversal, NO provider calls; lib/db.ts and app/api/migrate/route.ts updated to add provider_event_id column and UNIQUE constraint; lint clean (0 new errors, 8 pre-existing warnings), build clean; Next: Phase B3.2b will implement balance updates from SettlementPlan
- **Phase B3.2b: Settlement Balance Executor** (2026-06-28): `lib/settlement/SettlementExecutor.ts` extended with `executeBalanceUpdate(plan)` method for Phase B3.2b (balance updates only, no ledger/notification/velocity); `BalanceExecutionResult` interface: success, intentId, balanceUpdated, currency, amountApplied, operation (add/subtract), reason, error; added `balance_processed_at` (TIMESTAMPTZ) and `balance_processing_error` (TEXT) columns to provider_webhook_events table for idempotency tracking; eventRows declared at method scope for accessibility in catch block; validation: currency must be USD or CAD, amount must be positive, user must own intent, status must allow balance action; idempotency strategy: check balance_processed_at before executing, return idempotent success if already processed, set balance_processed_at = NOW() after successful update; atomic balance update using SQL arithmetic (balance_cad = balance_cad + amount) via single UPDATE statement with RETURNING to verify user exists; special handling: Add Money increases balance on settled, Cash Out skipped with success (no live executeTransfer implementation yet), Returned applies reversal (subtracts balance if previously settled); error tracking: balance_processing_error column updated with error message if execution fails; wired into webhook handler: handleTransferEventStatusUpdate calls executor.executeBalanceUpdate after executeLedgerCreation, logs all three results (status/ledger/balance) in auditLog; critical constraint: balance updates only — NO ledger entries, NO notifications, NO velocity reversal, NO provider API calls; lib/db.ts and app/api/migrate/route.ts updated to add balance tracking columns; lint clean (0 new errors, 8 pre-existing warnings), build clean; Next: Phase B3.3 will implement notifications and velocity reversal

---

## Gap in this record: 2026-06-28 → 2026-10-17

This file's entries stop at Phase B3.2b (2026-06-28). PRs #13 through #55
landed in the interval and are not recorded here. Rather than reconstruct them
from memory — which would risk inventing detail — this entry states what the
gap contains and where the authoritative account lives.

**Where to look instead.** Each merged PR body carries its own evidence:
the defect, how its existence was demonstrated, the tests added, and the
mutation results. `git log --merges master` lists them in order. The verified
current state is `CURRENT_STATUS.md` and `CLAUDE.md`; a dated, command-level
reconciliation is `docs/audits/2026-10-17-baseline.md`.

**Two claims above are now false** and are corrected here rather than edited in
place, so the historical record stays intact:

- Phase A3 records `PlaidTransferProvider` and `CanadianEFTProvider` as
  placeholders that "throw Not implemented on all methods". Both are now fully
  implemented and env-gated behind `PLAID_TRANSFER_LIVE` and `CA_EFT_LIVE`,
  which default off.
- Several entries place the `TransferProvider` interface at
  `lib/transfers/types.ts`. It is `lib/providers/TransferProvider.ts`;
  `lib/transfers/` is a deprecated compatibility layer that re-exports from
  `lib/providers/TransferProviderFactory.ts`. Do not add to it.

**Shape of the interval**, for orientation only — the PR bodies are the record:
money columns converted from float to `NUMERIC` with a driver-level numeric
parser; password reset repaired; a login timing oracle and an
`X-Forwarded-For` rate-limit bypass closed; ledger atomicity for splits and
P2P; JWT revocation via `users.token_version`; the schema-source drift class
closed and guarded by `lib/__tests__/schema-source-parity.test.ts`; the live
transfer execute endpoint added behind both gates; Plaid credential redaction
and a single Plaid host resolver; the C1.4 webhook dead-letter queue reaching
the production migration path; money-column DDL removed from cold start; the
anonymous schema-repair path narrowed to an auth-column allowlist; and a SQL
injection in `BaseRepository.exists()`/`count()` closed at the type level.

**Going forward.** A material change appends an entry here naming its purpose,
the financial or security behaviour affected, tests run and results, commit SHA
and PR, migration impact, unresolved findings, rollback requirement, and the
next recommended action. An audit appends a dated file under `docs/audits/`; an
architectural decision appends one under `docs/decisions/`.

### 2026-10-17 — Migration execution gate

- **Commit / PR.** `e4852b0` on `ci/migration-execution-gate`, PR #56. The
  commit SHA and PR number were missing from the first version of this entry,
  which broke the rule the same change added to CLAUDE.md; CodeRabbit caught it.
- **Purpose.** `app/api/migrate/route.ts` is production's only schema-change
  mechanism and nothing executed its statements. Demonstrated: changing one
  statement to `ADD COLUM` left typecheck clean and all 735 tests passing.
- **Financial/security behaviour affected.** None directly. It closes a
  verification gap in the path that every production schema change travels —
  the path CLAUDE.md already records five incidents against.
- **Tests run.** New `lib/__tests__/migrate-route-execution.test.ts`, 7 cases.
  Full suite 51 → 52 files, 735 → 742 tests, all passing on a fresh database.
  Typecheck clean, lint 0 errors / 28 warnings, build clean, `pnpm audit --prod`
  clean. Mutation-checked both ways: the `ADD COLUM` typo fails 2 of 7; removing
  the `webhook_dead_letters` `CREATE` fails 1 of 7.
- **Migration impact.** None. The change adds a test and two documents; it
  alters no schema and requires no production migration.
- **Unresolved findings.** Secret scanning and SAST are still absent from CI.
  No `.claude/` hooks exist. Branch protection cannot be verified or set from a
  session and remains an owner action. Production-dependent verification (cron
  and `CRON_SECRET`, Redis backend, DLQ and reconciliation drills) is NOT RUN,
  not passed — this environment cannot reach production.
- **Rollback.** Revert the commit. Nothing stateful changes.
- **Next recommended action.** Secret scanning in CI, as the smallest remaining
  control with a real failure mode behind it.

### 2026-10-17 — PR #56 merged; secret scanning and SAST added

- **Commit / PR.** PR #56 merged as `d161728`. This entry's own change is
  PR #57 on `ci/secret-scanning-and-sast`, commits `1a9b244`, `48fd84e`,
  `23e6032`, plus the merge of `master` that resolved the `PROJECT_MEMORY.md`
  conflict created by PR #58 landing first.
- **Purpose.** Two of the three controls the 2026-10-17 baseline audit recorded
  as MISSING: secret scanning and static application security testing. The
  third, `.claude/` session hooks, is still open.
- **Financial/security behaviour affected.** No application code changed. Both
  additions are CI controls. A committed Plaid, Stripe, Wise, Supabase or JWT
  credential now **fails the pull request's checks**. It does not yet *block* a
  merge: that requires the owner to mark `secret scan` a required check in
  branch protection, which cannot be done from a session. Until then the
  control is a loud signal, not a gate — CodeRabbit was right to flag the
  original wording here as an overclaim.
- **Tests run.** Suite unchanged at 53 files / 743 tests, typecheck clean, lint
  0 errors / 28 warnings. The security controls were validated by synthetic
  finding rather than by assertion — see below.
- **Migration impact.** None.
- **Unresolved findings.** `.claude/` session hooks absent. Branch protection
  still cannot be set from a session and remains an owner action; the checks to
  mark required are now four: `install · typecheck · lint · test · build`,
  `dependency audit`, `secret scan`, and `analyze javascript-typescript`.
  CodeQL's behaviour could not be validated locally (see below).
- **Rollback.** Revert the commit. Both controls are additive workflow files;
  nothing stateful changes.
- **Next recommended action.** The `auditLog` jsonb double-encoding repair
  (Task 3), whose investigation is recorded in
  `docs/audits/2026-10-17-audit-log-encoding.md`.

**Secret scanning.** Gitleaks 8.21.2, pinned by version and verified against
the SHA256 in the release's own checksum manifest, scanning all 92 non-merge
commits rather than the pull request's diff — a credential committed and later
"removed" is still in the pack, so a diff-only scan would call that clean.

The repository had two pre-existing findings, both `sk_live_abc123` in
`lib/__tests__/security-kyc.test.ts`. Verified synthetic by reading the file:
they sit in a table of key shapes (`pk_live_abc123`, `sk_live_`,
`sk_prod_abc123`, `xsk_live_abc123`) asserting that a live-shaped key does not
enable KYC auto-verification. The exception is keyed on **the literal, not the
path**, so a genuine credential added to that same file still fails. Removing
the fixture was considered and rejected: the test asserts a live-money safety
property and needs a live-shaped literal to assert against.

**Static analysis.** CodeQL, `javascript-typescript`, `security-extended`
rather than the default suite — this application takes untrusted request
bodies, builds SQL, verifies webhook signatures and moves money.
`security-and-quality` was rejected because its maintainability queries would
bury security findings. In its own workflow so `security-events: write` is not
granted to the job running the test suite.

**Validation by synthetic finding**, since a security control that has never
failed is not known to work:

| Probe | Expected | Result |
|---|---|---|
| Clean history with the config | 0 findings, exit 0 | 0 findings, exit 0 |
| Real-shaped Stripe key in a new file | detected, exit 1 | detected, exit 1 |
| Real-shaped key in the **allowlisted** file | still detected | still detected, exit 1 |
| `--redact` on, `dir` mode | value absent from report | 0 occurrences |
| `--redact` off, `dir` mode | value present | 2 occurrences |
| `--redact` on, `git` mode, secret in the commit message | value absent | **1 occurrence — leak** |
| same, after the `jq` strip | value absent | 0 occurrences |

The third row is a correction to this entry's first version, found by
CodeRabbit and then reproduced. `--redact` does not cover everything the SARIF
writer emits: when a credential also appears in a commit message, the full
value survives at `.runs[].results[].partialFingerprints.commitMessage`. The
original measurement used `dir` mode on a file and so missed the mode CI
actually runs. The job now strips that field before upload and fails if it
survives. `partialFingerprints` only aids alert de-duplication; file, line and
rule are untouched, verified by reading `a.ts:1` back out of the stripped
document.

A third correction, from the re-review of the fix itself: the upload was gated
on `hashFiles('gitleaks.sarif') != ''`, which a *failed* sanitization still
satisfies — jq or mv failing leaves the original file on disk, so the unredacted
commit message would have been published by the very step added to remove it.
Demonstrated locally: after a deliberately broken `jq` filter the step exits 3
and the leak is still in the file. The upload now requires
`steps.sanitize.outcome == 'success'`, so a broken sanitizer loses the artifact
instead of leaking through it.

A second correction from the same review: the allowlist regex was unanchored,
so a real credential merely *beginning* with `sk_live_abc123` was suppressed —
reproduced, then fixed by anchoring against the extracted secret rather than
the whole rule match. The suggested remedy of anchoring with
`regexTarget = "match"` was measured and rejected: it breaks the allowlist
outright, so CI would fail on the known fixtures.

The third row is the one that matters: it proves the exception is narrow rather
than a blanket path exemption. The last two show `--redact` is load-bearing — a
scanner that prints the credential it found turns a private leak into a public
one, since CI logs and artifacts are retained.

**CodeQL could not be validated locally** and is recorded as NOT RUN rather
than passed. It needs the GitHub-hosted analysis service; this environment has
no way to execute it. Its first real run is on this pull request.

**On detection being an incident.** The job's failure message requires rotation
at the provider first, then a written record of the exposure, and only then
history cleaning — because deleting the commit does not un-expose a credential
that was already pushed to a remote.
### 2026-10-17 — Audit JSONB double-encoding repair

- **Commit / PR.** `9f60d56` on `fix/audit-jsonb-double-encoding`, PR #58.
- **Purpose and scope.** Both audit writers bound `JSON.stringify(value)` to a
  `jsonb` column, which stores a jsonb **string scalar** rather than a
  document. Measured: `jsonb_typeof` = `'string'`, `metadata->>'ip'` = NULL,
  `m::text` = `'"{\"ip\":\"1.2.3.4\"}"'`. Fixed at both sites
  (`lib/auth.ts` → `audit_logs.metadata`, `lib/rbac/AuditLogRepository.ts` →
  `admin_audit_logs.changes`) via a new `lib/jsonb.ts`.
- **Why it was invisible.** The paired reader did `JSON.parse(row.changes)`,
  which decoded the scalar back and exactly compensated the writer.
  Application reads were correct; only SQL-side access was broken, silently,
  because a JSON path operator against a string scalar returns NULL rather than
  erroring. The writer could **not** be fixed alone: with a corrected writer the
  row returns as an object, `JSON.parse` of an object throws `SyntaxError`, and
  `createAuditLog`'s catch reports `AUDIT_CREATE_FAILED`. Measured, and the
  reason writer and reader moved in one commit.
- **Financial/security behaviour affected.** No money path. Audit records
  written from now on are queryable by JSON path, containment and index, which
  is what makes the trail usable as compliance evidence by anything other than
  the application that wrote it. Also found and fixed a **silent audit loss**:
  `auditLog()` ended in `catch { }`, so an FK violation on a stale
  `audit_logs.user_id` (`23503`) discarded the record and reported success. The
  catch now logs action and user id, and deliberately not `metadata`, which
  carries request-shaped values.
- **Historical rows are NOT altered.** No `UPDATE` is issued against existing
  audit rows. Readers normalize both shapes instead, permanently.
  Additive-normalization vs in-place-migration is argued in
  `docs/decisions/0002-normalize-audit-jsonb-additively.md`.
- **Immutability, assessed not assumed.** Measured on a database built from the
  schema sources: no trigger, no rewrite rule, no RLS (`relrowsecurity = f` on
  both audit tables), no `REVOKE` in any schema source, no hash chaining. The
  application's single DB role can `UPDATE` and `DELETE` audit rows with no
  residue. **Nothing enforces immutability**, and no claim of cryptographic
  tamper resistance is made. `CLAUDE.md` described `audit_logs` as an
  "Immutable system audit trail"; that wording is corrected rather than left
  standing, since the schema does not support it.
- **Tests run.** New `lib/__tests__/audit-jsonb-encoding.test.ts`, 13 cases,
  against a real database through the real `auditLog()` and the real
  `AuditLogRepository`. Full suite 743 → **756 tests across 53 files**, all
  passing on a database created fresh for the run. Typecheck clean, lint 0
  errors / 28 warnings. Mutation-checked all three fixes: reverting the
  `lib/auth.ts` writer fails 2 of 13, the repository writer 1 of 13, the reader
  2 of 13. The repository-writer mutation fails only the SQL-side assertion,
  because the tolerant reader still round-trips a string scalar — that
  asymmetry is the original defect's invisibility reproduced as a test signal.
- **Migration impact.** None. No schema change, no `/api/migrate` change, no
  production migration required.
- **Unresolved findings.** `provider_webhook_events.raw_payload` has the same
  defect; its readers already tolerate both shapes so nothing is broken today,
  but SQL-side access to that column returns NULL — recorded, not bundled into
  an audit change. Audit immutability remains unenforced.
  `AdminAuditService.verifyImmutability()` still returns a hardcoded `'clean'`;
  `AuditLogRepository.verifyImmutability()` still compares `COUNT(*)` to
  `MAX(id)` and so detects deletes but not updates. Both untouched. A GIN index
  on either jsonb column would work as-is on the mixed column — measured, it
  creates without complaint — so a `WHERE jsonb_typeof(...) = 'object'`
  predicate is an optional optimization that skips indexing legacy scalar rows,
  not a requirement. No such index exists.
- **Rollback.** **Revert the writers, keep `readJsonbRecord()`.** Not a whole-
  commit revert: the fix is forward- but not backward-compatible. Rows written
  while it is deployed are documents, and the old reader's bare `JSON.parse`
  throws `SyntaxError` on them. Four read paths map over a batch, so one such
  row raises `AUDIT_QUERY_FAILED` for the entire query and takes the legacy rows
  in it down too — the admin audit viewer and the compliance export would fail
  wholesale. Nothing is lost on disk; it becomes unreadable by the reverted
  code. Affects `admin_audit_logs.changes` only; `audit_logs.metadata` has no
  `JSON.parse` reader, so reverting that writer is clean. The same asymmetry
  applies briefly during any rolling deploy. An earlier draft of this entry
  claimed rollback was clean, which was wrong; corrected before merge.
- **Next recommended action.** Task 4 — the focused security review of
  `app/api/migrate/route.ts`.

### 2026-10-18 — PR #59: dead-letter queue JSONB encoding (and PR #58 merged)

- **Commit / PR.** This entry's own change is **PR #59** on
  `fix/dead-letter-jsonb-encoding`, commits `33cf1ed` and the review-fix commit
  below. Separately recorded here: PR #58 merged as `244c91e`.
- **Purpose and scope.** `markProviderEventFailed()` copies a dead-lettered
  payload from `provider_webhook_events.raw_payload` into
  `webhook_dead_letters.raw_payload`. Both columns are `jsonb` and **both
  source writers are already correct** (`sql.json`), but the copy did
  `JSON.stringify(row.raw_payload)` then `${payload}::jsonb` — and a cast
  applied to text that is already a complete JSON document yields a jsonb
  **string scalar**. Correct writers at both ends, double-encoded destination
  between them. Fixed by binding the source value as is with the existing
  `jsonbParam()` and dropping the cast.
- **Financial/security behaviour affected.** No money path. `webhook_dead_letters`
  is the operator-review queue for events that exhausted their retries, and
  every SQL-side look into a dead-lettered payload (`raw_payload->>'id'`, a
  `@>` filter, a path into `data.object`) returned NULL or no rows, silently.
  Replay kept working because `parseStoredStripeEvent()` tolerates the string
  form — the same compensating reader that hid the audit defect in #58. A
  second, independent bug in the same line: `JSON.stringify(null)` is `"null"`,
  so a NULL payload became the jsonb `null` literal instead of SQL NULL.
- **A documentation error corrected.** `CLAUDE.md` claimed
  `provider_webhook_events.raw_payload` "is still double-encoded by its writer".
  **That was wrong** — both writers use `sql.json`, and a comment already in
  `lib/external-settlement-reconciliation.ts` said so explicitly. The claim was
  inferred from the defensive *readers* rather than read off the writers, and
  the real defect was one table over. Both `CLAUDE.md` statements are corrected;
  the merged #58 text carried the error.
- **Historical rows are NOT altered.** The source row is untouched; only the new
  `webhook_dead_letters` row is written correctly. A legacy string-scalar source
  is repaired on the way through rather than carried forward.
- **Tests run.** New `lib/__tests__/dead-letter-jsonb-encoding.test.ts`, 6 cases,
  through the real `recordProviderEvent()` and `markProviderEventFailed()`
  against a real database. **Written before the fix and confirmed failing: 4 of
  6.** Full suite 756 → **762 tests across 54 files**, all passing on a database
  created fresh for the run. Typecheck clean, lint 0 errors / 28 warnings, build
  clean. Mutation-checked: restoring `JSON.stringify` + `::jsonb` fails 4 of 6;
  reintroducing the shape normalization described below fails 3 of 9, two of
  them replay-equality cases.
- **A regression I introduced and CodeRabbit caught.** The first version of this
  fix also normalized a legacy string-scalar source into a document while
  copying it into the queue — an apparently free repair of a historical row. It
  is not free. `claimDeadLetterForReplay()` (`lib/webhooks/replay.ts:101`)
  requires `dl.raw_payload IS NOT DISTINCT FROM e.raw_payload`, deliberately, so
  a corrupt row cannot be replayed under another event, and that equality is
  between the two **stored** representations. Normalising one side makes the
  claim match nothing, so a legacy dead-lettered event becomes
  **unreplayable** — `not_found_or_already_replayed` instead of recovery.
  Measured: source `string` vs queue `object` gives `IS NOT DISTINCT FROM` =
  false; preserving the shape gives true. Corrected to bind the source value as
  is; `normalizeJsonbDocument()` was removed rather than left unused. Three new
  cases now assert the replay-claim equality **directly** for document,
  legacy-scalar and NULL payloads — the guard whose absence let the regression
  be written, since the original tests asserted only the stored shape, which the
  wrong behaviour satisfied. The general lesson, recorded in `CLAUDE.md`: fix
  the encoding *mechanism*, never change the *value*, wherever two
  representations are later compared.
- **Migration impact.** None. No schema change, no `/api/migrate` change.
- **Unresolved findings.** Audit immutability remains unenforced (no trigger,
  rule, RLS, `REVOKE` or hash chaining); both `verifyImmutability()`
  implementations untouched. Historical string-scalar rows remain in
  `provider_webhook_events` and `webhook_dead_letters` and are read, not
  rewritten. PR #57 (secret scanning + CodeQL) is green but **not merged** —
  awaiting owner authorization; its `PROJECT_MEMORY.md` conflict from #58
  landing first was resolved in `5951904`.
- **Rollback.** Clean, unlike #58: no reader anywhere does a bare `JSON.parse`
  on `webhook_dead_letters.raw_payload`, and `parseStoredStripeEvent()` already
  accepts both shapes, so documents written during the window stay readable
  after a revert.
- **Next recommended action.** Task 4 of the prior directive — the focused
  security review of `app/api/migrate/route.ts` — then the append-only audit
  architecture proposal (directive section 4).

### 2026-10-18 — PRs #57, #59, #60, #61 merged; documentation reconciled

- **Commit / PR.** Merge SHAs: #60 `57a601c`, #61 `909e546`, #57 `c8d708a`,
  #59 `4e63bb9`. This entry's own change is on
  `docs/post-merge-reconciliation`; SHA and PR appended on push.
- **Purpose and scope.** Four approved PRs merged in a conflict-minimising
  order (#60 and #61 touch no shared files; #57 then #59 both append to
  `PROJECT_MEMORY.md`). The `PROJECT_MEMORY.md` overlap auto-merged cleanly
  with all entries in chronological order, so no manual resolution was needed.
  This entry then reconciles the three governance documents that were
  deliberately left untouched while those PRs were open, to avoid conflicting
  with them.
- **Verified state.** Checked against `4e63bb9` **itself**, not a
  near-identical tree: 55 files / **778 tests** pass on a database created
  fresh for the run, typecheck clean, lint 0 errors / 28 warnings,
  `pnpm audit --prod` no known vulnerabilities. The distinction matters because
  the combined tree was first validated as a local test-merge, and claiming
  that as verification of the merge commit would have been the kind of
  near-enough assertion this record exists to prevent.
- **Financial/security behaviour affected.** No money path, no schema change,
  no migration, no credential or ownership change. What landed:
  - **#57** secret scanning (Gitleaks 8.21.2, checksum-verified, full history)
    and CodeQL `security-extended`. **Both are advisory, not enforcing** — a
    detection fails the check but does not block a merge until the owner marks
    four checks required under branch protection, which cannot be done from a
    session. Recorded in `CURRENT_STATUS.md` as a signal rather than a gate, so
    nobody mistakes the control for a guarantee.
  - **#59** the dead-letter JSONB copy fix, preserving the source shape so the
    replay claim's `IS NOT DISTINCT FROM` still matches.
  - **#60** decision 0004, the append-only audit architecture proposal.
  - **#61** decision 0005 plus 13 tests pinning `/api/migrate`'s six measured
    weaknesses as present behaviour.
- **Documentation corrected.** `CURRENT_STATUS.md` now names `4e63bb9` and
  carries both the new CI controls (flagged advisory) and the six unfixed
  `/api/migrate` weaknesses, so the file does not imply the route is sound.
  `CLAUDE.md` gains the two new library entries, pointers to decisions 0004 and
  0005, and two facts that are easy to get wrong: a row trigger does not fire
  on `TRUNCATE`, and no proposed layer prevents a compromised application
  appending fabricated audit rows.
- **Migration impact.** None.
- **Unresolved findings.** Branch protection is unset, so the new CI controls
  do not block merges. SHA-pinning of third-party actions is an open owner
  decision. All six `/api/migrate` weaknesses are unfixed by design — Phase 1
  of 0005 is the remedy and needs no credential decision. Audit immutability
  remains unenforced. Decision 0005's plan is **not rehearsed against
  production data**, and two defects in its Phase 4 were found by review rather
  than by me, which is the strongest available argument for performing Phase 0's
  restore-and-rehearse before anyone executes it.
- **Rollback.** Revert the documentation commit. The four merged PRs are
  independently revertible; none changed runtime behaviour on a money path.
- **Next recommended action.** Phase 1 of decision 0005 — `POST`-only, Origin
  check, operator rate limit, redacted errors on `/api/migrate`. It flips four
  of the six weaknesses, is reversible by revert, and depends on no credential
  or ownership decision. Owner actions, which no engineering task can
  substitute for: branch protection, the SHA-pinning decision, and Phase 0's
  backup restore.

### 2026-10-18 — Phase 1 migration hardening; progress report; access blockers recorded

- **Commit / PR.** PR #62 merged as `59b798d`. This entry's own change is on
  `security/migrate-phase1-hardening`; SHA and PR appended on push.
- **Purpose and scope.** Decision 0005 Phase 1 on `app/api/migrate/route.ts`,
  plus an owner-facing progress report and two runbooks for work that cannot be
  done from an engineering session. No production credential, schema,
  ownership or environment change. No live flag touched.
- **What changed in the route.**
  - **POST only.** `GET` answers 405 with `Allow: POST` and a `curl` hint
    rather than failing silently, because six documented procedures said GET.
    The CSRF path was real: the admin cookie is `sameSite: 'lax'`, which sends
    on top-level cross-site GET navigation, so one link click by an operations
    administrator ran ~103 DDL statements including a balance-table rewrite
    under `ACCESS EXCLUSIVE`.
  - **Origin validated before authentication**, so a forged request never
    reaches a credential lookup or the database. New `lib/request-origin.ts`.
  - **Operator path rate limited** — `schema:migrate-operator`, 6/hour keyed on
    admin id. It previously had none; only the anonymous branch did.
  - **Errors redacted** — generic message plus a short reference, with the full
    error logged against that reference, so diagnostics survive without
    disclosing table, column or constraint names to a possibly anonymous
    caller.
- **The lockout risk, and how it was avoided.** An absent `Origin` header is
  **allowed** deliberately. A browser always sends `Origin` on POST, so a
  request without one did not come from a browser and cannot be the cross-site
  forgery this guards against — what it usually is, is `curl`. Requiring the
  header would have disabled the anonymous auth-repair break-glass that exists
  because Release 1.0 locked production out. A CSRF control that creates a
  lockout is a worse trade than the one it prevents. No CSRF token was added
  for the same reason: there is no browser client to supply one, so a token
  would add nothing and break recovery. Mutation-checked — making the check
  reject an absent header fails 5 of 19 cases.
- **Callers verified before changing the method.** No code caller exists; the
  endpoint is operator-invoked only. Six documented procedures said GET and
  were updated: `CLAUDE.md` (x4), `GO_LIVE_RUNBOOK.md`, and
  `scripts/bootstrap-admin.ts` — including a **runtime error message** an
  operator reads when `admin_users` is missing, which would otherwise have
  told them to run a request that now 405s. `PROJECT_MEMORY.md`'s historical
  entries were deliberately left as written.
- **Tests run.** Suite 778 → **784 tests across 55 files** on a database
  created fresh for the run; typecheck clean, lint 0 errors / 28 warnings,
  build clean, `pnpm audit --prod` clean, both workflow files parse.
  `migrate-route-security.test.ts` grew 13 → 19 cases, with each weakness
  assertion inverted into a control assertion in the same change. Mutation-
  checked five ways: reverting to GET-only fails 11 of 19; removing the origin
  check 4; removing the operator limit 13; restoring the raw error string 1;
  and the lockout mutation above 5.
- **A real test interaction, not masked.** The new 6/hour limit engaged inside
  `migrate-route-execution.test.ts`, which legitimately runs the pipeline
  repeatedly to assert idempotency, and which failed with an audit count of 6
  instead of 7. Fixed by clearing the in-process counter in that file's run
  helper — the limiter itself stays covered in the security test, which asserts
  the 7th call is refused. The limiter was not weakened to make a test pass.
- **Residual weaknesses, recorded rather than closed.** No transaction across
  the pipeline, so a mid-pipeline failure still leaves the schema between
  versions; the route still requires table ownership, which is the coupling
  Phases 2–5 exist to resolve; and `clientIdentifier()` still trusts
  `x-real-ip` first, whose spoofability remains **unverified** because this
  environment cannot reach the deployment.
- **Progress report (Task 4).** `pnpm run status` renders a Markdown report
  from repository evidence, and CI appends it to the job summary with
  `if: always()`. No new web application: the Actions summary is already
  authenticated to whoever can see the repository, needs no credential or
  deployment, and is not publicly reachable. Statuses come from
  `scripts/status/readiness.json`, where each carries named evidence and a
  change is a reviewable diff — the script never infers a status and never
  reports a check it did not observe. No percentages, because there is no
  defined denominator.
- **Access blockers, verified not assumed.** Vercel is unreachable:
  `api.vercel.com` and the deployment host both return `403 CONNECT` from the
  egress proxy, no CLI is installed, no token or `.vercel/` exists. So the
  production SHA, preview SHA, environment isolation, logs, health and cron
  firing are **NOT RUN**, not passing. Branch protection: GitHub reports
  `master` as `protected: false`, so **none** of the four checks is required
  and the merged scanners remain advisory. The protection-detail endpoint 403s
  for lack of admin scope, but the branch record is authoritative on whether
  any protection exists.
- **Migration impact.** None. No schema change and no `/api/migrate`
  statement change — only the handler's guards.
- **Unresolved findings.** Everything under residual weaknesses above, plus:
  branch protection unset; third-party actions unpinned (proposal in decision
  0006, unimplemented because tag-to-SHA resolution 403s here and a guessed
  hash is worse than a tag); Phase 0 backup restore NOT RUN; CI's branch filter
  excludes PRs not targeting `master` or `integration/**`, so such a PR runs no
  checks at all.
- **Rollback.** Revert the commit. The only behavioural change is the
  endpoint's method and guards; reverting restores GET and the previous
  posture. No stateful change to undo.
- **Next recommended action.** Decision 0005 Phase 2 — migration versioning
  (`schema_migrations`), which the three hand-run files in `migrations/` already
  need and which Phase 3's runner depends on. It needs no production access.

---

## 2026-10-19 — Decision 0005 Phase 2: schema migration versioning

**Purpose and scope.** Give this codebase an answer to "is this database
current?", which it previously did not have. Adds `schema_migrations`, a
registry of the three authorization-gated files in `migrations/`, read-only
end-state detection per migration, drift detection by checksum, advisory-lock
concurrency protection, and a baseline adoption procedure for databases that
predate tracking. Adds no migration execution path — executing is Phase 3.

**Financial or security behaviour affected.** No balance, ledger, transfer or
auth behaviour changes. No schema statement in `app/api/migrate/route.ts` was
added, changed or removed other than creating the new tracking table. No live
flag touched. The migrate route now records that it ran, under the fixed id
`convergent_api_migrate`; that write is advisory and wrapped, so a recording
failure cannot fail a migration that already succeeded.

**The design decision that shapes everything else.** Detecting a migration's
end state is **not** knowing it ran. `upgradeLegacyMoneyColumns()` issues the
same `ALTER COLUMN … TYPE NUMERIC(14,2)` as
`migrations/20260907_money_real_to_numeric.sql`, and the migrate route calls
it — so a database with `numeric` money columns may have arrived there by the
authorized migration, by the route's convergence, or by being created that way,
and the catalogue cannot distinguish them. Adoption therefore records
`baseline_detected`, never `applied`. `baseline_unknown` blocks deliberately:
an unanswered question is the state in which a balance-rewriting migration gets
applied twice.

**Two defects found in my own work during this change, both by measurement
rather than review.**

1. *Session-scoped advisory lock over a connection pool.*
   `withMigrationLock()` took `pg_try_advisory_lock` on the pool handle.
   `postgres.js` is a pool, so the lock and the unlock can land on different
   backends, leaving the first holding it until recycled — a leaked lock that
   would block every later migration run with no visible cause. Fixed by
   reserving a connection (`sql.reserve()`), verified against `pg_locks`: one
   advisory row while held, zero after release, on both the success and the
   throw path. `initializeSchema()` avoids this with `pg_advisory_xact_lock`,
   which is pool-safe but unusable here because a runner must hold the lock
   across files that manage their own `BEGIN`/`COMMIT`.

2. *A statement moved out of the DDL transaction.* Inserting the new
   `CREATE TABLE` into `initializeSchema()` left the following statement using
   `db` (the pool) instead of `sql` (the transaction handle from
   `db.begin(...)`). Typecheck passed and the targeted test file passed; it
   surfaced as the **full suite hanging**, because
   `migrate-route-security.test.ts` connects with `max: 1` and the open
   transaction holds the only connection, so the pool request could never be
   served. Diagnosed from `pg_stat_activity` showing `idle in transaction /
   ClientRead` on that exact statement. Beyond the hang it would have created
   `webhook_dead_letters` outside the advisory-locked transaction in
   production, defeating the race-safety that lock exists for. Verified after
   the fix: zero statements using the pool handle inside the transaction body, and 62 using the transaction handle.

**A third defect, in the new test rather than the code.** The detection tests
dropped `idx_transfer_intents_correlation_id` from the shared database and
recreated it, which broke `stripe-settlement.test.ts`. Recreating in `afterAll`
would not have fixed it — vitest runs files in parallel, so the gap is a race.
Moved onto a uniquely named disposable database, following
`migrate-route-security.test.ts`. Recorded in CLAUDE.md as a rule.

**Tests run and results.** On a genuinely fresh PostgreSQL 16 database:
**57 files / 821 tests passing** (up from 56 / 788), typecheck clean, lint 0
errors / 28 warnings, build clean. `migration-versioning.test.ts` contributes
33 cases covering identifiers, checksums, outcome recording, `partial`-before-
work, refusal to re-begin an applied or failed migration, concurrency refusal
and lock release, `pg_locks` assertions on both paths, baseline adoption
against fresh and populated databases, drift, and the "is this current?"
question. No scratch databases leak.

**Commit / PR.** PR #64, branch `phase2/schema-migration-versioning`, initial
commit `4349bf4`; review fixes follow it on the same branch. The preceding
Phase 1 work merged to `master` as `6d8861c` (PR #63).

**Migration impact.** One new table, added to all three schema sources
(`lib/db.ts`, `app/api/migrate/route.ts`, `lib/__tests__/helpers/test-schema.sql`)
and to `scripts/verify-migrate.sql`. Existing databases get it on the next
`POST /api/migrate`. **An empty tracking table means "not adopted", not "no
migrations applied"** — adoption is `docs/runbooks/migration-baseline-adoption.md`
and has NOT been run against production.

**Unresolved findings.**
- Adoption has no first-class entry point. Measured: `pnpm tsx` fails (`tsx` is
  not a declared dependency) and `node --input-type=module` fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'` because Node does not
  resolve this repository's path alias. The working path today is the test
  runner, which is a test file doing an operator's job; a real entry point
  belongs with Phase 3.
- The no-transaction gap in `/api/migrate` is unchanged. The route now records
  a `failed` convergence row, so the state is visible, but visibility is not
  atomicity.
- Whether any of the three migrations was ever executed against production
  remains **unknown** and this phase does not change that. It establishes the
  current end state, which is the question that governs whether to apply again.

**Rollback requirement.** Revert the commit. The table is additive and unread
by any money path, so leaving it in place is also safe; the only behavioural
addition is the advisory convergence record.

**Next recommended action.** Owner: run the existing audited
`POST /api/admin/operations/redis-rate-limit` against production to settle the
shared rate-limit backend question, and set branch protection — `master` is
still `protected: false`, so none of the six green checks is enforced.
Engineering: Phase 3's `workflow_dispatch` runner, which is where adoption and
execution both get a real entry point.

---

## 2026-10-20 — REDIS_URL confirmed set in production (configuration, not operation)

**Purpose and scope.** Record an owner-reported configuration fact and correct
two documentation claims that were narrower than the code's behaviour. No code
change.

**What is now known.** The owner reports `REDIS_URL` is set for production
(2026-10-20). Name only — no value was requested, supplied, or held by the
engineering session, and the session still cannot reach Vercel (`403 CONNECT`).

**What is still NOT known, and why the distinction matters.** "The variable is
set" is not "limits are shared". Measured in `lib/rate-limit.ts`:

- `getRedis()` catches client construction failure, sets
  `redisUnavailable = true`, and returns null — the limiter then uses
  in-process counters.
- `checkRateLimit()` catches any command failure and does the same
  (line ~298), as does `verifyRateLimitBackend()` (line ~246).
- The **raw exception** is deliberately not logged, because a Redis client
  error can embed its credential-bearing connection URL. A generic degradation
  line *is* emitted to stderr (`Rate limiter: Redis unavailable, falling back
  to in-process counters.` / `Rate limiter: Redis command failed, using
  in-process counter.`), so the signal exists but carries no detail and is
  easy not to recognise as the diagnostic for a latched per-instance
  fallback.
- **The flag latches.** The only resets are `__setRedisClientForTests()` and
  `__resetRateLimitBackendForTests()`, both test-only. There is no production
  retry, so a degraded instance keeps counting in-process until it recycles.

So a configured Redis that stops answering makes each instance enforce the
limit locally. The aggregate allowance can reach `limit × instances`, and
callers *can* observe changed `allowed` and `remaining` results — `limit` is
`rule.limit` on both paths (`lib/rate-limit.ts:113` and `:291`) and never
changes —
what they do not receive is an explicit backend-failure signal. On serverless
the latch is bounded by instance lifetime, which mitigates but does not remove
it.

(This sentence said "invisibly to any caller" in the first draft. Review
caught the same overstatement in `CLAUDE.md`, I corrected it there and in
`readiness.json`, and missed this copy — a partial sweep of a claim that
appears in three files, which is the recurring shape of my errors on this
work.)

**Financial or security behaviour affected.** None changed. The correction
matters because the operator limit on `/api/migrate` and the auth-endpoint
limits were documented as stronger than the code guarantees.

**Readiness impact.** `Redis-backed rate limiting in production` moves from
BLOCKED to **PARTIAL**, not VERIFIED: configuration confirmed, operation
unproven. `POST /api/admin/operations/redis-rate-limit` run against production
with a session holding `exceptions:manage` (SuperAdmin or OperationsAdmin) is
the available evidence — already implemented and audited, performing an
isolated set/get/delete — but **it proves only the instance that served it.**
`redisUnavailable`, `redisClient` and `memoryCounters` are module-level
(`lib/rate-limit.ts:138`, `:137`, `:95`), so they are per serverless instance,
and another live instance can be latched into in-process counting while this
one answers pass. Serverless instances cannot be addressed individually, so
repeated POSTs give sampling confidence, not coverage. VERIFIED requires
evidence covering every live instance, or equivalent deployment-wide evidence —
which means monitoring the degradation signal, the unresolved finding recorded
below. The row stays PARTIAL on a passing POST. The POST remains an owner
action.

**Tests run and results.** Documentation and readiness data only; full suite
re-run to confirm nothing regressed: **57 files / 832 tests passing**,
typecheck clean, lint 0 errors / 28 warnings.

(A correction to how that run was described earlier in this entry's drafting:
"a fresh PostgreSQL 16 database" was not a sufficient instruction. A genuinely
empty database fails four files — `audit.test.ts`, `splits.test.ts`,
`stripe-settlement.test.ts`, `transfer-execution-safety.test.ts` — on rows
they do not create, because `.github/workflows/ci.yml` applies
`lib/__tests__/helpers/test-schema.sql` before running the suite and the
instruction in `CLAUDE.md` did not mention that step. A local URL also needs
`?sslmode=disable`, since `resolveSslMode()` defaults to `'require'`. Both
were hit while validating this change, and both are now written into the
testing section of `CLAUDE.md` with the failure each one produces. Same shape
as the rest of this round: an instruction that worked in the environment where
it was written, recorded as if it were general.)

**Commit / PR.** **PR #65**, branch `ops/redis-configuration-confirmed`,
initial commit `baf3dc9`; review fixes follow it on the same branch. Preceding
work merged as `6d8861c` (PR #63, Phase 1) and `1d4d783` (PR #64, Phase 2),
the latter confirmed 4/4 green on `master` post-merge.

(These fields were written as pending in the first draft of this entry, before
the PR existed and before the suite had been re-run. Filling them in is
completing an entry that has never been merged, not editing history — the
append-only rule governs the committed record, and this follows the Phase 1
entry's precedent of recording the SHA and PR after the push.)

**Migration impact.** None.

**Unresolved findings.** Two corrections review caught in the first draft of
this entry, both overstating how invisible the fallback is: it said callers
could see no behaviour change, when `limit × instances` changes `allowed` and
`remaining` and lets a caller spread requests across instances to exceed the
nominal limit — only the *failure signal* is absent; and it cited "an admin
session" for the verification route when that route requires the
`exceptions:manage` permission, i.e. SuperAdmin or OperationsAdmin, so a lesser
admin role gets a 403 that reads like a Redis outage.

A third correction, caught in the same review round: every place I wrote the
verification instruction — `CLAUDE.md`, `scripts/status/readiness.json`, this
entry, and the pre-flight step in
`docs/STAFF_ONLY_REAL_RAIL_TEST_MATRIX.md` — told the reader that running the
route once settles the question. It cannot. The backend state is module-level,
so one POST samples one serverless instance, and Vercel gives no way to
address the others. This supersedes the "Next recommended action" of the
Phase 2 entry above, which said to run the route to *settle* the shared
rate-limit backend question; running it is still worth doing, but it narrows
the question rather than closing it. Corrected by appending, not by editing
that entry.

The latching fallback has no production retry or
alarm. Worth considering a bounded retry, or surfacing
`activeBackend` from `verifyRateLimitBackend()` through a monitored path, so a
silent degradation is detectable without an operator running the route by
hand. Not built here — it is a behaviour change to a security control and
belongs in its own reviewed change.

**Rollback requirement.** Revert the commit; it is documentation and readiness
data only.

**Next recommended action.** Owner: run the verification route and report the
outcome (pass/fail only, no values). That does **not** move the row to
VERIFIED — it samples one serverless instance, and the per-instance module
state above means a pass says nothing about the others. The row reaches
VERIFIED only on deployment-wide evidence, i.e. the monitored degradation
signal in the unresolved finding above. Then branch protection, which is still absent — `master` is
`protected: false` and two PRs have merged on unenforced checks.

---

## 2026-10-21 — follow-redirects advisory: credential headers on the Plaid path

**Purpose and scope.** `pnpm audit --prod` began failing on `master` at
`c2859f6` with two newly published **high** advisories against
`follow-redirects@1.16.0`: GHSA-q3jh-wrc6-jgq8 (array-form headers bypass,
cross-origin credential stripping) and GHSA-8r9p-f939-6h3c
(`sensitiveHeaders` regex escaping can expose credential headers). Both are
patched in 1.16.1. Pinned forward with a `pnpm.overrides` entry.

**Why this one is not routine audit noise.** The dependency path is
`plaid > axios > follow-redirects`, and both advisories are about **credential
headers surviving a cross-origin redirect**. Plaid requests from this codebase
carry `PLAID-SECRET` and `PLAID-CLIENT-ID` — the exact header class the
advisories describe, on the exact client that carries them. `lib/plaid-error.ts`
exists precisely because those headers must never reach a log; this is the same
secret leaking by a different route.

**How it was fixed.** `follow-redirects` is transitive only — there is no direct
`axios` dependency to bump, and `plaid@42.2.0` pins `axios@1.20.0`, which pins
`follow-redirects@1.16.0`. A `pnpm.overrides` entry of `>=1.16.1` is therefore
the minimal correct fix; upgrading `plaid` would be a larger change with no
additional security benefit. Resolved tree confirmed at 1.16.1.

**Financial or security behaviour affected.** A credential-exposure path is
closed. No application code changed — one `package.json` block and the
lockfile.

**Tests run and results.** `pnpm audit --prod` → **no known vulnerabilities**
(was 2 high). `pnpm install --frozen-lockfile` succeeds, which is what CI and
Vercel both run, so the lockfile is consistent with `package.json` rather than
drifting — the failure mode `CLAUDE.md`'s single-lockfile rule exists to
prevent. Full suite **57 files / 832 tests passing**, typecheck clean. (832 not
844: this branch is cut from `master` and does not contain the Redis
degradation work.)

**Commit / PR.** Branch `sec/follow-redirects-advisory`, cut from `c2859f6`.
Not merged.

**Migration impact.** None.

**Unresolved findings.** The advisory surfaced only because post-merge CI runs
the audit on `master`; nothing alerts on a new advisory against an unchanged
tree. `master` also does not enforce the `dependency audit` check, so a failing
audit blocks nothing — see the branch-protection gap.

**Rollback requirement.** Revert the commit and the lockfile together. Doing so
restores a known high-severity credential-exposure path; prefer fixing forward.

**Next recommended action.** Owner: enforce branch protection so a failing
`dependency audit` actually blocks a merge. Engineering: header-trust
boundaries.

---

## 2026-10-25 — Sprint 1 Priority 1: two unauthenticated Next.js RCEs patched

**Purpose and scope.** `pnpm audit --prod` failed on `master`'s tree with three
advisories against `next@16.3.8`, all in the range `>=16.0.0 <=16.4.0` and all
patched in `>=16.4.1`:

| Severity | Advisory | Summary |
|---|---|---|
| **critical** | — | Unauthenticated **remote code execution** in Image Optimization |
| **critical** | GHSA-673q-mjm6-r5xr | Unauthenticated **remote code execution** in `use cache` functions returning typed arrays |
| high | GHSA-p3m5-59mp-jv5r | Denial of service in App Router using Server Actions |

Bumped `next` and `eslint-config-next` from `16.3.8` to `16.4.3`.

**Why this outranked the rest of the sprint.** Two of the three are
*unauthenticated remote code execution in the framework that serves the
application* — not a transitive library on one code path, but the HTTP layer in
front of every route, including `/api/transfers/*`, `/api/migrate` and the
webhook endpoints. The deployment is public at `carloscab74.vercel.app`. This is
a different class of exposure from the `follow-redirects` credential-header
advisory handled last week, which needed an attacker-influenced redirect on the
Plaid path; these need only a request.

**Version choice.** `16.4.1` is the minimum that clears all three. `16.4.3` was
taken instead because it is the same `16.3 → 16.4` minor step — the migration
risk is identical — and stopping at `16.4.1` would leave two later patch
releases unapplied for no benefit. `eslint-config-next` moved in lockstep; it
tracks `next`'s version in practice.

**Financial or security behaviour affected.** No application code changed: one
`package.json` dependency pair and the lockfile. Three remotely reachable
vulnerabilities, two of them RCE, are closed. No live-money flag, schema,
credential or ownership change.

**Tests run and results.** The build is the real risk of a minor framework bump,
and it is the check that would catch a breaking change:

| Check | Result |
|---|---|
| `pnpm audit --prod` | **no known vulnerabilities** (was 2 critical / 1 high) |
| `pnpm run build` | clean — all routes rendered, middleware compiled |
| `pnpm run typecheck` | clean |
| Tests | **57 files / 832 tests passing** |
| `pnpm run lint` | 0 errors / 28 warnings |
| `pnpm install --frozen-lockfile` | succeeds — lockfile moved with `package.json` |

**Commit / PR.** This entry's own commit on branch `sec/next-rce-advisories`;
the SHA is in the commit message. Not merged.

**Migration impact.** None.

**Unresolved findings.** How this was found is itself a finding. The advisories
were published after `6927ebd` was last green, so `master` sat with two
critical RCEs and a passing CI badge until a PR happened to re-run the audit —
the same mechanism that surfaced `follow-redirects` four days earlier. **Nothing
watches an unchanged tree.** Dependabot alerts are named in `ci.yml` as the
durable backstop but have never been confirmed enabled, and `master` does not
enforce the `dependency audit` check, so a failing audit blocks nothing. Two
occurrences in five days is a pattern, not a coincidence.

**Rollback requirement.** Reverting restores two unauthenticated RCEs. Do not
roll this back; fix forward if `16.4.3` causes a problem.

**Next recommended action.** Owner: merge this ahead of everything else in
Sprint 1, then confirm Dependabot alerts are enabled for the repository, then
branch protection so a failing audit can block a merge.

---

## 2026-10-25 — Sprint 1 Task D: every GitHub Action pinned to a commit SHA

**Purpose and scope.** All seven `uses:` references in `.github/workflows/`
named a mutable tag (`@v4`, `@v3`). A tag is a pointer the action's owner can
move, so whoever controls — or compromises — `actions/checkout` could repoint
`v4` and have it run here on the next job, with no diff and no review in this
repository. Pinned all of them to 40-hex commit SHAs, keeping a trailing
`# vN` so the version stays legible.

**Why it matters more than the usual supply-chain advice.** The jobs here are
not neutral. `actions/checkout` handles the job token; the secret-scan job
downloads and executes a third-party binary over the entire git history;
CodeQL's job holds `security-events: write`. A moved tag in any of those is
arbitrary code execution inside CI with those permissions. The existing
hardening already recognised this for the *binary* — Gitleaks is pinned by
version **and** verified against a published SHA256 — so the actions were the
remaining unpinned executable input.

**Provenance of the SHAs, which is the part worth checking.** This session's
GitHub access is scoped to `Carl-cab/carls-way`, so the action repositories
could not be read to resolve the tags (and should not be — the restriction is
explicit). The SHAs were instead taken from this repository's own CI run on
`6927ebd`, from the runner's `Download action repository 'owner/action@vN'
(SHA:…)` lines. That is *stronger* provenance than a separate tag lookup: it
pins to exactly the commits that produced the green checks on the current
`master`, rather than to whatever the tag points at now.

| Action | Pinned SHA |
|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `pnpm/action-setup` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `github/codeql-action` (init, autobuild, analyze) | `4bfa242aa49c5f7c6770b98670d354a7dfac05f8` |

**Financial or security behaviour affected.** No application code changed. A
CI supply-chain path is closed. No workflow trigger, permission, job name or
step semantics altered — verified by parsing both files and confirming the
four job names still read exactly `install · typecheck · lint · test · build`,
`dependency audit`, `secret scan`, `analyze javascript-typescript`, which are
the contexts branch protection must require.

**Why a test and not just the edit.** Pinning is easy to do once and easy to
lose: the obvious way to add a step is to copy `uses: owner/action@v4` from
documentation. Nothing in typecheck, lint or the build reads a YAML file, so an
unpinned action would reach `master` with six green checks and nothing would
notice. `lib/__tests__/workflow-action-pinning.test.ts` is the only thing in
the repository that would. It also asserts the workflow files are *found* —
without that, deleting the directory would make every other assertion pass
over an empty list, a green test guarding nothing.

**Tests run and results.** 4 new cases. Full suite **58 files / 836 tests
passing**, typecheck clean, lint 0 errors / 28 warnings,
`pnpm install --frozen-lockfile` succeeds. Mutation-checked: reverting one
action to `@v4` fails the SHA assertion (and the sweep), and removing a `# vN`
comment fails only the legibility assertion — each mutation caught by the
intended test.

**Also corrected:** `CLAUDE.md` said "57 files / 821 tests" while `master` was
actually at 57 / 832 — stale by eleven tests before this change touched the
line, which is exactly the drift the sentence beneath it warns about.

**Commit / PR.** Commit `f5d0554` on branch `ci/pin-actions-to-shas`, PR
**#68**, with `371a287` porting the `next` 16.4.3 security bump from PR #69.
This entry's own corrections follow in a later commit on the same branch. Not
merged.

**Migration impact.** None.

**Unresolved findings.**

- A CI run log recorded `##[warning]Node.js 20 is deprecated. The following
  actions target Node.js 20 but are being forced to run on Node.js 24:
  actions/checkout@v4, actions/setup-node@v4, pnpm/action-setup@v4`. This is
  about the *action runtime*, not the `node-version: 20` the jobs request, and
  it is unrelated to pinning — but pinning freezes the affected versions, so
  the eventual move to action majors that target Node 24 is now a deliberate
  bump rather than something a tag would have done silently. Recorded, not
  acted on.
- The full-tree advisory audit reports **2 critical, 13 high, 8 moderate** in
  devDependencies (vite, vitest, @vitest/mocker, brace-expansion, esbuild).
  These do not ship, the blocking tier audits `--prod` only and is clean, and
  that split is deliberate and documented in `ci.yml`. Worth a look for any
  that is newly fixable; none blocks a merge.

**Rollback requirement.** Revert the commit. Doing so restores mutable action
references; prefer fixing forward.

**Next recommended action.** Owner: branch protection remains the blocker —
see the Sprint 1 report. A write to
`PUT /repos/Carl-cab/carls-way/branches/master/protection` was *attempted*
this session and refused by the egress proxy with "Write access to this GitHub
API path is not permitted through this proxy", so enforcement is BLOCKED on
owner action rather than merely unattempted.

---

## 2026-10-25 — two review corrections on the Actions pinning (PR #68)

**Purpose and scope.** Review of `f5d0554` found two defects. Both real; one is
a bypass in the guard that commit added.

**1. The guard had a bypass (Minor, CWE-829).** The matcher required a bare
`uses:`. YAML accepts whitespace before the colon and a quoted key, so all of
these set the key `uses` and all of them run:

```yaml
- uses: owner/action@v4
- uses : owner/action@v4
- "uses": owner/action@v4
- 'uses': owner/action@v4
```

Verified against a YAML parser: each parses to `{uses: "owner/action@v4"}`. A
matcher requiring the bare form skips the other three, and because the
remaining steps still satisfy the seven-reference floor, **the suite would pass
while a mutable reference merged**. A guard with a bypass is worse than no
guard, because it is trusted.

All three matchers in the file — the line scanner, the legibility check and the
belt-and-braces sweep — now tolerate optional quotes and whitespace. Parsing
the YAML properly would be more thorough, but no YAML parser is available to
this project and adding a dependency to lint two files is out of proportion;
the reviewer said the same. So the blind spots are pinned by tests instead.

**The restructuring is the substantive part.** The scanner is now a function
over *text*, so the bypass spellings can be probed directly with synthetic
input rather than by mutating the real workflows. Six spellings are asserted
visible, a commented-out reference asserted ignored, and two cases assert that
every spelling reaches the SHA check. Mutation-checked: restoring the narrow
matcher fails five of them.

That matters beyond this file. The previous version could only test what was
already in `.github/workflows`, which means it could never have tested a form
the repository does not use — exactly where a bypass lives.

**2. The entry did not name its PR or SHA (Minor).** Corrected: commit
`f5d0554`, PR **#68**, with `371a287` porting the `next` security bump. The
learning recorded on PR #67 — that an entry cannot contain its own introducing
SHA — explains why it arrives a commit later, but it does not excuse omitting
the PR number, which was knowable at the time.

**Financial or security behaviour affected.** None in the application. A CI
supply-chain guard that could be bypassed by YAML syntax now cannot be.

**Tests run and results.** 13 cases in
`lib/__tests__/workflow-action-pinning.test.ts` (9 new, 4 → 13). Full suite
**58 files / 845 tests passing** (836 + 9), typecheck clean, lint 0 errors /
28 warnings.
Mutation-checked: narrowing `USES_LINE` back to `uses:` fails five cases.

**Commit / PR.** This entry's own commit on branch `ci/pin-actions-to-shas`,
PR **#68**; the SHA is in the commit message.

**Migration impact.** None.

**Unresolved findings.** The guard is a regex, not a parser. It now covers every
spelling of the key that YAML permits for a mapping, verified against a parser,
but a sufficiently exotic construction (a merge key, an anchor expanding to a
`uses` mapping) would still slip past. Recorded rather than built for: those
forms do not occur in hand-written workflows, and the cost of a YAML dependency
is not justified by them.

**Rollback requirement.** Revert the commit; the guard returns to a state where
`uses : owner/action@v4` is invisible to it.

**Next recommended action.** Unchanged: PR #69 first.

---

## 2026-10-26 — quoted action values in the pinning guard (PR #68)

**Purpose and scope.** A third review finding on the same guard, and the same
class of error for the third time: the matcher was wrong about what it was
reading. `USES_LINE` captured `(\S+)`, so a YAML quoted scalar
`uses: "owner/action@<40-hex>"` was captured *with* its closing quote, and the
`$`-anchored SHA assertion then rejected a correctly pinned action.

**Direction of the defect, stated plainly.** This one fails *closed*: it would
have blocked a future workflow that quoted its values, not admitted a mutable
reference. That makes it less dangerous than the `uses :` bypass it sits
beside, and worth fixing on the same grounds — a guard whose blind spots are
unprobed is trusted further than it has earned.

**Change.** Both matchers now exclude quote characters from the captured value
(`["']?([^\s"']+)`). Three spellings added to the synthetic matcher test
(double-quoted value, single-quoted value, quoted key *and* value) and two
quoted-value lines added to the SHA-acceptance case, including one with a
trailing `# v4` comment.

**Financial or security behaviour affected.** None in the application.

**Tests run and results.** 16 cases in
`lib/__tests__/workflow-action-pinning.test.ts` (13 → 16). Mutation-checked:
restoring `(\S+)` fails 4 cases.

**Commit / PR.** PR **#68**, branch `ci/pin-actions-to-shas`. The introducing
SHA is named in the follow-up entry rather than here, for the reason recorded
on PR #67 — an entry cannot contain its own commit's SHA.

**Migration impact.** None.

**Unresolved findings.** None open on this PR. The guard remains a regex rather
than a YAML parse; that trade-off and its cost are recorded above.

**Rollback requirement.** None — test-only change.

**Next recommended action.** Owner review and merge of #68.

---

## 2026-10-26 — attribution correction for two entries on PR #68

Appended, not edited: both entries above stay as written.

**What was missing.** Two entries on this branch left their introducing SHA
unrecorded. The entry "two review corrections on the Actions pinning" said
"the SHA is in the commit message", which does not put it in the entry. The
entry "quoted action values in the pinning guard" deferred its SHA to a
follow-up entry that was never written — so the deferral, which is legitimate
in itself, became a dangling promise.

**The SHAs.**

| Entry | Commit | PR |
|---|---|---|
| two review corrections on the Actions pinning (the `uses :` bypass) | `3927d2d` | #68 |
| quoted action values in the pinning guard | `ea707f4` | #68 |

Both on branch `ci/pin-actions-to-shas`, which also carries `f5d0554` (the
original pinning change), `371a287` (porting the `next` 16.4.3 bump from PR
#69) and `090d490` (merging `master` after #69 landed, resolving the
`PROJECT_MEMORY.md` append conflict).

**The pattern, since it is now three occurrences.** An entry cannot contain
the SHA of the commit that introduces it, so the SHA has to arrive one commit
later — and twice on this branch, and once on #70, that later commit recorded
something else and the SHA was forgotten. "Named in a follow-up entry" is only
true once the follow-up exists. The reliable form is to write the deferral and
the follow-up in the same working session, which is what this entry does.

**Financial or security behaviour affected.** None. Attribution only.

**Tests run and results.** No code change; the suite on this branch is **58
files / 848 tests passing** as of `090d490`.

**Commit / PR.** PR **#68**; this entry's own SHA is the one case the rule
genuinely cannot name, and nothing further is promised for it.

**Migration impact.** None. **Rollback requirement.** None.

**Next recommended action.** Owner review and merge of #68.

---

## 2026-10-26 — a latent time-dependent flake in the recovery suite (found via PR #68)

**How it surfaced.** CI failed on `c703ee0`, a commit that touched only
`PROJECT_MEMORY.md`. `install · typecheck · lint · test · build` reported **1
failed | 847 passed**:
`transfer-recovery-c1.test.ts > findStuckTransfers > flags a posted intent
stuck past 24h for manual review, not a fresh one`, with
`duplicate key value violates unique constraint
idx_transfer_intents_provider_reference`,
`Key (provider_reference_id)=(trf_c13_posted_1792977822725)`.

**The defect, which is on `master` and not in PR #68.** The test helper built
`provider_reference_id` as `trf_c13_${status}_${Date.now()}`. That column is
covered by a unique index, and the failing case inserts **two `posted`
intents back to back** — one aged 25 hours, one aged 1 hour. Two calls with
the same status inside one millisecond therefore produce the *same* reference
and the second insert raises 23505. Nothing about the assertion is wrong; the
fixture collides with itself, and whether it does depends on how fast the
runner is.

**Measured, not inferred.** Against a real database, the two inserts the test
makes:

| Reference scheme | First insert | Second insert |
|---|---|---|
| `trf_c13_posted_<ms>` (old) | ok | **rejected, 23505** |
| `trf_c13_posted_<ms>_<pid>_<n>` (new) | ok | ok |

**Fix.** A per-call counter plus a run tag (`Date.now()` and the pid). The
counter cannot collide within a run; the run tag keeps references distinct
across runs in a reused database, which the suite's own guidance warns about.

**Financial or security behaviour affected.** None — test fixture only. But
worth stating why it mattered: this suite exists because the stuck-transfer
query, the partial unique index and the `ON CONFLICT` sweep are database
behaviour a mock cannot verify. A fixture that fails on its own id generation
produces a red build that says nothing about the invariant under test, and a
red build nobody can attribute is how a suite stops being believed.

**Tests run and results.** Full suite **58 files / 848 tests passing**,
typecheck clean, lint 0 errors / 28 warnings. The collision reproduction above
was run separately against a disposable database.

**Commit / PR.** PR **#68**, branch `ci/pin-actions-to-shas`; SHA named in a
later entry, and this time the follow-up is written in the same session — see
the attribution-correction entry immediately above for why that matters.

**Migration impact.** None.

**Unresolved findings.** The fix is carried on #68 because #68's CI is what
went red and a separate PR would leave it red until that PR merged. It is
**not** related to action pinning, and it belongs to `master`: every open
branch shares the defect until one of them merges. Also unexamined: other
fixtures in the suite that build identifiers from `Date.now()` may have the
same shape. Not audited here, and not claimed to be clean.

**Rollback requirement.** None — reverting restores a flaky fixture.

**Next recommended action.** Owner review and merge of #68. Afterwards, a sweep
for other `Date.now()`-derived identifiers in fixtures would be cheap and is
worth doing once.

---

## 2026-10-21 — Redis degradation recovery: the latch is now a cooldown

**Purpose and scope.** `lib/rate-limit.ts` held `let redisUnavailable = false`,
set on the first Redis failure and cleared only by two test-only helpers. There
was no production reset path, so the flag latched: an instance that saw one
transient error counted in-process for the rest of its life, including after
Redis recovered. Replaced with a 30s cooldown that retries, plus non-secret
degradation accounting.

**Why it was worse than it reads.** `new Redis(url)` almost never throws —
ioredis connects lazily — so the construction `catch` was not the path that
fired during an outage. The *command* catch in `checkRateLimit()` was. One
dropped connection was therefore enough to convert every shared limit on that
instance to `limit × instances` permanently, `money:send` and
`money:transfer-execute` included. That is the "high-risk financial operations
must not silently lose their intended shared velocity protection" case.

**Financial or security behaviour affected.** Rate limiting is a security
control, so this is a deliberate behaviour change. Fail-open is **preserved**:
a Redis outage still yields a decision rather than a refusal, and a test
asserts it for `schema:bootstrap` specifically, because refusing there would
make `REDIS_URL` a hard dependency of the only schema-migration path — the
Release 1.0 lockout shape. Fail-closed by risk class was considered and **not**
implemented: refusing `money:send` during a Redis outage blocks customer
payments, which is a policy decision for the owner, not a change to slip into
a hardening commit. No balance, ledger, provider or credential path is touched.
No live-money flag changed.

Three further properties kept deliberately: the raw exception is still never
logged (a Redis client error can embed its credential-bearing URL — asserted by
a test that the line contains neither the password nor the host); construction
is now serialised through one in-flight promise, because N concurrent cold
requests each ran `new Redis(url)` and leaked all but the last; and
`__setRedisClientForTests()` no longer clears the degraded flag, since nothing
in production clears it as a side effect of acquiring a client and a helper
that did would hide the transition the new tests exist to observe.

**Tests run and results.** `lib/__tests__/rate-limit-degradation-recovery.test.ts`,
12 new cases across degradation recording, cooldown bounding, recovery,
concurrency, shared accounting with the verification route, and preserved
fail-open. Full suite **58 files / 844 tests passing** on a fresh database with
the CI fixture applied; typecheck clean; lint 0 errors / 28 warnings.
Mutation-checked: restoring the permanent latch (`redisDownUntil > 0` instead
of `Date.now() < redisDownUntil`) fails three cases, including "retries once
the cooldown has elapsed, and recovers".

**Commit / PR.** Commit `487b789` on branch `ops/redis-degradation-recovery`,
PR **#67**, opened against `c2859f6` (the PR #65 merge). Not merged.

**Migration impact.** None.

**Readiness impact.** `Redis-backed rate limiting in production` stays
**PARTIAL**, per the owner's instruction and on the merits: the never-recovers
failure mode is gone and a fallback is now locally observable, but the counters
are still per serverless instance and nothing external scrapes the signal. A
passing verification POST still samples one instance.

**Unresolved findings.**

- Nothing *consumes* `rateLimitBackendHealth()` yet. The signal exists; the
  alerting does not. That is the next step and it is an operations change, not
  a code one.
- Fail-closed-versus-fail-open by endpoint risk class remains an open owner
  decision, recorded above.
- `clientIdentifier()` still prefers an unvalidated `x-real-ip`. Untouched
  here on purpose — see the header findings; it needs its own change.
- Separately and more urgently: `pnpm audit --prod` began failing on `master`
  at `c2859f6` with two newly published **high** advisories in
  `follow-redirects` 1.16.0 (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c), reached
  via `plaid > axios > follow-redirects`. Both concern credential-header
  exposure across a cross-origin redirect, and Plaid requests carry
  `PLAID-SECRET` and `PLAID-CLIENT-ID`. Patched in 1.16.1. Handled in its own
  change ahead of this one.

**Rollback requirement.** Revert the commit. The previous behaviour was the
latch, so a rollback reinstates a known defect rather than a neutral state —
prefer fixing forward.

**Next recommended action.** Owner: decide fail-open versus fail-closed by risk
class, and whether `rateLimitBackendHealth()` should be surfaced on an
authenticated operations route for scraping. Engineering: the
`follow-redirects` advisory first, then header-trust boundaries.

---

## 2026-10-21 — three review corrections on the Redis cooldown (PR #67)

**Purpose and scope.** Review of `6bf491e` found three defects; all three were
verified against source before changing anything, and all three were real.

**1. A connection leak, introduced by the fix itself (Major).**
`markRedisDegraded()` set `redisClient = null` on every stage, including a
*command* failure. Nothing calls `quit()` or `disconnect()` on the abandoned
instance, so its socket and its own reconnect loop keep running while the next
request after the cooldown constructs a brand new client. Repeated outages
accumulate orphans — the same leak the serialised construction in that very
commit exists to prevent, reintroduced one function later. Now only a
`'construct'` failure discards the client; a command or verify failure keeps it,
which also keeps ioredis's own reconnect machinery. `rateLimitBackendHealth()`
already guarded `activeBackend` on `!inCooldown`, so retaining the client does
not make health claim Redis is in use — asserted by a new test.

**2. A self-contradicting readiness row (Minor).** The evidence string in
`scripts/status/readiness.json` still said the limiter "sets
`redisUnavailable=true`" and that "the flag LATCHES — the only resets are
test-only", and cited `lib/rate-limit.ts:138` for a variable the same commit
deleted. The suffix appended in that commit then said the latch had been
replaced, so one field described one control two contradictory ways. The cause
was mine: I **appended** to a current-status file as though it were
append-only. Only `PROJECT_MEMORY.md` is. Rewritten to describe `redisDownUntil`
and the cooldown, keeping the per-instance PARTIAL rationale and one explicit
note that an earlier version described the old latch.

The same stale claim was in two files the review did **not** flag —
`CLAUDE.md`'s `REDIS_URL` row and the pre-flight step in
`docs/STAFF_ONLY_REAL_RAIL_TEST_MATRIX.md` — found by sweeping for the class
rather than the cited line. Both corrected. Line-number citations are now
dropped rather than updated: `:138`, `:137`, `:95` went stale within a day of
being written, which is an argument against citing lines in prose at all.
The copy at `PROJECT_MEMORY.md:772` is in an already-merged entry and is
corrected here by appending, not by editing it.

**3. A test whose name over-claimed (nitpick, and the most instructive).**
"serialises in-flight construction so concurrent callers share one client" ran
with no `REDIS_URL`, so `getRedis()` returned `null` before it ever read
`redisConstruction`. It would have passed with the serialisation deleted.
Replaced with an isolated case that mocks `ioredis`, re-imports the module and
asserts the constructor is called exactly once under five concurrent callers;
the original is kept under an honest name covering what it actually tests. This
is the fourth defect of the same shape in this work — a check covering part of
its subject, described as covering all of it — and this time it was in the
coverage claim for a leak fix.

**Financial or security behaviour affected.** No behaviour change beyond the
leak fix. Rate limiting still fails open, still never logs the raw exception.

**Tests run and results.** 15 cases in
`lib/__tests__/rate-limit-degradation-recovery.test.ts` (3 new). Full suite
**58 files / 847 tests passing**, typecheck clean, lint 0 errors / 28 warnings.
Mutation-checked individually: discarding the client on every stage fails
"keeps the client across a command failure instead of orphaning it", and
removing the in-flight promise fails "constructs the Redis client once under a
concurrent cold start" — one test each, neither failing for the other's reason.

**Commit / PR.** Commit `6b4433a` on branch `ops/redis-degradation-recovery`,
PR **#67**. Not merged.

**Migration impact.** None.

**Readiness impact.** Unchanged: still **PARTIAL**.

**Unresolved findings.** As in the preceding entry — nothing consumes
`rateLimitBackendHealth()`, fail-open versus fail-closed by risk class is an
owner decision, and `clientIdentifier()` still prefers an unvalidated
`x-real-ip`.

**Rollback requirement.** Revert the commit; the prior state carries the
connection leak.

**Next recommended action.** Unchanged: merge #66 first, then branch
protection, then this PR.

---

## 2026-10-21 — the verification route's non-throwing failures now open the cooldown (PR #67)

**Purpose and scope.** `verifyRateLimitBackend()` has two failure branches that
return **without throwing**: the read-back marker not matching, and the cleanup
`del` not removing exactly one key. Both returned
`verification: 'failed'` with `activeBackend: 'in_memory_fallback'` while
recording nothing, so the catch never saw them and no cooldown opened. The
route therefore answered "the backend failed" while `rateLimitBackendHealth()`
still reported `redis` and the next `checkRateLimit()` retried the retained
client. One function, two contradictory answers about one control.

Both branches now call `markRedisDegraded('verify')` before returning, so the
answer, the health report and the limiter's next action agree.

**The asymmetry is deliberate and is now pinned by a test.** The third branch,
`NX` refusing the write, does **not** record a degradation and must not. `NX`
refusing means the key already existed, which proves Redis answered correctly —
the probe simply could not claim its name. Opening a cooldown there would
demote a healthy backend on a 1-in-2^122 UUID clash. A comment says so at the
branch, specifically to stop a future reader adding the call "for symmetry",
and a test asserts the count stays zero.

**Why this surfaced now.** The inconsistency predates this PR, but the previous
code discarded the client on every failure and set a permanent latch, so the
window was narrower. Retaining the client — the correct fix for the connection
leak — is what made it reachable, which is a fair example of one fix exposing
the next.

**Financial or security behaviour affected.** Rate limiting only, and in the
conservative direction: a verification failure now degrades the instance
rather than leaving it claiming a backend it just failed to use. Still fails
open. Raw exception still never logged.

**Tests run and results.** 18 cases in
`lib/__tests__/rate-limit-degradation-recovery.test.ts` (3 new). Full suite
**58 files / 850 tests passing**, typecheck clean, lint 0 errors / 28 warnings.
Mutation-checked in both directions: removing the two new calls fails exactly
the two new branch tests, and adding the call to the collision branch fails the
asymmetry test. Neither mutation is caught by the other's test.

**Commit / PR.** Commit `c753907` on branch `ops/redis-degradation-recovery`,
PR **#67**. Not merged.

**Migration impact.** None.

**Readiness impact.** Unchanged: **PARTIAL**.

**Unresolved findings.** As before — nothing consumes
`rateLimitBackendHealth()`, fail-open versus fail-closed by risk class is an
owner decision, and `clientIdentifier()` still prefers an unvalidated
`x-real-ip`.

**Rollback requirement.** Revert the commit.

**Next recommended action.** Unchanged: merge #66 first, then branch
protection, then this PR.

---

## 2026-10-21 — corrections: missing commit SHAs, and two now-stale merge notes

**Purpose and scope.** Review of `69ee273` noted that the entry for the
verification-path fix recorded PR #67 but no implementing commit SHA, which the
governance rule in `CLAUDE.md` requires for every material change ("commit SHA
and PR"). Correct, and it applied to more than the flagged entry: **three** of
this branch's entries named only the branch and PR. Each now carries its SHA —
`487b789` (the cooldown), `6b4433a` (the three review corrections), `c753907`
(the verification path) — filled in on entries that have never been merged,
which completes them rather than editing history, the same precedent as the
Phase 1 entry.

**Two notes that the merges made stale, corrected here by appending rather
than edited in place, because both are now history:**

- The `follow-redirects` entry reads "Branch `sec/follow-redirects-advisory`,
  cut from `c2859f6`. Not merged." It **is** merged: commit `939bb91`, PR #66,
  merged as **`6927ebd`**. Post-merge CI on `master` was 4/4 green and
  `pnpm audit --prod` reports no known vulnerabilities.
- The Phase 2 and Phase 1 references elsewhere stand as written.

**This branch's own state**, so the record is not left implying otherwise:
`69ee273` merges `master` after #66 landed, resolving an append-only conflict
in this file by keeping both sides; `207eb66` adds docstrings to
`rateLimitBackendHealth()` and `getRedis()` after a docstring-coverage check
reported 66.67% against an 80% threshold on the functions this diff touches.
`checkInMemory` predates the PR and was deliberately left alone rather than
widening the diff.

**Financial or security behaviour affected.** None. Documentation only.

**Tests run and results.** 58 files / 850 tests passing, typecheck clean,
lint 0 errors / 28 warnings.

**Commit / PR.** This entry's own commit on branch
`ops/redis-degradation-recovery`, PR **#67**. Recorded in the commit message,
since an entry cannot name the SHA of the commit that introduces it — which is
why the three SHAs above were added one commit later rather than at the time.

**Migration impact.** None.

**Unresolved findings.** None new. The open items on this PR are unchanged:
nothing consumes `rateLimitBackendHealth()`, fail-open versus fail-closed by
risk class is an owner decision, and `clientIdentifier()` still prefers an
unvalidated `x-real-ip`.

**Rollback requirement.** Revert the commit; documentation only.

**Next recommended action.** Owner: branch protection, then #67.

---

## 2026-10-21 — health reported Redis on a timer rather than an observation

**Purpose and scope.** `rateLimitBackendHealth()` computed
`activeBackend: redisClient && !inCooldown ? 'redis' : …`. Once the 30s
cooldown elapsed it reported `redis` — but the retained client is the one that
just failed, and nothing had yet proved it works, so the very next
`checkRateLimit()` could fall straight back to in-process counting while the
health snapshot claimed shared limiting. The claim rested on a clock expiring,
not on an observation. `degraded` is now part of the condition, and it clears
only when a real Redis operation succeeds.

**Second half, needed for the first to be usable.** `markRedisHealthy()` was
called from exactly one place — the `checkRateLimit` success path — so a
*passing operator verification* did not clear the flag. With `!degraded` added,
that would have left health reporting the fallback indefinitely after the
verification route said the backend was fine: the route and the health report
disagreeing about one backend, which is the defect this same function already
had once in the other direction. A completed set/get/delete round trip is proof
the backend works, so it now clears the flag too.

**The asymmetry holds, and is tested.** Neither an `NX` collision nor a failed
cleanup reaches the clearing call, and neither should: `NX` refusing is not a
backend failure, but it is not evidence of health either, so it must neither
record nor clear a degradation.

**Why this one is a fair catch rather than a regression.** It is the third
finding in this PR of a single shape — *a state report disagreeing with what
the code will actually do next* — and each has been in a different direction:
the verification path recording nothing, health lying pessimistically about a
retained client, and now health lying optimistically after a timer. Worth
naming because the shape, not the instance, is what to look for here.

**Financial or security behaviour affected.** Reporting only. No limit
decision changes. Still fails open; raw exception still never logged. The
direction is conservative: health now under-claims until recovery is observed.

**Also corrected:** the docstring added one commit earlier said health
"reports the fallback whenever a cooldown is open", which is now too narrow —
it reports the fallback until a success is observed. Rewritten rather than left
to go stale, since that is the error this PR has already corrected twice.

**Tests run and results.** 21 cases in
`lib/__tests__/rate-limit-degradation-recovery.test.ts` (3 new). Full suite
**58 files / 853 tests passing**, typecheck clean, lint 0 errors / 28 warnings.
Mutation-checked both halves: dropping `!degraded` fails three cases including
the new post-cooldown one; removing `markRedisHealthy()` from the verification
success path fails exactly one, and not the others.

**Commit / PR.** This entry's own commit on branch
`ops/redis-degradation-recovery`, PR **#67**; the SHA is in the commit message,
per the note in the preceding entry.

**Migration impact.** None.

**Readiness impact.** Unchanged: **PARTIAL**. If anything this strengthens the
case for the row staying there — the health signal is now honest about not
knowing, which is what a monitored path needs.

**Unresolved findings.** Unchanged: nothing consumes
`rateLimitBackendHealth()`, fail-open versus fail-closed by risk class is an
owner decision, `clientIdentifier()` still prefers an unvalidated `x-real-ip`.

**Rollback requirement.** Revert the commit; the prior state over-reports
backend health in a bounded window.

**Next recommended action.** Owner: branch protection, then #67.
