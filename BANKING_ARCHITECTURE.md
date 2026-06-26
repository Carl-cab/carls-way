# Manna — Banking Architecture

> Engineering reference for the transfer subsystem. Covers the full lifecycle of a transfer from intent creation through settlement or failure, the provider abstraction layer, ledger model, webhook processing, and compliance obligations. Updated: 2026-06-26.

---

## 1. Transfer Lifecycle

A transfer in Manna progresses through four ordered steps before money moves. Each step maps to a database status and one or more API calls.

### Steps

| Step | API | Status set | Who triggers |
|---|---|---|---|
| 1. Intent | `POST /api/transfers/intent` | `draft` | User |
| 2. Review | `GET /api/transfers/[id]/review` | (no change) | User |
| 3. Confirm | `POST /api/transfers/[id]/confirm` | `ready` | User |
| 4. Execute | (not yet wired to UI) | `processing` | System |

**Step 1 — Intent creation**

The client sends `{ type, amount, currency, bank_account_id }`. The route:
1. Authenticates the caller (`getAuthUser()`).
2. Verifies KYC status is `verified`.
3. Verifies the bank account exists, belongs to the user, and has `is_token_encrypted = true`.
4. Calls `checkVelocityLimit()` — rejects if over limit but does **not** record yet.
5. Looks up `users.country` to select the provider via `getTransferProvider(region)`.
6. Calls `provider.createIntent()`, which inserts a row into `transfer_intents` with `status='draft'`.

**Step 2 — Review**

The client calls `GET /api/transfers/[id]/review`. No status change occurs. The route:
1. Verifies ownership (`user_id = auth user`).
2. Verifies `status = 'draft'` (returns 409 otherwise).
3. Reads `provider_region` from the row to select the same provider used at creation.
4. Calls `provider.reviewTransfer()`, which returns amount, bank account details, regional consent language, and settlement estimate.

The consent language is region-specific and never mixes rails (CA users never see ACH language).

**Step 3 — Confirm**

The client calls `POST /api/transfers/[id]/confirm`. The route:
1. Verifies ownership.
2. Calls `provider.confirmTransfer()`, which:
   - Validates `status = 'draft'`.
   - Sets `status = 'ready'`, `consent_confirmed_at = NOW()`.
   - Writes an audit log entry.

**Step 4 — Execute**

Not yet triggered from the UI. When wired:
1. Calls `provider.executeTransfer()`.
2. On both sandbox providers, this throws — preventing accidental live calls.
3. On a live provider, this submits the transfer to the payment rail and sets `status = 'processing'`.
4. `recordVelocity()` is called at this step only — after the external API confirms submission.

### Status State Machine

```
draft ──────────────────────────────────────────────────────── cancelled
  │
  │ POST /api/transfers/[id]/confirm
  ▼
ready ──────────────────────────────────────────────────────── cancelled
  │
  │ executeTransfer() [system / future]
  ▼
processing
  │
  ├── webhook: settled ──► settled   (balance updated, velocity recorded)
  ├── webhook: failed ───► failed    (no balance change, velocity not consumed)
  └── webhook: returned ─► returned  (balance corrected, reverseVelocity called)
```

Terminal states: `settled`, `failed`, `returned`, `cancelled`, `blocked`.

`blocked` is set by `checkVelocityLimit()` when a user has exceeded their rolling limit. The intent is recorded for audit purposes but never proceeds to `ready`.

---

## 2. Provider Abstraction

All payment rail logic is isolated behind the `TransferProvider` interface. API routes never import provider classes directly — they call `getTransferProvider(region)` from the router.

### Interface (`lib/transfers/types.ts`)

```typescript
export interface TransferProvider {
  readonly providerName: ProviderName;
  readonly providerRegion: ProviderRegion;
  readonly executionMode: ExecutionMode;

  createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult>;

  reviewTransfer(intentId: number, userId: number): Promise<ReviewResult>;

  confirmTransfer(intentId: number, userId: number): Promise<ConfirmResult>;

  executeTransfer(intentId: number, userId: number): Promise<never>;

  handleWebhookEvent(rawPayload: string, signature: string): Promise<WebhookResult>;
}
```

