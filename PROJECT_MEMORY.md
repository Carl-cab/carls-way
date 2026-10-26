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

## 2026-10-25 — Sprint 1 documentation: status records brought current

**Purpose and scope.** Sprint 1's engineering sits on five branches with open
PRs; this brings the three status records in line with what is actually true of
`master`, and records what Sprint 1 did and did not establish.

**The stalest claim, corrected.** `CURRENT_STATUS.md` read "verified against
commit `6d8861c`" with "57 files / 821 tests" while `master` had moved on three
times (`1d4d783`, `c2859f6`, `6927ebd`) and the suite had reached 832. Both
numbers were stale in the direction that invites trust — a file that reads as
confirmation, confirming something four commits old. This is the second time
this file has needed that correction; the first was a stale *date* on current
content, and the note about it is still in the file.

**Task G: coverage inventoried rather than expanded.** Every area the sprint
named already has isolated coverage — duplicate financial requests, concurrent
transfer execution, Redis failure during sensitive operations, webhook delivery
failure and retries, dead-letter recovery, unknown transfer outcomes, ledger
consistency, reconciliation discrepancies, migration interruption. My first
sweep appeared to show gaps in dead-letter, webhook-retry and unknown-outcome
coverage; that was a too-narrow grep (hyphens and camelCase), and checking
variants found nine, three and eleven files respectively. **No tests were added
for Task G**, because adding them would have been duplicating coverage to look
productive. The suite runs in sandbox only; no production ledger was touched
and no real money moved.

**Status changes recorded.** `scripts/status/readiness.json` gains two rows
(Actions supply-chain pinning; production dependency advisories), and four rows
have their evidence rewritten. `PRODUCTION_READINESS_BACKLOG.md` gains an
appended Sprint 1 block rather than in-place re-marking, per the governance
rule. Owner actions are now ordered with PR #69 first, because `master` is
carrying two unauthenticated RCEs.

**Three things deliberately NOT advanced**, stated because a sprint report is
where false completion gets manufactured:

- **Phase 0 stays NOT RUN.** The procedure is validated synthetically; no
  production backup was inspected and no production restore performed. The
  0.20 s restore duration is not an RTO input and is labelled as such
  everywhere it appears.
- **Vercel operational verification stays NOT RUN in every particular** —
  production SHA, health, Redis behaviour, `CRON_SECRET`, cron firing, logs,
  error monitoring, alert ownership. Both `api.vercel.com` and the deployment
  host answer `403 CONNECT`, re-confirmed today; no CLI, no token.
- **No business gate moved.** Bank linking, domestic movement and cross-border
  movement are where they were. Both live flags remain off and neither was
  touched. Sprint 1 was security and recovery foundations.

**Financial or security behaviour affected.** The status records themselves are
documentation only. But this branch is **not** documentation-only: it carries
the `next` 16.3.8 → 16.4.3 bump, ported here so a status branch cannot
reintroduce a version with two unauthenticated RCE advisories
(GHSA-673q-mjm6-r5xr among them) and a DoS, all patched in `>=16.4.1`.
Merging this branch therefore clears the advisory on `master` as a side effect
— which is also why the readiness action no longer names PR #69 as the only
route. It does not clear the **running deployment**, which carries whatever
the last build produced.

