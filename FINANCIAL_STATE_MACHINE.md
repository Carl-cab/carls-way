# Manna — Financial State Machine

> Engineering reference for transfer and payment state transitions. Defines all states, valid transitions, who drives each transition, when balances change, when ledger entries are created, and how failures are handled.

Last updated: 2026-06-28 (Phase B2 Settlement Orchestrator complete)

---

## 1. Transfer States

### Intent States (Before execution)
- **`draft`** — User created intent, reviewing decision
- **`ready`** — User confirmed intent, waiting for execution
- **`blocked`** — Velocity limit exceeded, user cannot proceed

### Execution States (During processing)
- **`processing`** — External provider has accepted the request, waiting for settlement

### Terminal States (Final outcome)
- **`settled`** — Funds cleared, balance updated, velocity recorded
- **`failed`** — Provider rejected the request before or during processing, no balance change
- **`returned`** — Funds were settled then clawed back (NSF, fraud hold, etc.), balance reversed
- **`cancelled`** — User cancelled or admin cancelled

---

## 2. Valid Transitions

```
draft ────────────────────────────────────────────── cancelled (user-initiated)
  │
  ├─ VELOCITY_CHECK_FAILS ──► blocked (system, no state change needed for intent)
  │
  └─ POST /api/transfers/{id}/confirm
     │
     ▼
   ready ────────────────────────────────────────────── cancelled (user/admin)
     │
     ├─ executeTransfer() [system, future wired to UI]
     │  │
     │  ▼
     │  processing
     │  │
     │  ├─ webhook: settled ─► settled (+ balance update + velocity record)
     │  ├─ webhook: failed ──► failed (no balance change)
     │  └─ webhook: returned ► returned (+ balance reversal + reverseVelocity)
     │
     └─ Timeout/admin ──► failed (after N days in ready state)
```

---

## 3. User-Driven Transitions

| Transition | Endpoint | Action |
|---|---|---|
| draft → ready | `POST /api/transfers/{id}/confirm` | User confirms consent |
| draft → cancelled | (UI button, future) | User cancels unsent intent |
| ready → cancelled | (UI button, future) | User cancels before execution |

**Rules:**
- User can only transition their own intents
- Transitions only allowed from `draft` or `ready` state
- Cannot cancel once `processing` starts

---

## 4. Provider-Webhook-Driven Transitions

| Transition | Webhook Event | Triggered By |
|---|---|---|
| processing → settled | `transfer.settled` | External provider confirms funds cleared |
| processing → failed | `transfer.failed` | External provider rejects or timeout occurs |
| settled → returned | `transfer.returned` | Bank return (NSF, closed account, fraud hold, etc.) |

**Rules:**
- Webhook must match idempotency_key on intent (prevents duplicates)
- Only valid from `processing` state (settled cannot transition further except to returned)
- Webhook signature must be verified before state change
- Must be idempotent: same webhook twice = same result

---

## 5. Which Transitions Write Ledger Entries

| Transition | Ledger Entries | Notes |
|---|---|---|
| draft → ready | None | No financial movement yet |
| ready → processing | None | No financial movement yet |
| processing → settled | Yes | Debit/credit entries created, records the settlement |
| processing → failed | No | No financial impact, no ledger entry |
| settled → returned | Yes | Reversal entries created (opposite of settlement) |

**Rules:**
- Ledger entries only on state changes that affect balances
- Entries created AFTER balance update commits (event sourcing)
- Entries immutable (never updated, only inserted)
- Link to intent via transaction_id or transfer_intent_id

---

## 6. Which Transitions Update Balances

### P2P Payments (transactions table)

| Transition | Sender Balance | Receiver Balance | Notes |
|---|---|---|---|
| POST /send | -amount (sender currency) | +amount (receiver currency) | Immediate (not awaiting provider) |
| Accept request | -amount | +amount | Immediate |

**Rules:**
- P2P is local (no external provider), balance changes immediately on accept
- Cross-border: use FX rate from Wise at time of send
- Balance never goes negative (checked before debit)
- Atomic SQL: `UPDATE users SET balance_X = balance_X ± amount`

### Bank Transfers (transfer_intents)

| Transition | Balance Change |
|---|---|
| draft | None |
| ready | None |
| processing | None (yet) |
| settled (add_money) | +amount to balance_X |
| settled (cash_out) | None (already debited at execute) |
| failed | None |
| returned | Reverse the settlement debit/credit |

**Rules:**
- Balance only changes when external settlement confirmed (webhook)
- Add Money: balance increases on settled
- Cash Out: balance decreases at execute time (not at settled)
- Returned: reverses the balance change that happened at settled

---

## 7. Failure States

### `blocked` (Velocity Limit Exceeded)