`executeTransfer` is typed as `Promise<never>` — every call must either complete the transfer (live provider) or throw (sandbox). There is no path where it silently returns without action.

### Provider Files

| File | Class | Region | Mode |
|---|---|---|---|
| `lib/transfers/sandbox-us.ts` | `SandboxUSProvider` | US | sandbox |
| `lib/transfers/sandbox-ca.ts` | `SandboxCAProvider` | CA | sandbox |
| `lib/transfers/plaid-transfer.ts` | `PlaidTransferProvider` | US | live (not yet built) |
| `lib/transfers/canadian-eft.ts` | `CanadianEFTProvider` | CA | live (not yet built) |

### Router (`lib/transfers/router.ts`)

```typescript
export function getTransferProvider(region: UserRegion): TransferProvider {
  if (region === 'US') return new SandboxUSProvider();
  return new SandboxCAProvider();
}

export function regionFromCountry(country: string): UserRegion {
  return country === 'US' ? 'US' : 'CA';
}
```

When a live provider is ready, swap it in here behind an environment gate:

```typescript
if (region === 'US') {
  return process.env.USE_LIVE_PLAID === 'true'
    ? new PlaidTransferProvider()
    : new SandboxUSProvider();
}
```

The rest of the codebase — API routes, UI, audit logging — does not change when swapping providers.

### Provider Contract Rules

- `providerName`, `providerRegion`, and `executionMode` are `readonly` — set once at class definition, never changed at runtime.
- `provider_region` is written to `transfer_intents` at intent creation and never updated. The same provider class used at creation is re-selected for review and confirm by reading this column.
- CA providers must never generate ACH language. US providers must never generate EFT language.
- Sandbox providers must throw in `executeTransfer()` with a message identifying the sandbox class.

---

## 3. Ledger Model

Manna uses a dual-currency ledger. Each user holds two balances in the `users` table.

### Balance Columns

| Column | Type | Currency |
|---|---|---|
| `balance_cad` | `NUMERIC(12,2)` | Canadian dollars |
| `balance_usd` | `NUMERIC(12,2)` | US dollars |

The legacy `balance` column must never be used in new code. It predates the dual-currency migration and contains stale values.

### Balance Update Rules

1. **Atomic SQL only.** Balances are updated in a single SQL statement using relative arithmetic:
   ```sql
   UPDATE users SET balance_cad = balance_cad + ${amount} WHERE id = ${userId}
   ```
   Never: read the balance into application memory, add to it, then write back. That pattern creates a race condition under concurrent requests.

2. **No optimistic updates.** Balances are only modified when a webhook confirms settlement. Pending or processing transfers do not touch balances.

3. **Cross-border transfers** use `buildFxQuote()` from `lib/fx.ts` to get a live Wise rate before debiting the sender. The quote's `fx_rate`, `fx_fee`, `sender_amount`, and `receiver_amount` are recorded on the `transactions` row.

4. **Transfer intents do not modify balances.** Creating, reviewing, or confirming a `transfer_intent` row has zero effect on `balance_cad` or `balance_usd`. Balances change only on settled webhook events.

### Seed Balance

New users receive a seed balance at registration: $100 CAD for CA users, $100 USD for US users. This is set directly in the INSERT during registration and is not a transfer.

### Transaction Ledger

The `transactions` table records every P2P payment. It is append-only — rows are never updated after creation except to change `status` (pending → completed / declined). Cross-border transactions record:

- `fx_rate` — exchange rate at time of transfer
- `fx_fee` — Wise transfer fee
- `sender_amount` / `sender_currency`
- `receiver_amount` / `receiver_currency`
- `is_cross_border` — boolean flag
- `payment_rail` — e.g. `wise`
- `estimated_settlement` — ISO timestamp from Wise quote

---

## 4. Webhook Processing

Webhooks are the authoritative signal for transfer outcomes. No transfer status should change without a verified webhook event.

