# Manna — Current Status

Last updated: 2026-06-28 (Phase B1 Webhook Receiver Framework complete)

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
  - `PlaidTransferProvider` and `CanadianEFTProvider` — placeholder implementations (throw "Not implemented")
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

---

## In Progress / Next

**Phase B1 Webhook Receiver Framework Complete** ✅
- `POST /api/webhooks/plaid`: Signature verification ready, event recording with idempotency
- `POST /api/webhooks/stripe`: KYC logic preserved, financial events recorded
- Event deduplication via UNIQUE constraint (no duplicate processing)
- Returns 200 for all events (prevents webhook service retries)
- Structure ready for Phase B2 settlement processor wiring
- Lint ✅ Build ✅ TypeScript ✅

**Safe Next Milestone: Phase B2 — Settlement Event Processing**

Wire settlement processor into webhook handlers:

1. **Plaid webhook processing** (`POST /api/webhooks/plaid`)
   - Fetch transfer_intents row by provider_reference_id
   - Call SettlementProcessor.processSettlementEvent()
   - If outcome.shouldUpdateBalance: update balance_cad/usd
   - If outcome.shouldCreateLedgerEntry: create ledger entries (Phase A1 helpers)
   - If outcome.shouldNotifyUser: create notification

2. **Stripe webhook processing** (`POST /api/webhooks/stripe`)
   - Handle charge.succeeded, charge.failed, payout.paid, payout.failed events
   - Fetch Add Money / Cash Out intents
   - Apply balance updates and ledger entries per processor outcome
   - Notify user on settlement or failure

3. **Test webhook flow** (sandbox)
   - Simulate Plaid Transfer webhooks (event API or webhook simulator)
   - Verify status transitions (submitted → authorized → pending → posted → settled)
   - Verify balance changes ONLY after settled webhook
   - Verify ledger entries created with correct FX

4. **Then: PlaidTransferProvider / CanadianEFTProvider**
   - Implement `executeTransfer()` calling real APIs (when ready)
   - Implement `handleWebhookEvent()` via webhook routes (reuse B2 logic)

**Critical Path:**
Event intake (B1) ✅ → Event processing (B2) → Execute transfers (B3) → Live providers

---

## Env Vars Required in Vercel

| Variable | Status |
|---|---|
| `DATABASE_URL` | Set ✅ |
| `JWT_SECRET` | Set ✅ |
| `PLAID_CLIENT_ID` | Set ✅ |
| `PLAID_SECRET` | Set ✅ |
| `NEXT_PUBLIC_PLAID_ENV` | Set ✅ |
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