**When:** `checkVelocityLimit()` returns false during intent creation  
**What happens:**
- Intent is recorded with status='blocked' (for audit)
- No balance change
- User gets 429 response with reason (hourly/daily/weekly limit)
- User must wait for time window to expire

**Recovery:** Automatic (window expires) or request limit increase (future)

**Ledger:** No entries created

---

### `failed` (Provider Rejected)

**When:** External provider rejects (invalid account, wrong account type, etc.)  
**What happens:**
- Intent status set to 'failed'
- No balance change (provider rejected before funds moved)
- Failure reason stored (bank error code if available)
- User notified

**Recovery:** User fixes bank account details, re-links if needed, creates new intent

**Ledger:** No entries (failed before settlement)

---

### `returned` (Bank Clawed Back Settled Funds)

**When:** Bank returns settled transfer (NSF, account closed, fraud hold, etc.)  
**What happens:**
1. Webhook received: `transfer.returned`
2. Status → `returned`
3. Balance reversed (add_money debit reversed, cash_out credit reversed)
4. `reverseVelocity()` called (CRITICAL: not yet built)
5. User notified with reason

**Recovery:** None automatic. User resolves with bank and retries.

**Ledger:** Reversal entries created

**CRITICAL BUG (unfixed):** If `reverseVelocity()` fails, returned transfer permanently consumes velocity budget.

---

## 8. Return / Reversal States

### Settled → Returned Transition

**Preconditions:**
- Intent must be in `settled` state
- Webhook event must include transfer_id and provider signature

**Actions:**
```
1. Verify webhook signature
2. Idempotency check (event_id not seen before)
3. Query transfer_intents by provider_reference_id
4. Verify status = 'settled' (only settled can be returned)
5. UPDATE balance (reverse the settlement)
6. reverseVelocity(user_id, amount)  ← BLOCKING IMPLEMENTATION NEEDED
7. INSERT ledger entries (reversal pair)
8. Set status = 'returned', store_reason
9. CREATE notification
10. Return 200 (always, even if step 6 fails)
```

**Ledger Entries on Return:**
- Add Money reversal: debit the balance increase back out
- Cash Out reversal: credit the balance decrease back in
- Entries marked as `entry_type='reversal'`
- Include failure reason in description

---

## 9. Idempotency Rules

### Transfer Intent Idempotency

**idempotency_key column:**
- Set at intent creation: `${region}_${userId}_${Date.now()}`
- Passed to provider at execute time
- Provider deduplicates: same key = same result (no new transfer)

**Effect:** Client can retry `executeTransfer()` safely without creating duplicates

### Webhook Event Idempotency

**provider_webhook_events table (to be added):**
```sql
CREATE TABLE provider_webhook_events (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_id)
)
```

**On webhook receipt:**
1. Try INSERT `(provider, event_id, event_type)`
2. If UNIQUE constraint violated: event already processed, return 200 immediately
3. If INSERT succeeds: proceed with state transition

**Effect:** Webhook can be delivered multiple times, state transitions only once

---

## 10. Replay Rules

### Replay Scenario

User submits `POST /api/transfers/{id}/confirm`, browser times out, user clicks again.

### Protection

1. **Client side:** UI disables button, shows "processing..."
2. **Server side:** Intent status check
   - If status != 'draft', return 409 (already confirmed)
   - Only transitions draft → ready once

### Replay of Webhook Events

Provider retries webhook delivery, our server receives event twice.

**Protection:** Idempotency check (see above)
- First delivery: INSERT, process, state transition
- Second delivery: UNIQUE constraint violation, return 200 (idempotent)

---

## State Transition Matrix

| From | To | Trigger | Actor | Ledger | Balance | Idempotent |
|---|---|---|---|---|---|---|
| draft | ready | confirm | User | No | No | Yes (idempotency_key) |
| draft | blocked | velocity fail | System | No | No | N/A |
| draft | cancelled | user action | User | No | No | Yes |
| ready | processing | execute | System | No | No | Yes (idempotency_key) |
| ready | cancelled | user action | User | No | No | Yes |
| processing | settled | webhook | Provider | Yes | Yes | Yes (event_id) |
| processing | failed | webhook | Provider | No | No | Yes (event_id) |
| settled | returned | webhook | Provider | Yes | Yes | Yes (event_id) |

---

## Failure Recovery Paths

### Intent Stuck in `draft`

**Cause:** User abandoned intent  
**Recovery:** New intent (delete old one admin-only)  
**Timeline:** No deadline, user can create new intent anytime

### Intent Stuck in `ready`

**Cause:** Execute started but crashed before external API call  
**Recovery:** Retry execute (idempotent) or create new intent  
**Timeline:** N hours (configurable), then auto-fail

### Intent Stuck in `processing`