### Processing Pipeline

```
POST /api/webhooks/<provider>
  │
  ├── 1. Read raw body (before JSON.parse) — required for signature verification
  ├── 2. Verify signature (provider-specific HMAC or JWT)
  │       └── 400 if invalid — do not process
  ├── 3. Parse event type and transfer reference ID
  ├── 4. Idempotency check — have we processed this event ID before?
  │       └── 200 if duplicate — do not process again
  ├── 5. Look up transfer_intents row by provider_reference_id
  │       └── Log + 200 if not found (unknown transfer)
  ├── 6. Verify current status allows the transition
  │       └── Log + 200 if status is already terminal
  ├── 7. Execute state transition (settled / failed / returned)
  ├── 8. If settled: update balance atomically, record velocity
  ├── 9. If returned: reverse balance atomically, call reverseVelocity()
  ├── 10. Create notification for user
  └── 11. Return 200 — always (see Retry Strategy)
```

### Stripe Webhook (KYC)

The existing Stripe webhook at `POST /api/webhooks/stripe` handles KYC events only:
- `identity.verification_session.verified` → set `kyc_status = 'verified'`
- `identity.verification_session.requires_input` → set `kyc_status = 'rejected'`, store `kyc_rejection_reason`

Signature verification uses `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`. The raw body must be read before any JSON parsing — use `req.text()` not `req.json()`.

### Plaid Webhook (future — transfer events)

Plaid sends transfer events to a configured webhook URL. Each event includes:
- `webhook_type: 'TRANSFER'`
- `webhook_code: 'TRANSFER_EVENTS_UPDATE'`
- `transfer_id`: Plaid's transfer reference

On receipt, call `plaid.transferEventSync()` to pull new events since the last cursor. Each event has an `event_type` field (`settled`, `failed`, `returned`, `swept`, etc.).

Store the Plaid `event_id` in a `plaid_transfer_events` table before processing to prevent duplicate handling.

---

## 5. Settlement Flow

Settlement is triggered by a provider webhook confirming that funds have cleared.

### On `settled` event

```
1. Verify webhook signature
2. Idempotency check on event_id
3. Match transfer_intents row by provider_reference_id
4. Verify status = 'processing'
5. Atomic balance update:
   - add_money: balance_cad += amount  (or balance_usd for US)
   - cash_out: no balance change (funds left the account at execute)
6. Set transfer_intents.status = 'settled'
7. recordVelocity(userId, amount)
8. Write audit_log entry
9. Create notification: "Your transfer of $X has settled"
10. Return 200
```

For `add_money`, the user's balance increases when funds clear from their bank. For `cash_out`, the balance was already debited at execute time — no additional balance change on settlement.

### Settlement Timing

| Rail | Typical settlement |
|---|---|
| Plaid Transfer (ACH) | 1–3 business days |
| Stripe ACSS (Canadian debit) | 2–5 business days |
| VoPay Interac e-Transfer | Minutes to hours |
| Sandbox | Immediate (simulated) |

Settlement estimates are returned in `reviewTransfer()` as human-readable strings. They are informational only — never used to trigger balance changes.

---

## 6. Reversal Flow

Reversals occur when a settled transfer is clawed back — typically due to NSF (non-sufficient funds) or a bank dispute.

### On `returned` event

```
1. Verify webhook signature
2. Idempotency check on event_id
3. Match transfer_intents row
4. Verify status = 'settled' (only settled transfers can be returned)
5. Reverse balance:
   - add_money reversal: balance_cad -= amount  (funds were never real)
   - cash_out reversal: balance_cad += amount   (funds came back)
6. Set transfer_intents.status = 'returned'
7. Store failure_reason (bank return code if available)
8. reverseVelocity(userId, amount)  ← not yet built
9. Write audit_log entry
10. Create notification: "Your transfer of $X was returned: <reason>"
11. Return 200
```

### `reverseVelocity()` — Not Yet Built