(An earlier version of this line read "None. Documentation and readiness data
only," which was wrong about the branch's own diff.)

**Tests run and results.** Full suite on this branch **57 files / 832 tests
passing** (documentation-only on top of `master`), typecheck clean, lint
0 errors / 28 warnings, `readiness.json` parses and the report renders.

**Commit / PR.** This entry's own commit on branch `docs/sprint1-status`; the
SHA is in the commit message. Carries the `next` 16.4.3 bump ported from PR #69
so CI is green. Not merged.

**Migration impact.** None.

**Unresolved findings.** The pattern worth carrying out of this sprint: two
dependency advisories reached `master` in five days, both *after* its last
green run, and both were found only because an unrelated PR re-ran the audit.
Green CI on an unchanged tree is not evidence of a clean tree. Dependabot
alerts are named in `ci.yml` as the backstop and have never been confirmed
enabled — that is now the first-order gap, ahead of anything else in the CI
configuration.

**Rollback requirement.** Revert the commit; documentation only.

**Next recommended action.** Owner: PR #69, then branch protection, then
confirm Dependabot.

---

## 2026-10-26 — two corrections to the Sprint 1 corrections (PR #72)

**1. The header-trust owner action still could not answer the question.**
The previous round corrected it from one production request to two, but kept
it to reporting `clientIdentity().source` for each. That does not settle
anything: if both requests select `x-vercel-forwarded-for`, **the source name
is identical whether the platform overwrote the forged value or passed it
through.** What distinguishes the two cases is an *equality* — does the
resolved id equal the distinctive value that request supplied? The action now
asks for that boolean per request, alongside the source name, and explicitly
not the id or the IP. Had this gone to the owner as written, two source names
would have come back and the question would have looked answered while being
untouched.

**2. The shape guard added yesterday reproduced the bug it was added for.**
It tested truthiness, so `action: []` passed, the template literal rendered it
as the empty string, and the report emitted `|  |  |` with **exit 0** — a
silent empty row, which is exactly the failure mode the guard exists to catch.
Measured before and after. It now requires a non-empty string for both fields;
mutation-checked, an array entry gives exit 1.

That is the third fix in this review round to carry the defect it was fixing
(the earlier two: a blacklist gate corrected with another blacklist, and a
pinning matcher widened for quoted keys but not quoted values). The pattern is
worth naming: a fix written while holding one example in mind tends to cover
that example and not the class.

**Financial or security behaviour affected.** None directly. One of the two
is a security *question* whose answer was about to be mis-recorded.

**Tests run and results.** `readiness.json` parses (13 rows, 8 actions), the
report renders 8 owner-action rows with zero `undefined` and zero empty cells,
and an array-valued entry exits 1. Full suite unchanged at **57 files / 832
tests passing**.

**Commit / PR.** PR **#72**, branch `docs/sprint1-status`; SHA in a following
entry, per the PR #67 learning.

**Migration impact.** None.

**Unresolved findings.** The header-trust question itself remains open and is
now the only owner action whose wording has been corrected twice.

**Rollback requirement.** None.

**Next recommended action.** Owner review and merge of #72.

---

## 2026-10-26 — correction to the 2026-10-25 rollback line (PR #72)

Appended, not edited: the earlier entry stays as written.

**What was wrong.** Its **Rollback requirement** read "Revert the commit;
documentation only." The status and readiness edits are documentation only, but
the branch also carries `next` and `eslint-config-next` 16.3.8 → 16.4.3 and the
matching `pnpm-lock.yaml` change. **Reverting this PR therefore reverts that
bump and reintroduces two unauthenticated RCE advisories** (Image
Optimization; `use cache` typed arrays, GHSA-673q-mjm6-r5xr) plus a DoS
(GHSA-p3m5-59mp-jv5r). A rollback instruction is read under time pressure, so
one that omits a security consequence is worse than none.

**The correct instruction.** To undo the status-record changes, revert only the
documentation files — `CURRENT_STATUS.md`, `PRODUCTION_READINESS_BACKLOG.md`,
`scripts/status/readiness.json`, `scripts/status/report.mjs` and this file.
Leave `package.json` and `pnpm-lock.yaml` at 16.4.3 unless the bump itself is
being rolled back deliberately, and then only with the advisories in view.

**Also stale in that entry.** Its "Next recommended action" names PR #69 as
the route to clearing the advisory. The same bump rides on #68, #70, #71 and
#72, so whichever merges first clears `master`; #69 is merely the smallest
such PR. Corrected in `readiness.json` and `CURRENT_STATUS.md` by `8a33404`,
and noted here so the chronological record is not left pointing at one branch.

**Financial or security behaviour affected.** None by this append. It corrects
a *procedure* whose previous wording would have silently undone a security fix.

**Commit / PR.** PR **#72**, branch `docs/sprint1-status`; SHA in a following
entry per the PR #67 learning.

**Migration impact.** None. **Rollback requirement.** None — this entry is
itself the correction.

**Next recommended action.** Owner review and merge of #72.

---

## 2026-10-26 — the rollback correction over-corrected (PR #72)

The entry above says reverting this PR "therefore reverts that bump". That is
true only in one case, and stating it unconditionally replaced an under-claim
with an over-claim.

**The condition.** `master` is at `6927ebd` carrying `next@16.3.8`, verified
just now; this branch carries `16.4.3`. The same bump rides on #68, #70, #71
and #72. So:

- If **#72 merges first**, its merge is what moves `master` to `16.4.3`, and
  reverting it does reintroduce the advisories.
- If **another carrier merges first**, `master` is already at `16.4.3` and
  #72's `package.json`/`pnpm-lock.yaml` diff against it is empty. Reverting
  #72 then touches no dependency and the advisories stay fixed.

**So the correct instruction is conditional:** before reverting any of these
five PRs, check whether the one being reverted is the carrier that moved
`master` to `16.4.3` — `git log -1 --format=%H -- package.json` on `master`
answers it. If it is, revert only the documentation files and leave
`package.json` and `pnpm-lock.yaml` alone. If it is not, a full revert is
safe on that axis.

**Why this is recorded rather than quietly edited.** It is the fifth correction
this round to a correction of mine, and the second where the fix overshot
rather than fell short. The failure mode is consistent enough to be worth
stating: having found an under-claim, I asserted its opposite without checking
whether the opposite held in every case. The check here took one command.

**Financial or security behaviour affected.** None. A rollback procedure's
precision.

**Commit / PR.** PR **#72**, branch `docs/sprint1-status`; SHA in a following
entry per the PR #67 learning.

**Migration impact.** None. **Rollback requirement.** None.

**Next recommended action.** Owner review and merge of #72. Note that
CodeRabbit has auto-paused reviews on this PR and on #70 after the volume of
commits; last reviewed commits are `551ee88` and `44dbd7d`, both current heads,
so nothing is unreviewed — but a further push to either will not be reviewed
automatically until someone resumes it.