**Cause:** Provider never sent webhook (delivery failure, timeout)  
**Recovery:** Query provider API directly for status (admin-only for now)  
**Timeline:** Provider's settlement window + 24 hours, then manual review

### Settlement Lost (Settled but No Ledger Entries)

**Cause:** Ledger creation failed (database error)  
**Recovery:** Retry ledger creation from settlement webhook data  
**Detection:** balance-check shows mismatch  
**Timeline:** Manual recovery required (admin route needed)

---

## Implementation Sequencing

### Phase A1 (Complete): Passive Ledger Foundation
- ✅ Ledger entries for P2P payments
- ✅ Same-currency and cross-border ledger pairs
- ✅ Non-blocking ledger creation
- ✅ Read-only ledger APIs

### Phase A2 (Complete): Webhook Infrastructure + Velocity Reversal
- ✅ Implement `reverseVelocity()` in `lib/auth.ts` (creates compensating negative velocity records)
- ✅ Add `provider_webhook_events` table with UNIQUE(provider, provider_event_id) constraint
- ✅ Webhook event deduplication helpers: `recordProviderEvent()`, `hasProcessedProviderEvent()`, `markProviderEventProcessed()`, `markProviderEventFailed()`
- ✅ Admin endpoint: `POST /api/admin/ledger/backfill-opening-balances` with BACKFILL_SECRET protection and ?dryRun=true option
- ✅ All functions marked "Future Use Only" (not yet wired to live providers)

### Phase A3 (Complete): Provider Execution Framework
- ✅ `TransferProvider` interface with 7 standardized methods (createIntent, reviewTransfer, confirmTransfer, executeTransfer, cancelTransfer, getTransferStatus, handleWebhookEvent)
- ✅ `TransferProviderFactory` with centralized provider selection logic
- ✅ `SandboxUSProvider` — fully implemented, no real API calls, no balance mutations
- ✅ `SandboxCAProvider` — fully implemented, no real API calls, no balance mutations
- ✅ `PlaidTransferProvider` — placeholder implementation (throws "Not implemented")
- ✅ `CanadianEFTProvider` — placeholder implementation (throws "Not implemented")
- ✅ Backward compatibility via `lib/transfers/router.ts` (re-exports from factory)
- ✅ Critical constraint enforced: No provider may update balances

### Phase A4 (Complete): Settlement Processor Skeleton
- ✅ `lib/settlement/types.ts`: Event types, outcome objects, transition rules
- ✅ `lib/settlement/settlement-rules.ts`: Valid transitions, terminal/processing states
- ✅ `lib/settlement/SettlementProcessor.ts`: Core processor with state machine logic
- ✅ `normalizeProviderEvent()`: Converts provider events to canonical form
- ✅ `validateSettlementTransition()`: Checks if transition is valid
- ✅ `processSettlementEvent()`: Main processing logic with idempotency support
- ✅ SettlementOutcome always returns `shouldUpdateBalance: false`, `shouldCreateLedgerEntry: false`
- ✅ Dev endpoint `/api/dev/settlement-test` validates transitions
- ✅ No balance updates, no ledger entries, no provider calls
- ✅ Critical constraint enforced: Settlement processor is pure state machine (structure only)

### Phase B1 (Complete): Webhook Receiver Framework
- ✅ `POST /api/webhooks/plaid`: HMAC-SHA256 signature verification, event deduplication, idempotency
- ✅ `POST /api/webhooks/stripe`: KYC logic preserved, financial events recorded
- ✅ Event intake with raw body for signature verification
- ✅ UNIQUE(provider, provider_event_id) prevents duplicate processing
- ✅ All webhooks return 200 (prevents retries on transient errors)
- ✅ No balance updates, no ledger entries, no settlement logic wired (Phase B2)

### Phase B2 (Complete): Settlement Orchestrator
- ✅ `SettlementOrchestrator.orchestrateSettlement()`: Queries intents, validates transitions, produces plans
- ✅ `SettlementPlan` interface: Describes side effects (updateBalance, createLedgerEntries, notifyUser, reverseVelocity)
- ✅ `planBalanceUpdate()`: Instructions for balance changes (Add Money: +, Cash Out: -)
- ✅ `planLedgerEntries()`: Instructions for settlement/reversal entries
- ✅ `shouldNotify()`: User notification requirement
- ✅ Pure planning layer: no execution, no side effects
- ✅ Webhook handlers can return SettlementPlan for Phase B3 execution