`reverseVelocity(userId, amount)` must be implemented in `lib/auth.ts` before any live transfer goes to production. Without it, returned transfers permanently consume velocity budget for the rolling window period.

The function should decrement the rolling totals in `velocity_checks` by the reversed amount, not below zero:

```sql
UPDATE velocity_checks
SET hourly_amount  = GREATEST(0, hourly_amount  - ${amount}),
    daily_amount   = GREATEST(0, daily_amount   - ${amount}),
    weekly_amount  = GREATEST(0, weekly_amount  - ${amount})
WHERE user_id = ${userId}
```

### Balance Floor

Balance updates must never push a user below zero. Add a check before decrementing:

```sql
UPDATE users
SET balance_cad = balance_cad - ${amount}
WHERE id = ${userId} AND balance_cad >= ${amount}
RETURNING balance_cad
```

If the RETURNING clause returns no rows, the debit was rejected. This can happen during reversals if the user has spent the deposited funds before the bank return arrives.

---

## 7. Retry Strategy

### Webhook Retries (Inbound)

Always return HTTP 200 to the payment provider, even if internal processing fails. If a non-200 is returned, the provider will retry — potentially many times — causing duplicate processing.

The correct pattern:
```typescript
try {
  await processWebhookEvent(event);
} catch (err) {
  await logFailedWebhookEvent(event, err);  // store for manual recovery
}
return NextResponse.json({ received: true }, { status: 200 });
```

Failed webhook events stored for manual recovery must include: raw payload, event_id, provider, error message, timestamp.

### API Call Retries (Outbound)

When calling Plaid, Wise, or Stripe APIs, use exponential backoff with jitter:
- Attempt 1: immediate
- Attempt 2: 1s delay
- Attempt 3: 2s delay
- Attempt 4: 4s delay
- Give up after 4 attempts; set `status = 'failed'` on the intent

Only retry on transient errors (5xx, network timeout, rate limit 429). Never retry on 4xx client errors — those indicate a data problem that will not resolve on retry.

### Idempotency on Retry

All outbound API calls use the `idempotency_key` stored on the `transfer_intents` row. On retry:
- Plaid Transfer: pass `idempotency_key` in the request body
- Stripe: pass as `Idempotency-Key` header
- Wise: pass as `X-idempotence-uuid` header

The provider deduplicates and returns the same result for repeated calls with the same key.

---

## 8. Idempotency

Idempotency prevents duplicate transfers when a client retries a request or a webhook fires more than once.

### Transfer Intent Idempotency Key

Every `transfer_intents` row has an `idempotency_key` set at creation:

```typescript
const idempotencyKey = `${region}_${userId}_${Date.now()}`;
```

This key is passed to the payment provider when `executeTransfer()` is called. If the call is retried (e.g. network timeout, server restart), the provider recognizes the key and returns the existing transfer instead of creating a new one.

### Webhook Event Deduplication

Payment providers may deliver the same webhook event more than once. Before processing any event, check whether the `event_id` has already been handled.

**Schema (to be added to `initializeSchema()` and `/api/migrate`):**
```sql
CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id           SERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, event_id)
);
```

**Processing:**
```typescript
const existing = await sql`
  INSERT INTO provider_webhook_events (provider, event_id, event_type)
  VALUES (${provider}, ${eventId}, ${eventType})
  ON CONFLICT (provider, event_id) DO NOTHING
  RETURNING id
`;
if (existing.length === 0) {
  return NextResponse.json({ received: true, duplicate: true });
}
```

Using `ON CONFLICT DO NOTHING` with `RETURNING` makes the deduplication check atomic — no race condition if two webhook deliveries arrive simultaneously.

### Client-Side Idempotency

The transfer UI disables the Confirm button after the first click and shows a loading state. This prevents accidental double-submits, but the server must also guard against them via idempotency — UI safeguards are not sufficient on their own.

---

## 9. Failure Recovery

Each failure state has a defined recovery path.

### `failed` — Provider rejected the transfer before processing

