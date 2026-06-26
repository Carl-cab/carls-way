# Manna — Banking Architecture

> Authoritative reference for how money moves in and out of Manna. Covers the provider abstraction, current sandbox state, US and Canadian live integration plans, compliance obligations, and database schema. Update this document when any provider, route, or schema changes.

Last updated: 2026-06-26

---

## Contents

1. [Principles](#1-principles)
2. [Provider Abstraction](#2-provider-abstraction)
3. [Transfer Flow — 3 Steps](#3-transfer-flow--3-steps)
4. [Status State Machine](#4-status-state-machine)
5. [Current State — Sandbox](#5-current-state--sandbox)
6. [US Live Integration Plan — Plaid Transfer](#6-us-live-integration-plan--plaid-transfer)
7. [Canadian Live Integration Plan](#7-canadian-live-integration-plan)
8. [Database Schema](#8-database-schema)
9. [Webhook Architecture](#9-webhook-architecture)
10. [Velocity Limits](#10-velocity-limits)
11. [Compliance Obligations](#11-compliance-obligations)
12. [Launch Sequencing](#12-launch-sequencing)
13. [Adding a New Provider](#13-adding-a-new-provider)
14. [Environment Variables](#14-environment-variables)

---

## 1. Principles

These rules apply to every provider, current and future. No exceptions.

**Money safety**
- Balance is never updated until a webhook confirms settlement. Never on `draft`, never on `processing`.
- Balance updates use atomic SQL (`SET balance_cad = balance_cad + ${amount}`) — never read-modify-write in application code.
- A failed or returned transfer must trigger `reverseVelocity()` to undo the velocity budget consumed at confirm time.

**Security gates — in order, every time**
1. `getAuthUser()` — valid JWT required
2. `kyc_status = 'verified'` — server-side check, never trusted from client
3. `is_token_encrypted = true` on the bank account — `requireEncryptedBankToken()` from `lib/plaid.ts`
4. `checkVelocityLimit()` — checked at intent creation, recorded at confirm
5. Idempotency key on every real transfer call — prevents duplicate debits/credits on retry

**Sandbox guard**
- `executeTransfer()` throws on all sandbox providers. It is structurally impossible to accidentally initiate a live transfer while in sandbox mode.
- `execution_mode` is stored on every `transfer_intents` row. Rows where `execution_mode = 'sandbox'` are never acted upon by any live provider.

**Regional separation**
- US users use US payment rails only (ACH). Never route a US user through Canadian EFT.
- Canadian users use Canadian payment rails only (PAD/EFT). Never show ACH language to a Canadian user.
- Region is determined from `users.country` at intent creation and stored in `transfer_intents.provider_region`. It cannot be changed after creation.

---

## 2. Provider Abstraction

All money movement is behind the `TransferProvider` interface in `lib/transfers/types.ts`. Every provider — sandbox or live — implements the same five methods.

```
TransferProvider (interface)
├── createIntent()        → Insert draft intent. No external call. No balance change.
├── reviewTransfer()      → Return review details and region-appropriate consent language.
├── confirmTransfer()     → Record consent_confirmed_at. Set status='ready'. No external call.
├── executeTransfer()     → Initiate real transfer. Live providers only. Sandbox throws.
└── handleWebhookEvent()  → Process settlement/failure events. Live providers update status + balance.
```

**Provider routing** (`lib/transfers/router.ts`):

```
getTransferProvider(region)
  'US'  → SandboxUSProvider     today
          PlaidTransferProvider  when PLAID_TRANSFER_LIVE=true
  'CA'  → SandboxCAProvider     today
          CanadianEFTProvider    when CA_EFT_LIVE=true
```

To add a live provider: implement `TransferProvider` in a new file, add an env-gated condition to `router.ts`. The API routes and UI do not change.

**File locations:**

| File | Purpose |
|---|---|
| `lib/transfers/types.ts` | `TransferProvider` interface and all shared types |
| `lib/transfers/router.ts` | Maps user region → provider instance |
| `lib/transfers/sandbox-us.ts` | US sandbox (simulates Plaid Transfer ACH) |
| `lib/transfers/sandbox-ca.ts` | CA sandbox (simulates Canadian EFT) |
| `lib/transfers/plaid-transfer.ts` | *(future)* US live ACH via Plaid Transfer |
| `lib/transfers/canadian-eft.ts` | *(future)* CA live: Stripe ACSS + VoPay Interac |

---

## 3. Transfer Flow — 3 Steps

Every transfer — regardless of region, provider, or direction — follows this sequence:

```
Step 1: POST /api/transfers/intent
  ├── Auth gate
  ├── KYC gate
  ├── Encrypted bank account gate
  ├── Velocity check (not recorded yet)
  ├── provider.createIntent()
  └── Returns: { intent_id, status: 'draft', provider_name, provider_region, execution_mode }

Step 2: GET /api/transfers/:id/review
  ├── Auth gate
  ├── Ownership check (intent.user_id = auth user)
  ├── Status check (must be 'draft')
  ├── provider.reviewTransfer()
  └── Returns: { review: { amount, currency, bank_account, consent_language, settlement_estimate, ... } }

Step 3: POST /api/transfers/:id/confirm
  ├── Auth gate
  ├── Ownership check
  ├── Status check (must be 'draft')
  ├── provider.confirmTransfer()
  │     └── Records consent_confirmed_at, sets status='ready'
  └── Returns: { status: 'ready', message }

Step 4 (live only): POST /api/transfers/:id/execute    ← NOT YET BUILT
  ├── Auth gate
  ├── Status check (must be 'ready')
  ├── provider.executeTransfer()
  │     ├── Calls real payment API
  │     ├── Sets status='processing', stores provider_reference_id
  │     └── Records velocity (recordVelocity called here, not at step 1)
  └── Returns: { status: 'processing', provider_reference_id }
```

**UI flow** (`app/(app)/transfers/page.tsx`):
```
Form → "Continue to Review" → Review screen with consent language → "Confirm Transfer" → Confirmed screen
```

The `/transfers` page reads `?type=add_money` or `?type=cash_out` from the query string, set by the "+ Add Money" and "Cash Out" profile page buttons.

---

## 4. Status State Machine

```
                     ┌──────────────────────────────┐
                     │          draft               │  ← created at Step 1
                     └───────────────┬──────────────┘
                                     │ confirmTransfer()
                     ┌───────────────▼──────────────┐
                     │          ready               │  ← consent recorded
                     └───────────────┬──────────────┘
                                     │ executeTransfer() [live only]
                     ┌───────────────▼──────────────┐
                     │        processing            │  ← real transfer initiated
                     └───────┬───────────┬──────────┘
                             │           │
              ┌──────────────▼──┐    ┌───▼──────────────┐
              │    settled      │    │     failed        │
              │ balance updated │    │ failure_reason set│
              └─────────────────┘    └───────────────────┘
                                             │
                                     ┌───────▼──────────┐
                                     │    returned      │  ← NSF, account closed, etc.
                                     │ balance reversed │
                                     └──────────────────┘

Special:
  draft → blocked     (authorization declined at execute time)
  draft → cancelled   (user cancels before confirm)
```

---

## 5. Current State — Sandbox

**Both providers are `execution_mode = 'sandbox'` today.** No money moves. No external API calls.

| Provider | Region | Add Money | Cash Out | Balance change |
|---|---|---|---|---|
| `SandboxUSProvider` | US | ✅ simulated | ✅ simulated | Never |
| `SandboxCAProvider` | CA | ✅ simulated | ✅ simulated | Never |

Sandbox consent language:
- US: "This is a US transfer simulation — no money will move."
- CA: "This is a sandbox simulation — no money will move." (Canadian EFT framing, never ACH)

To validate sandbox in production, run the 3-step flow as a US user and separately as a CA user. Confirm `transfer_intents` row shows `execution_mode = 'sandbox'` and balance is unchanged after each step.

---

## 6. US Live Integration Plan — Plaid Transfer

**Provider:** Plaid Transfer API (ACH debit and credit)  
**File to create:** `lib/transfers/plaid-transfer.ts`  
**Activation:** Set `PLAID_TRANSFER_LIVE=true` in Vercel env, swap in `router.ts`

### Prerequisites (all required before writing code)

- [ ] Add `Products.Transfer` to `PLAID_PRODUCTS` in `lib/plaid.ts` and `app/api/plaid/create-link-token/route.ts`
- [ ] All US users must re-link their bank accounts (existing accounts lack the Transfer product)
- [ ] `PLAID_WEBHOOK_SECRET` set in Vercel (for webhook signature verification)
- [ ] Plaid webhook URL registered: `https://carloscab74.vercel.app/api/webhooks/plaid`
- [ ] `reverseVelocity()` function built in `lib/auth.ts` before any live transfers go live

### Execute flow (Add Money — ACH debit)

```
provider.executeTransfer(intentId, userId)
  1. requireEncryptedBankToken(userId, bankAccountId)     ← decrypts Plaid token
  2. plaidClient.transferAuthorizationCreate({
       access_token, account_id, type: 'debit',
       network: 'ach', amount, ach_class: 'ppd',
       user: { legal_name }, idempotency_key
     })
  3. If authorization.decision !== 'authorized': set status='blocked', store rationale, return
  4. plaidClient.transferCreate({
       access_token, account_id, authorization_id,
       type: 'debit', network: 'ach', amount,
       description: 'Manna Add Money', idempotency_key
     })
  5. UPDATE transfer_intents SET
       status = 'processing',
       provider_reference_id = plaid_transfer_id,
       plaid_authorization_id = authorization_id
  6. recordVelocity(userId, amount, currency)
```

### Execute flow (Cash Out — ACH credit)

Same as above with `type: 'credit'`. Plaid Transfer supports both directions with the same API.

### Settlement timing

- ACH debit (Add Money): T+1 to T+3 business days
- ACH credit (Cash Out): T+1 business day

### Return codes to handle

| Plaid event | R-code examples | Action |
|---|---|---|
| `returned` | R01 NSF, R02 Account Closed | `status='returned'`; notify user; no balance change |
| `failed` | API-level failure | `status='failed'`; log; notify user |
| `cancelled` | Cancelled before settlement | `status='cancelled'` |

### New columns required

```sql
ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS plaid_transfer_id TEXT;
ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS plaid_authorization_id TEXT;
```

---

## 7. Canadian Live Integration Plan

**Providers (two, for different directions):**

### Add Money — Stripe ACSS Debit (Pre-Authorized Debit / PAD)

**Why Stripe:** Already integrated (`lib/stripe.ts`). Best-in-class mandate handling. PAD Rule H1 compliance absorbed by Stripe. Webhook model matches existing Stripe KYC handler.

**Limitation:** ACSS is pull-only. Cannot push to bank accounts.

**File to create:** Route-specific logic inside `lib/transfers/canadian-eft.ts` for `type = 'add_money'`

**Mandate requirement (PAD Rule H1):**  
A signed Pre-Authorized Debit mandate must be collected before the first debit. Stripe hosts this flow. The mandate must include: amount or amount range, frequency, institution name, transit/institution/account numbers, user's right to cancel within 10 business days of first debit.

**Execute flow:**
```
1. Ensure PAD mandate exists for this bank account (check pad_mandate_id column)
   If not: create Stripe SetupIntent with payment_method_types: ['acss_debit']
           collect mandate via Stripe Elements hosted flow
           store mandate ID in bank_accounts.pad_mandate_id
2. Create Stripe PaymentIntent:
     amount (in cents), currency: 'cad',
     payment_method_types: ['acss_debit'],
     payment_method: stripe_pm_id,
     mandate: pad_mandate_id,
     confirm: true,
     idempotency_key
3. UPDATE transfer_intents SET
     status = 'processing',
     provider_reference_id = stripe_payment_intent_id,
     provider_rail = 'stripe_acss'
4. recordVelocity(userId, amount, 'CAD')
```

**Settlement timing:** T+3–5 business days for first debit; T+2 for subsequent with established mandate.

**Webhook:** `payment_intent.succeeded` → `status='settled'`, update `balance_cad`. `payment_intent.payment_failed` → `status='failed'` or `status='returned'` depending on failure code.

---

### Cash Out — VoPay (Interac e-Transfer preferred, EFT credit fallback)

**Why VoPay:** Only startup-accessible provider offering both Interac e-Transfer API and EFT credit. Interac is near-instant for Cash Out (vs. T+1–3 for EFT credit) — a significant UX advantage for Canadian users.

**File to create:** Route-specific logic inside `lib/transfers/canadian-eft.ts` for `type = 'cash_out'`

**Execute flow (Interac — preferred):**
```
1. POST https://api.vopay.com/api/1/eft/fund-account (or Interac endpoint)
   Params: AccountNumber, InstitutionNumber, TransitNumber,
           Amount, Currency: 'CAD',
           ClientReferenceNumber: idempotency_key,
           InteracEnabled: true
2. Store VoPay transaction ID as provider_reference_id
3. UPDATE transfer_intents SET status='processing', provider_rail='vopay_interac'
4. recordVelocity(userId, amount, 'CAD')
```

**Execute flow (EFT credit — fallback if Interac unavailable):**  
Same call with `InteracEnabled: false`. Settlement T+1 business day.

**Settlement timing:**
- Interac e-Transfer: minutes to 30 minutes
- EFT credit: T+1 business day

**Return codes:** VoPay uses 900-series Canadian EFT return codes. 905 = NSF, 903 = Account Closed, 914 = Stop Payment. Webhook delivers `TransactionStatus: Declined` with return code. Action: `status='returned'`, reverse balance if any was pre-applied (it should not be — see Principle 1).

### New columns required for Canadian live

```sql
ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS provider_rail TEXT;
ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS pad_mandate_id TEXT;
ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS pad_mandate_accepted_at TIMESTAMPTZ;
ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS interac_reference_id TEXT;

ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS pad_mandate_id TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS pad_mandate_accepted_at TIMESTAMPTZ;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT;
```

---

## 8. Database Schema

### `transfer_intents` — current columns

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL | Primary key |
| `user_id` | INTEGER | FK → users.id |
| `bank_account_id` | INTEGER | FK → bank_accounts.id; set at intent creation |
| `type` | TEXT | `add_money` or `cash_out` |
| `amount` | REAL | Transfer amount in the specified currency |
| `currency` | TEXT | `CAD` or `USD` |
| `status` | TEXT | See state machine above |
| `provider_region` | TEXT | `US` or `CA`; set at creation, immutable |
| `provider_name` | TEXT | `sandbox_us`, `sandbox_ca`, `plaid_transfer`, `canadian_eft` |
| `execution_mode` | TEXT | `sandbox` or `live` |
| `provider_reference_id` | TEXT | External transfer ID (Plaid transfer ID, Stripe PI ID, VoPay tx ID) |
| `failure_reason` | TEXT | Human-readable failure description |
| `consent_confirmed_at` | TIMESTAMPTZ | Timestamp user confirmed consent language |
| `idempotency_key` | TEXT | Unique key per intent; prevents duplicate API calls on retry |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

### `transfer_intents` — planned columns (added when live providers built)

| Column | Type | Notes |
|---|---|---|
| `provider_rail` | TEXT | `stripe_acss`, `vopay_eft`, `vopay_interac`, `plaid_transfer` |
| `plaid_transfer_id` | TEXT | Plaid's transfer object ID |
| `plaid_authorization_id` | TEXT | Plaid's authorization ID |
| `pad_mandate_id` | TEXT | Stripe mandate ID for ACSS debit |
| `pad_mandate_accepted_at` | TIMESTAMPTZ | Mandate acceptance timestamp |
| `interac_reference_id` | TEXT | VoPay Interac reference number |

### `bank_accounts` — planned columns

| Column | Type | Notes |
|---|---|---|
| `pad_mandate_id` | TEXT | Stripe mandate ID for this account |
| `pad_mandate_accepted_at` | TIMESTAMPTZ | When mandate was accepted |
| `stripe_payment_method_id` | TEXT | Stripe PM ID created during mandate setup |

### `plaid_transfer_events` — planned new table

```sql
CREATE TABLE plaid_transfer_events (
  id SERIAL PRIMARY KEY,
  plaid_event_id TEXT UNIQUE NOT NULL,   -- prevents reprocessing on webhook retry
  plaid_transfer_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  raw_payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

Store every raw Plaid webhook event before processing. Enables safe reprocessing if the handler crashes mid-execution.

---

## 9. Webhook Architecture

### Pattern (same for all providers)

```
POST /api/webhooks/<provider>
  1. Read raw body as text (required for signature verification)
  2. Verify signature header using provider-specific secret
  3. If signature invalid: return 400, log, do not process
  4. Parse event
  5. INSERT raw event into audit table (idempotency guard)
  6. Match event to transfer_intent via provider_reference_id
  7. Apply state transition
  8. Return 200 always — providers retry on non-200; log errors internally
```

### Existing webhooks

| Route | Provider | Events handled |
|---|---|---|
| `POST /api/webhooks/stripe` | Stripe | `identity.verification_session.verified`, `identity.verification_session.requires_input` |

### Planned webhooks

| Route | Provider | Events to handle |
|---|---|---|
| `POST /api/webhooks/plaid` | Plaid Transfer | `TRANSFER_EVENTS_UPDATE` → `settled`, `failed`, `returned`, `cancelled` |
| `POST /api/webhooks/stripe` (extended) | Stripe ACSS | `payment_intent.succeeded`, `payment_intent.payment_failed`, `mandate.updated` |
| `POST /api/webhooks/vopay` | VoPay | Transfer status updates, Interac delivery confirmations, return events |

### Balance update rule

**Only apply balance changes inside webhook handlers, on settlement events, never before.**

```typescript
// Correct — atomic, no TOCTOU race
await sql`
  UPDATE users
  SET balance_cad = balance_cad + ${amount}, updated_at = NOW()
  WHERE id = ${userId}
`;

// Wrong — race condition under concurrent transfers
const user = await getUser(userId);
await updateUser(userId, { balance_cad: user.balance_cad + amount });
```

---

## 10. Velocity Limits

Defined in `lib/auth.ts`. Checked at intent creation. Recorded at execute (not at confirm, not at intent).

| User tier | Hourly | Daily | Daily count | Weekly |
|---|---|---|---|---|
| Unverified (`kyc_status != 'verified'`) | $500 | $1,000 | 5 | $2,500 |
| KYC Verified | $5,000 | $10,000 | 25 | $25,000 |

**On failed or returned transfer:** Call `reverseVelocity(userId, amount, currency)` *(not yet built)* to deduct the recorded amount from the rolling window. Without this, failed transfers permanently consume velocity budget until the window resets.

**`reverseVelocity()` must be built before any live transfer goes to production.**

---

## 11. Compliance Obligations

### FINTRAC (Canada — applies immediately upon handling CAD)

Manna must register as a Money Services Business (MSB) with FINTRAC before any live Canadian money movement.

- **Registration:** fintrac-canafe.gc.ca — allow 4–8 weeks
- **Obligations once registered:** Large cash transaction reports (≥$10,000 CAD), suspicious transaction reports, record-keeping (5 years), KYC on all clients, compliance program documentation
- **Trigger:** Registration is required as soon as Manna transmits or receives money on behalf of clients in Canada, even in test/beta. Do not defer this.

### Payments Canada — PAD Rule H1 (Canadian debit)

Every PAD (Pre-Authorized Debit) requires:
- A signed mandate from the user before the first debit
- Mandate must state: amount or range, frequency, institution name, user's right to cancel within 10 business days of first debit
- User may request a copy of the mandate at any time
- Stripe ACSS Debit handles mandate collection and storage; Manna must not bypass this

### FinCEN / US regulations (US — applies if US users transmit money)

- Money Transmitter License (MTL) required in most US states for money transmission
- FinCEN MSB registration required
- This is separate from Plaid Transfer integration and is required at the company/product level
- Consult legal counsel before US live launch

### KYC (both regions)

- `kyc_status = 'verified'` (Stripe Identity) is required before any transfer
- This is enforced server-side in every transfer route — never bypassed
- KYC records must be retained per FINTRAC (5 years CA) and FinCEN (5 years US) requirements

### Velocity limits as AML controls

The velocity limits in `lib/auth.ts` also serve as anti-money-laundering controls. They must not be removed or raised without compliance review. They are not just rate limits.

---

## 12. Launch Sequencing

### Phase 1 — Current (complete)

- Sandbox transfer layer live in production
- 3-step flow (intent → review → confirm) validated for US and CA users
- KYC verified (Stripe Identity) live in production
- No real money movement

### Phase 2 — US Live ACH (next)

Prerequisites before writing a line of live code:
1. Add `Products.Transfer` to Plaid Link products
2. All existing US users re-link bank accounts
3. `PLAID_WEBHOOK_SECRET` set in Vercel
4. Plaid webhook URL registered
5. `reverseVelocity()` built in `lib/auth.ts`
6. FinCEN MSB registration status confirmed with legal

Implementation:
1. Create `lib/transfers/plaid-transfer.ts` implementing `TransferProvider`
2. Create `POST /api/transfers/[id]/execute` route
3. Create `POST /api/webhooks/plaid` route
4. Create `plaid_transfer_events` table
5. Add `plaid_transfer_id`, `plaid_authorization_id` columns to `transfer_intents`
6. Set `PLAID_TRANSFER_LIVE=true` in Vercel (env-gate in `router.ts`)
7. Validate in Plaid sandbox environment end-to-end before production

### Phase 3 — Canadian Live (parallel development, after US live)

Prerequisites:
1. FINTRAC MSB registration completed
2. Stripe ACSS enabled on Stripe account (may require Stripe contact)
3. VoPay account approved and Interac e-Transfer enabled
4. `pad_mandate_id` columns added to `bank_accounts`
5. `reverseVelocity()` already built (Phase 2)

Implementation:
1. Create `lib/transfers/canadian-eft.ts` implementing `TransferProvider`
   - `add_money`: Stripe ACSS — PAD mandate collection + PaymentIntent
   - `cash_out`: VoPay Interac e-Transfer (EFT credit fallback)
2. Extend `POST /api/webhooks/stripe` to handle ACSS `payment_intent.*` events
3. Create `POST /api/webhooks/vopay` route
4. Add `provider_rail`, `pad_mandate_id`, `interac_reference_id` columns to `transfer_intents`
5. Set `CA_EFT_LIVE=true` in Vercel (env-gate in `router.ts`)

**Canada launches after US. FINTRAC registration must be filed immediately — it does not wait for US launch.**

---

## 13. Adding a New Provider

1. Create `lib/transfers/<provider-name>.ts`
2. Implement all five methods of `TransferProvider` (see `lib/transfers/types.ts`)
3. `executeTransfer()` must make the real API call and set `status='processing'`
4. `handleWebhookEvent()` must update `transfer_intents.status` and user balance atomically on settlement
5. Add the provider to `ProviderName` type in `lib/transfers/types.ts`
6. Add an env-gated condition to `lib/transfers/router.ts`
7. Add new schema columns to `lib/db.ts` (initializeSchema) AND `app/api/migrate/route.ts`
8. Register the webhook route at `app/api/webhooks/<provider>/route.ts`
9. Add required env vars to `BANKING_ARCHITECTURE.md` § 14

The API routes (`/api/transfers/intent`, `/api/transfers/[id]/review`, `/api/transfers/[id]/confirm`, `/api/transfers/[id]/execute`) do not change when a new provider is added.

---

## 14. Environment Variables

### Currently set in Vercel

| Variable | Purpose |
|---|---|
| `PLAID_CLIENT_ID` | Plaid API client ID |
| `PLAID_SECRET` | Plaid API secret |
| `NEXT_PUBLIC_PLAID_ENV` | `production` — Plaid environment |
| `PLAID_TOKEN_ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM Plaid token encryption |
| `STRIPE_SECRET_KEY` | Stripe API key (KYC + future ACSS) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (KYC events) |

### Required for US live (Phase 2)

| Variable | Purpose |
|---|---|
| `PLAID_WEBHOOK_SECRET` | Plaid webhook signature verification |
| `PLAID_TRANSFER_LIVE` | Set to `true` to activate `PlaidTransferProvider` |

### Required for Canadian live (Phase 3)

| Variable | Purpose |
|---|---|
| `VOPAY_ACCOUNT_ID` | VoPay account identifier |
| `VOPAY_API_KEY` | VoPay API key |
| `VOPAY_API_SECRET` | VoPay API secret |
| `VOPAY_WEBHOOK_SECRET` | VoPay webhook signature verification |
| `STRIPE_ACSS_WEBHOOK_SECRET` | Separate Stripe webhook secret for ACSS events (different endpoint config from KYC webhook) |
| `CA_EFT_LIVE` | Set to `true` to activate `CanadianEFTProvider` |