### Phase B3.1 (Complete): Settlement Status Executor
- ✅ `lib/settlement/SettlementExecutor.ts`: Core executor with `executeSettlementPlan()`
- ✅ `SettlementExecutionResult`: success, intentId, previousStatus, newStatus, updated, reason, error
- ✅ Updates `transfer_intents.status` and `transfer_intents.updated_at` only
- ✅ Idempotent: if already at target status, returns success without updating
- ✅ Wired into `POST /api/webhooks/plaid`: TRANSFER/STATUS_UPDATE handler
- ✅ `handleTransferEventStatusUpdate()`: Creates NormalizedEvent, calls orchestrator, calls executor
- ✅ `mapPlaidTransferStatus()`: Maps Plaid statuses to SettlementEventType
- ✅ Constraint: Status transitions only — NO balance, NO ledger, NO notifications, NO velocity

### Phase B3.2a (Complete): Settlement Ledger Executor
- ✅ Extended `SettlementExecutor` with `executeLedgerCreation(plan)`
- ✅ `LedgerExecutionResult`: success, intentId, entriesCreated, reason, error
- ✅ Added `provider_event_id` column to ledger_entries with UNIQUE constraint
- ✅ Maps entry_type from plan to database format (add_money_settled, cash_out_settled, transfer_returned, transfer_failed)
- ✅ Links entries to transfer_intents via transfer_intent_id
- ✅ Includes provider, provider_reference, provider_event_id for audit
- ✅ Atomic: all entries inserted or none (ON CONFLICT DO NOTHING)
- ✅ Idempotent: duplicate webhooks cannot create duplicates
- ✅ Wired into webhook handler: after status executor

### Phase B3.2b (Complete): Balance Executor
- ✅ `lib/settlement/SettlementExecutor.ts`: `executeBalanceUpdate(plan)` method
- ✅ `BalanceExecutionResult`: success, balanceUpdated, currency, amountApplied, operation
- ✅ `provider_webhook_events`: added `balance_processed_at` and `balance_processing_error` columns
- ✅ Idempotency: balance_processed_at tracking prevents duplicate updates from same event
- ✅ Atomic: single UPDATE with arithmetic (balance_X = balance_X + amount)
- ✅ Validation: currency (CAD/USD), positive amounts, user owns intent, status allows action
- ✅ Add Money: increases balance on settled
- ✅ Cash Out: skipped (no live executeTransfer yet, returns success)
- ✅ Returned: applies reversal if settled previously (subtracts balance)
- ✅ Error tracking: failures logged to provider_webhook_events for debugging
- ✅ Wired into webhook handler: executes after ledger creation

### Phase B3.3 (Next): Notification & Velocity Executor
- [ ] Implement `notifyUser()` — create notification if plan.notifyUser
- [ ] Implement `reverseVelocity()` execution — compensating records for returned transfers
- [ ] Non-blocking: notification/velocity failures don't fail settlement

### Phase B3 Integration
- [ ] Test webhook flow in sandbox: event → orchestrate → execute (B3.1, B3.2a, B3.2b, B3.3)
- [ ] Verify status transitions recorded correctly
- [ ] Verify ledger entries created with correct amounts
- [ ] Verify balance changes ONLY on settled webhooks
- [ ] Verify velocity reversed on returned transfers

### Phase B4: Live US Provider (PlaidTransferProvider)
- [ ] Implement `executeTransfer()` calling Plaid Transfer API
- [ ] Implement `handleWebhookEvent()` via webhook routes (reuse B3 logic)
- [ ] Update Plaid Link to include Transfer product
- [ ] Confirm Plaid signature format, enable verification
- [ ] Production test in Plaid sandbox

### Phase B5: Live CA Provider (CanadianEFTProvider)
- [ ] Implement Stripe ACSS for Add Money
- [ ] Implement VoPay Interac for Cash Out
- [ ] FINTRAC registration complete
- [ ] Production test in provider sandboxes

---

## Known Gaps (Before Live Implementation)

1. **reverseVelocity()** — Not yet built. Blocking: returned transfers will permanently consume velocity.
2. **provider_webhook_events table** — Not yet created. Risk: duplicate webhooks could cause double-settlement.
3. **Admin recovery route** — Not yet built. Needed for operational support.
4. **Timeout mechanism** — Not yet built. Intents stuck in `ready` for days.
5. **MSB registration** — FINTRAC MSB for CA not yet filed. Blocking: cannot process real CA transfers.

---

## Compliance Checkpoints

| Checkpoint | Status | Blocker |
|---|---|---|
| FINTRAC MSB registered | ⚠️ Not filed | Yes, blocks CA live |
| PAD Rule H1 consent | ✅ In consent language | No |
| KYC retention 5 years | ✅ Stripe + local DB | No |
| Velocity as AML control | ✅ Implemented | No |
| Immutable audit ledger | ✅ ledger_entries | No |
| FinCEN/MTL coverage | ⚠️ Plaid coverage TBD | Yes, blocks US live |

---

*For implementation details, see `CLAUDE.md` and `BANKING_ARCHITECTURE.md`. For session history, see `PROJECT_MEMORY.md`.*