**Cause:** Invalid account number, account type mismatch, provider validation error.  
**Balance effect:** None (transfer was rejected before funds moved).  
**User action:** Check bank account details, re-link if necessary, create a new intent.  
**Recovery:** No automated recovery. User must initiate a new intent.

### `returned` — Funds were accepted then clawed back

**Cause:** NSF, account closed, fraud hold.  
**Balance effect:** Reversal applied (see Section 6). `reverseVelocity()` called.  
**User action:** Resolve issue with bank, re-link if account is closed, try again.  
**Recovery:** No automated re-submission. A returned transfer is final.

### `blocked` — Velocity limit exceeded

**Cause:** User exceeded hourly, daily, or weekly transfer volume limit.  
**Balance effect:** None.  
**User action:** Wait for the window to expire, or contact support for a limit review.  
**Recovery:** Automatic — limit windows expire. No manual intervention needed.

### `processing` stuck — Execute succeeded but no webhook received

**Cause:** Webhook delivery failure, provider delay, network issue.  
**Balance effect:** None (balances only change on settlement, not on execute).  
**Recovery path:**
1. Query provider API directly for current transfer status.
2. If settled: apply settlement manually via admin route (to be built).
3. If failed: set intent to `failed`, restore velocity if already recorded.
4. If still pending: wait; re-query after provider's expected settlement window.

### Corrupt or unprocessable webhook

**Cause:** Malformed payload, signature mismatch, unknown transfer ID.  
**Recovery:** Log the raw payload and error with the event_id for manual review.

---

## 10. Compliance Responsibilities

### FINTRAC (Canada) — Money Services Business Registration

Any platform that facilitates money transfers in Canada must register as an MSB (Money Services Business) with FINTRAC. This is a legal requirement, not optional.

**File immediately.** Allow 30 days for processing. Required before any Canadian user sends or receives a real transfer.

**Ongoing obligations:**
- Keep KYC records for 5 years after the last transaction.
- Report suspicious transactions (STRs) within 30 days.
- Report large cash transactions (LCTRs) for transactions > CAD 10,000.
- File an annual MSB compliance report.

### PAD Mandate (Canada) — Payments Canada Rule H1

Pre-Authorized Debit (PAD) requires explicit written authorization before debiting a Canadian bank account. The mandate must include:

- Amount or amount range
- Frequency (one-time or recurring)
- Bank account details
- Right to cancel within 30 days
- Contact information for disputes

The `consent_confirmed_at` timestamp on `transfer_intents` records when the user confirmed the transfer. The consent language displayed in the Review step must satisfy PAD Rule H1 requirements. For Add Money (bank debit), this is a one-time PAD mandate — the user must re-authorize each transfer individually.

### FinCEN / MTL (United States) — Money Transmitter License

Facilitating money transfers in the US requires FinCEN registration and state-level Money Transmitter Licenses (MTLs) in most states. Requirements vary by state.

**Alternative:** Operating under Plaid's own MTL coverage when using Plaid Transfer — confirm coverage scope with Plaid legal before launch.

### KYC Retention

- Stripe Identity session IDs and verification results must be retained for 5 years.
- `kyc_verified_at`, `kyc_status`, and `kyc_rejection_reason` are stored on `users` and must not be deleted.
- User account deletion must archive KYC records, not destroy them.

### Velocity Limits as AML Controls

The `velocity_checks` table implements rolling hourly/daily/weekly volume limits. These serve as the primary AML (Anti-Money Laundering) control layer.

| KYC Status | Can transfer |
|---|---|
| `unverified` | No — blocked at KYC gate |
| `pending` | No — blocked at KYC gate |
| `verified` | Yes — subject to velocity limits |

Limits are enforced in `checkVelocityLimit()` in `lib/auth.ts`. Unverified users cannot initiate any transfers — this is enforced at both the velocity check and the explicit KYC gate in the intent route.

---

## 11. Future Provider Integrations

### Adding a New Provider — Checklist

1. **Create the provider file** in `lib/transfers/`. Export a single class implementing `TransferProvider`.

2. **Implement all 5 interface methods.** `executeTransfer` must make the real API call for live providers — it must not throw.

3. **Add the provider name to `ProviderName`** in `lib/transfers/types.ts`:
   ```typescript
   export type ProviderName = 'sandbox_us' | 'sandbox_ca' | 'plaid_transfer' | 'canadian_eft';
   ```

4. **Wire the provider in `router.ts`** behind an env gate:
   ```typescript
   if (region === 'US' && process.env.PLAID_TRANSFER_LIVE === 'true') {
     return new PlaidTransferProvider();
   }
   ```

5. **Add the webhook handler** at `POST /api/webhooks/<provider>`. Follow the webhook processing pipeline in Section 4.

6. **Add `provider_webhook_events` deduplication** with the provider name as the `provider` column value.

7. **Implement `reverseVelocity()`** in `lib/auth.ts` before any live provider goes to production.

8. **Add required env vars** to Vercel dashboard and to the env var table in `CLAUDE.md`.

9. **Add migration** to `app/api/migrate/route.ts` and `lib/db.ts` for any new tables.

### PlaidTransferProvider (US ACH)

**Status:** Not yet built.

**Prerequisites before building:**
- Plaid Link config must include `Transfer` in the products array. All existing US bank accounts were linked with `[Auth, Transactions]` only — all US users must re-link.
- `reverseVelocity()` must be implemented.
- US MTL or Plaid's MTL coverage must be confirmed with Plaid legal.

**Implementation sketch:**
```typescript
async executeTransfer(intentId: number, userId: number): Promise<ExecuteResult> {
  const intent = await getIntent(intentId, userId);
  const token = await requireEncryptedBankToken(userId, intent.bank_account_id);

  const response = await plaid.transferCreate({
    access_token: token,
    account_id: intent.plaid_account_id,
    type: intent.type === 'add_money' ? 'debit' : 'credit',
    network: 'ach',
    amount: intent.amount.toFixed(2),
    ach_class: 'ppd',
    user: { legal_name: intent.user_legal_name },
    idempotency_key: intent.idempotency_key,
  });

  await sql`
    UPDATE transfer_intents
    SET status = 'processing',
        provider_reference_id = ${response.data.transfer.id}
    WHERE id = ${intentId}
  `;

  return { provider_reference_id: response.data.transfer.id };
}
```

**Webhook:** Plaid sends `TRANSFER_EVENTS_UPDATE` to a configured URL. Call `plaid.transferEventSync()` with a stored cursor to pull events. Events: `settled`, `failed`, `returned`.

### CanadianEFTProvider (CA)

**Status:** Not yet built.

Two vendors are needed because ACSS is pull-only and cannot credit accounts.

| Operation | Vendor | Rail | Settlement |
|---|---|---|---|
| Add Money (bank debit) | Stripe ACSS | PAD | 2–5 business days |
| Cash Out (bank credit) | VoPay Interac | e-Transfer | Minutes to hours |

**Stripe ACSS (Add Money):**
- Create a `PaymentIntent` with `payment_method_types: ['acss_debit']`.
- On first debit, Stripe presents a mandate acceptance flow satisfying PAD Rule H1.
- Webhook events: `payment_intent.succeeded`, `payment_intent.payment_failed`.

**VoPay Interac (Cash Out):**
- Send an Interac e-Transfer to the user's registered email via VoPay API.
- No re-linking required — uses email, not bank credentials.
- Provider-specific webhook events; check VoPay API documentation.

**Prerequisites:**
- FINTRAC MSB registration must be active before any Canadian transfer goes live.

### Provider Environment Gates

```
PLAID_TRANSFER_LIVE=true   → enables PlaidTransferProvider for US
CA_EFT_LIVE=true           → enables CanadianEFTProvider for CA
```

Never set both `_LIVE` flags until the corresponding provider has been fully tested end-to-end in the provider's own sandbox environment.

---

*For current operational state, see `CURRENT_STATUS.md`. For session history and decision log, see `PROJECT_MEMORY.md`.*
