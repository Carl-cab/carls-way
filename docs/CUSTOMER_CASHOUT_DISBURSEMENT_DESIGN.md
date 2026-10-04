# Customer Cash-Out / Disbursement Design

**Status:** design only — no live rail activation and no provider credentials or secrets are included.
**Scope:** Canadian and US P2P wallet withdrawals to a destination the withdrawing customer owns or is authorized to use.
**Decision date:** 2026-10-04. Provider documentation and availability must be re-checked during implementation and contracting.

> **Critical boundary:** A Stripe `Payout` created on the platform account is a movement from the platform's Stripe balance to the platform account's configured external bank account. It is **not** evidence that a wallet customer's bank account received funds. The current code intentionally records `payout.*` operationally but does not settle it as a customer cash-out. That behavior remains correct until a recipient-owned disbursement rail exists.

This document replaces neither legal advice, sponsor-bank requirements, provider contracts, risk approval, nor a formal accounting review. “Verified,” “eligible,” and “settled” below are product-control states, not assertions of regulatory compliance or a promise that a bank will accept a payment.

## 1. Goals and design principles

1. **Pay a customer-owned destination, never the platform's default payout account.** Every cash-out has a local recipient/destination record and a provider-side destination or transfer reference that can be tied to it.
2. **Separate funding from disbursement.** Stripe ACSS/PAD and US ACH Direct Debit are inbound debit products in the present architecture. An inbound mandate or payment method must not be silently repurposed as proof that an outbound customer credit is allowed.
3. **Use an immutable accounting trail and a reserved balance.** A request moves value out of the spendable wallet balance immediately into a withdrawal hold; it does not make a platform payout a customer payment.
4. **Treat external state as asynchronous and fallible.** A timeout is `outcome_unknown`, not `failed`; provider event delivery can be duplicated or out of order; a posted transfer can later be returned.
5. **Be provider-agnostic in domain code.** Provider adapters translate their native recipient, transfer, event, and reconciliation semantics into one domain model. They do not mutate wallet balances directly.
6. **Default closed.** Cash-out is unavailable unless a jurisdiction/rail capability is explicitly approved, configured, tested, and released. This design does **not** enable `PLAID_TRANSFER_LIVE` or `CA_EFT_LIVE`.

## 2. Existing-system boundary and material gap

The existing `transfer_intents` model combines `add_money` and `cash_out`. It correctly has a record-only Stripe path: `stripe.payouts.create()` is a platform payout, and `payout.*` events are deliberately excluded from the settlement adapter. The current `CanadianEFTProvider` comment that calls this a customer cash-out is scaffolding, not a valid production delivery design.

A production implementation must introduce a **separate disbursement aggregate** rather than teaching the generic inbound transfer path to settle platform payouts. It can share common money, audit, provider-event, rate-limit, and ledger infrastructure, but it needs its own recipient, consent, hold, lifecycle, and reconciliation rules.

## 3. Jurisdiction and provider-product decision

### 3.1 Assumptions and capability gate

| Dimension | Initial assumption | Required release gate |
|---|---|---|
| Customer | Individual consumer wallet user, authenticated and eligible under Manna's program policy; business recipients are out of the initial scope. | Compliance/risk approval of customer eligibility and prohibited-use policy. |
| US | USD domestic credit to a US bank destination. ACH is asynchronous; timing and return exposure must be modeled. | Written provider/sponsor-bank confirmation that the **consumer P2P wallet cash-out** use case, flow of funds, originator, SEC code, recipient setup, and limits are permitted. |
| Canada | CAD domestic credit to a Canadian bank destination. Stripe ACSS/PAD remains an inbound PAD option only. | A Canadian outbound-credit/EFT partner or sponsor-bank program expressly approved for this use case, including recipient verification, returns, reporting, and funding mechanics. |
| Cross-border and FX | Not in v1. A CAD wallet goes only to CAD-capable Canadian destination and USD wallet only to USD-capable US destination. | Separate treasury, FX, disclosure, sanctions, consumer-protection, and provider review. |
| Funding source | Only ledger funds marked disbursable by policy; pending/recently funded/held funds are excluded. | Treasury and accounting sign-off on reserve/hold windows and prefunding. |

### 3.2 Recommended product posture

**US — evaluate a provider-issued outbound ACH credit product, but contract for the exact use case.** Plaid Transfer's standard flow has an authorization-before-create model and supports credit transfers; it requires `user.legal_name`, transfer type, network, ACH class, and recommends idempotency on authorization ([Plaid: creating transfers](https://plaid.com/docs/transfer/creating-transfers/)). It is a *candidate adapter*, not an authorization to launch this product. Plaid's **Transfer for Platforms** documentation specifically says financial-services use cases including P2P payments are not currently eligible for that beta ([Plaid: Transfer for Platforms](https://plaid.com/docs/transfer/platform-payments/)). Do not infer eligibility from the existing Plaid scaffold. Use Plaid only if its direct product agreement and risk review explicitly permit Manna's actual flow; otherwise select a sponsor-bank/processor whose agreement does.

**Canada — do not use Stripe ACSS/PAD or a platform payout as the cash-out rail.** Stripe describes ACSS debit as accepting a Canadian customer's PAD after mandate and verification; confirmation can be delayed and failures/disputes can occur ([Stripe: Canadian PAD](https://docs.stripe.com/payments/acss-debit)). That is appropriate context for *funding* a wallet, not proof of an outbound customer-credit capability. Select a Canadian EFT/credit provider or sponsor-bank program only after it explicitly approves the wallet disbursement flow. Keep the present `CA_EFT_LIVE` control disabled.

**Stripe Connect/Treasury — only after a distinct product review.** Connect can collect external accounts for a **connected account**, including Financial Connections ownership data in the US ([Stripe: Connect payout accounts](https://docs.stripe.com/connect/payouts-bank-accounts)). That could be evaluated if each withdrawing customer is validly represented as an approved connected account, with the resulting obligations accepted. It is not interchangeable with a platform payout. Stripe Treasury OutboundTransfer documentation says it moves between accounts owned by the same entity and directs different-entity movement to OutboundPayment ([Stripe: outbound transfers](https://docs.stripe.com/treasury/connect/moving-money/out-of/outbound-transfers)); it is not selected as a generic P2P cash-out rail without Stripe approval and an explicit product design.

### 3.3 Provider-neutral adapter contract

Create `DisbursementProvider`, separate from `TransferProvider`:

```ts
interface DisbursementProvider {
  readonly provider: string;
  readonly jurisdictions: ReadonlyArray<'US' | 'CA'>;

  beginDestinationLink(input: DestinationLinkInput): Promise<DestinationLinkSession>;
  refreshDestination(input: DestinationRefreshInput): Promise<DestinationEvidence>;
  preflight(input: DisbursementPreflight): Promise<ProviderDecision>;
  submit(input: SubmitDisbursement): Promise<SubmissionResult>;
  cancelIfSupported(input: CancelDisbursement): Promise<CancelResult>;
  get(input: ProviderReference): Promise<ProviderTransferSnapshot>;
  syncEvents(cursor: string | null): Promise<ProviderEventPage>;
}
```

The adapter returns opaque provider IDs and normalized capability/evidence/status data. It never accepts raw bank account or routing/transit numbers from Manna application servers if the provider offers hosted collection/linking, and it never writes ledger rows or user balances.

## 4. Customer-owned recipient and destination model

### 4.1 Terms

- **Recipient:** Manna's record for the entity intended to receive a disbursement. In v1 it is one individual wallet user acting as self-recipient; `recipient.user_id` must equal `disbursement.user_id`.
- **Destination:** one bank-account or provider payment-method reference under a recipient. It is a payment destination, not merely an inbound payment method.
- **Ownership evidence:** provider-reported account holder/ownership data, account-linking proof, microdeposit or other verification result, and the matching decision. Evidence may be unavailable, incomplete, stale, or show joint ownership; it is not a blanket legal guarantee of ownership.
- **Disbursement:** the customer-requested, idempotent instruction to pay a specific amount/currency from one wallet to one active destination.

### 4.2 Eligibility and ownership policy

A destination can be selected only when all rules below hold:

1. Recipient is the authenticated wallet user, is not locked/restricted, and meets the program's KYC/risk policy. Do not equate current `kyc_status = verified` with all program obligations; define the release policy separately.
2. Destination is active, in the selected jurisdiction/currency, linked through the selected provider's supported flow, and has no unresolved relink, account-closed, fraud, or ownership-review signal.
3. The required ownership evidence is fresh enough for the rail/risk tier and is an **exact or policy-approved match** to the recipient's verified legal identity. Record comparison inputs by references/hashes and the result/reason; do not store more PII than needed.
4. Joint accounts, partial matches, legal-name changes, third-party/business destinations, and evidence unavailable from the institution follow a documented manual-review or disallow policy. They never fall through as “verified.”
5. A destination change is high risk: require authenticated re-entry/step-up according to product policy, notify the user through an existing verified channel, apply a cooling-off period or review where policy requires, and prevent an existing order from silently retargeting.

For a US Stripe Financial Connections option, request ownership permission only with user permission; Stripe notes that ownership availability varies by institution and returns fields/owners the bank supplies ([Stripe: Financial Connections ownership](https://docs.stripe.com/financial-connections/ownership)). Treat its `succeeded` refresh and returned owners as evidence to evaluate, not a universal name-match guarantee.

### 4.3 Destination lifecycle

```text
created
  -> linking                 (hosted provider collection started)
  -> evidence_pending        (link completed; ownership/verification refresh pending)
  -> verification_required   (microdeposit, re-auth, or other action required)
  -> eligible                (policy accepted the evidence)
  -> suspended               (relink, risk signal, stale evidence, provider issue)
  -> revoked                 (customer/admin removal; cannot be newly selected)

Any nonterminal state -> rejected (unsupported country/currency, mismatch, provider decline)
eligible -> stale -> evidence_pending | verification_required | suspended
```

Only `eligible` destinations accept new cash-outs. Existing orders reference the immutable `destination_id` and a destination snapshot; later edits create a new destination version rather than changing an in-flight order.

### 4.4 Bank-account data protection

- Prefer a hosted/link flow and store only provider tokens/opaque IDs, institution display name, country/currency, account type, masked suffix, and evidence status.
- Encrypt any provider token at rest; do not log it, return it to clients, place it in metadata, or include it in support exports.
- Restrict decryption and provider calls to a narrowly scoped service identity; audit destination view/change/relink/disable actions.
- Build deletion/retention behavior around legal, provider, fraud-investigation, accounting, and user-request requirements approved for the program. “Delete from UI” normally means revoke for new use; it does not imply immediate destruction of required records.

## 5. Disbursement state machine

### 5.1 States

```text
created
  -> review_required
  -> awaiting_confirmation
  -> held
  -> submitting
  -> provider_accepted
  -> posted
  -> settled_or_delivered

awaiting_confirmation -> cancelled
held                  -> cancelled | expired | blocked
submitting            -> outcome_unknown | provider_rejected
outcome_unknown       -> submitting | provider_accepted | manual_review
provider_accepted     -> posted | provider_rejected | failed | returned | manual_review
posted                -> settled_or_delivered | failed | returned | reversed | manual_review
settled_or_delivered  -> returned | reversed | manual_review
```

`settled_or_delivered` means the provider supplied its configured terminal-success signal; it does **not** promise the customer has irrevocably received money. `returned`, `reversed`, and late adjustments remain possible where the rail/provider reports them.

### 5.2 Transition controls

| Transition | Actor | Required invariant |
|---|---|---|
| `created → awaiting_confirmation` | API | Destination is eligible; amount is positive minor units; wallet has disbursable funds after existing holds; limits/risk rules pass. |
| `awaiting_confirmation → held` | Customer + transactional worker | Customer confirms an immutable review snapshot; write consent evidence and reserve journal atomically with a unique business idempotency key. |
| `held → submitting` | Worker | Claim order with row lock/lease; hold has not expired; destination version remains eligible; no terminal provider reference exists. |
| `submitting → outcome_unknown` | Worker/reconciler | Transport timeout/crash/ambiguous response. Preserve request fingerprint and do **not** release the hold or submit a new transfer. |
| `submitting/outcome_unknown → provider_accepted` | Provider response/reconciliation | Persist provider transfer/reference atomically with attempt record; references are unique within provider. |
| provider event transitions | Verified normalizer | Deduplicate by provider event identity and business event identity; validate allowed transition; retain raw event evidence. |
| failure/return/reversal | Verified event or reconciliation | Create compensating journal entries from the prior accounting state; never overwrite prior journal entries. |
| manual override | Dual-controlled operations workflow | No direct “mark settled” button. Require reason, evidence, actor/approver, immutable audit records, and a compensating journal if money state changes. |

Cancellation is best-effort only before a provider-defined irrevocable point. The UI must show “cancellation requested” until provider/local reconciliation decides it; never represent a local cancellation as a bank cancellation after submission.

## 6. Customer consent and disclosures

### 6.1 Cash-out review and confirmation

Before confirmation, display and persist an immutable snapshot of:

- recipient name/relationship (“your linked account”), institution and masked account suffix;
- amount, currency, any fee, and total debit from wallet; no FX in v1;
- estimated delivery window as an estimate, not a guarantee; current status and how it will be communicated;
- cancellation limits; what to do if the destination is wrong, funds do not arrive, or a destination change was not authorized;
- a plain-language acknowledgement that only a customer-owned/authorized destination may be used and that the action sends the displayed amount to the displayed destination;
- links to current terms, privacy notice, support/dispute process, and any rail-specific notices approved for the product.

Persist: disclosure/terms version and hash, rendered review fields, selected destination version, confirmation timestamp, authenticated user ID, session/request correlation ID, IP/user-agent only where approved by policy, and a server-side confirmation nonce. Make confirmation POST idempotent and reject changed amount/destination/fee/disclosure versions.

### 6.2 Distinguish credit disbursement from inbound debit consent

Do **not** label a cash-out confirmation an ACH/PAD debit mandate. Inbound US ACH Direct Debit requires customer authorization/mandate and account verification ([Stripe: ACH Direct Debit](https://docs.stripe.com/payments/ach-direct-debit)); Canadian PAD requires a mandate before debiting and Stripe states Rule H1 governs PAD mandate/confirmation/pre-debit notification requirements ([Stripe: Canadian PAD](https://docs.stripe.com/payments/acss-debit)). Those requirements remain relevant to **add money** only.

If a selected US provider requires proof of authorization for a related debit, collect/store it using the provider's required flow. Plaid says that, when not using its Transfer UI, debit proof of authorization must be collected and stored for at least two years; this is an implementation input to validate against the actual program/SEC code, not a statement of Manna's complete retention duty ([Plaid: creating transfers](https://plaid.com/docs/transfer/creating-transfers/)).

## 7. Money, holds, reserves, and double-entry accounting

### 7.1 Source of truth and availability

Replace “user balance is enough” checks with a ledger-derived **disbursable balance** projection:

```text
disbursable = settled wallet credits
            - settled wallet debits
            - active withdrawal holds
            - risk/chargeback/reserve holds
            - other non-disbursable restrictions
```

Use integer minor units (or a rigorously defined decimal money type) per currency. Never use JS floating-point as the accounting authority. The current `NUMERIC` fields are useful storage, but new journal/order columns should include `amount_minor BIGINT` and ISO currency, with conversion only at API/provider boundaries.

Funds credited through delayed/returnable rails are not automatically disbursable. Product risk, treasury, and provider agreements must set hold/release policies per rail, risk tier, currency, and return exposure. For context, Stripe says ACH Direct Debit can acknowledge success/failure up to four business days later and can fail/dispute after initiation; Stripe says ACSS/PAD final confirmation can take up to five business days and failures/disputes can follow ([Stripe ACH](https://docs.stripe.com/payments/ach-direct-debit), [Stripe PAD](https://docs.stripe.com/payments/acss-debit)). These are not sufficient on their own to set Manna's reserve period.

### 7.2 Illustrative journal entries

Final account naming/chart-of-accounts requires accounting review. The following is a balanced design pattern, using normal balance classes: customer balances are liabilities; provider cash is an asset.

| Business event | Debit | Credit | Effect |
|---|---|---|---|
| Customer confirms/hold acquired | `customer_wallet_available` | `customer_withdrawal_hold` | Removes funds from spendable balance while retaining customer liability. |
| Provider definitively rejects before money movement / hold expires | `customer_withdrawal_hold` | `customer_wallet_available` | Releases reserved value. |
| Provider reaches the configured cash-release point | `customer_withdrawal_hold` | `customer_disbursement_payable` | Reclassifies reserved customer funds to an outbound payable. |
| Provider confirms the configured cash-out/debit point | `customer_disbursement_payable` | `provider_cash` | Reduces obligation and the platform/provider cash asset. Use a provider-specific clearing account if timing requires it. |
| Credit returns and funds are recovered | `provider_cash` | `customer_wallet_available` | Restores customer wallet value by compensating entry. |
| Late provider adjustment/loss | Determined by approved accounting policy | Determined by approved accounting policy | Do not silently debit a customer or write off a difference; open a case and use explicit adjustment accounts. |

Each entry carries `journal_id`, `journal_line_id`, `disbursement_id`, `attempt_id`, currency/minor units, business-event key, provider reference/event, correlation ID, created time, and reversal linkage. Enforce (a) journal balance per currency, (b) one accounting action per `disbursement_id + business_event_key`, and (c) append-only compensations rather than edits.

### 7.3 Holds and risk reserve behavior

- The first successful confirmation performs a row-locked availability check and creates the hold in the same database transaction. A second confirmation with the same idempotency key returns the original order; a different key cannot reserve the same funds twice.
- A hold has an expiry only before provider submission. Once `submitting` is reached, the order is not auto-released; it is reconciled until known. This avoids paying twice after an ambiguous timeout.
- Provider preflight/risk decline before submission releases the hold. A provider “accepted” response is not reason to release it.
- Manage platform prefunding, provider ledger balance, credit limits, and negative balance exposure separately from customer wallet availability. If liquidity or provider capability is insufficient, block before confirmation or leave the order `blocked`; do not accept then invent a settlement date.

## 8. Provider references, correlation, webhook normalization, and idempotency

### 8.1 Correlation data

Generate a non-PII immutable `disbursement_id` (UUID) before any provider call and carry it through every record. Store, where the provider permits, metadata such as:

```text
manna_disbursement_id
manna_attempt_id
manna_destination_version_id
manna_correlation_id
manna_environment
```

Do **not** put full names, email, address, bank numbers, raw Link tokens, KYC data, or secrets in provider metadata/idempotency keys. Use separate fields for provider `recipient_id`, `destination_id`, `authorization_id`, `transfer_id`, `ledger/sweep_id`, `event_id`, request ID, trace ID, and funding account ID. Provider reference uniqueness should be `(provider, provider_object_type, provider_reference)` rather than a single global text field.

### 8.2 Two layers of idempotency

1. **Business idempotency:** `POST /cash-outs` requires an opaque client `Idempotency-Key`. Persist `(customer_id, endpoint, key, canonical_request_hash) → disbursement_id/response`; same key plus different body conflicts. This key lasts according to Manna retention/replay policy, not a provider's short key retention.
2. **Provider idempotency:** derive a separate opaque key from stable `disbursement_id + attempt_type` and persist it before submission. Keep it within provider limits. Stripe supports idempotency on POST requests but says keys may be pruned after at least 24 hours; a later reuse can create a new request ([Stripe: idempotent requests](https://docs.stripe.com/api/idempotent_requests)). Therefore post-expiry recovery must be provider lookup/reconciliation or manual review, **not blind replay**.

A submit worker claims one `held` order using `SELECT … FOR UPDATE`/lease, writes the attempt and provider key, then calls the provider outside the DB transaction. A timeout leaves `outcome_unknown` with durable correlation data. The reconciler looks up by durable provider ID/metadata/authorization/cursor before any retry.

### 8.3 Normalized event envelope

Persist raw verified events separately, then normalize to a provider-neutral event:

```ts
{
  source: 'webhook' | 'poll' | 'file' | 'operator',
  provider,
  providerEventId,          // source delivery identity when available
  providerBusinessEventId,  // stable transfer-event/sweep identity when available
  providerObjectType,
  providerReference,
  disbursementId: null | string,
  attemptId: null | string,
  eventKind: 'accepted' | 'posted' | 'settled' | 'failed' |
             'returned' | 'reversed' | 'cancelled' | 'adjusted',
  occurredAt: null | Instant,
  receivedAt: Instant,
  payloadHash,
  rawEventId,
}
```

Do not drive a balance change directly from an HTTP webhook handler. Handler flow is: verify → persist/uniquely dedupe → enqueue → acknowledge promptly → worker resolves recipient/order/reference → validates transition → atomically writes state/audit/journal/projection outbox. Unknown, contradictory, missing-reference, or invalid-transition events are retained and sent to an exception queue.

Stripe says events can be duplicate and out of order, recommends event-ID tracking, and retries live deliveries for up to three days; it also requires signature verification ([Stripe webhooks](https://docs.stripe.com/webhooks)). Plaid likewise instructs consumers to handle duplicate/out-of-order webhooks, retry failures for up to 24 hours, and recover by polling when needed ([Plaid webhooks](https://plaid.com/docs/api/webhooks/)). These provider guarantees are inputs to Manna's own durable dedupe/recovery design, not substitutes for it.

For Plaid Transfer specifically, `TRANSFER_EVENTS_UPDATE` is a notification to call `/transfer/event/sync`; one webhook can represent multiple events ([Plaid Transfer event reading](https://plaid.com/docs/api/products/transfer/reading-transfers/)). Use the monotonic event cursor for the authoritative sync job. Do not depend on a fabricated webhook body hash as the sole economic-event identity.

## 9. Failures, returns, reversals, and customer communication

| Outcome | Local handling | Customer posture |
|---|---|---|
| Destination/provider preflight reject | Mark failed/rejected; release hold atomically; record sanitized reason code. | “This destination/withdrawal cannot be used” with relink/support path; do not reveal sensitive risk logic. |
| Submission timeout/unknown outcome | Keep hold; set `outcome_unknown`; reconcile by provider lookup/event sync before retry. | “We are confirming your withdrawal; do not submit again.” |
| Provider accepted/pending | Retain hold/payable according to configured accounting point; monitor SLA. | “In progress,” with estimate and destination suffix. |
| Failed before cash movement | Compensate payable/hold to available wallet once confirmed. | “Not sent; funds are available again.” |
| Posted/settled/delivered | Apply configured final accounting event; record receipt/reference. | “Sent” or “completed” only in terminology supported by provider signal; do not promise irreversible receipt. |
| Returned/reversed | Ingest code/reason and return event; post compensating entries only when funds/provider balance are actually restored or per approved accounting policy; flag possible destination disable/review. | Explain that the bank/provider returned the withdrawal, show safe next step, and show wallet restoration only when applied. |
| Late adjustment or conflicting events | Freeze automated resolution; case queue; reconcile provider, treasury cash, journal, and recipient state. | Avoid a false final status; notify that support is investigating if customer action is needed. |

Plaid describes `failed` as no funds moved, `posted` as submitted to the network, `settled` as completed, and `returned` as a posted transfer returned; it also exposes adjustment/recovery event types ([Plaid Transfer events](https://plaid.com/docs/api/products/transfer/reading-transfers/)). Its return guidance says ACH credit returns are returned to the Ledger available balance and warns that ACH return windows differ by reason ([Plaid errors and returns](https://plaid.com/docs/transfer/troubleshooting/)). Map these facts only in a Plaid adapter; do not assume every provider has identical semantics.

## 10. Reconciliation and operations

### 10.1 Reconciliation controls

Run independent, repeatable reconciliation jobs; a webhook is not a ledger statement.

| Frequency | Compare | Required result/action |
|---|---|---|
| Near-real-time | Submitted/unknown orders vs provider `get` and event-sync cursor | Recover references/statuses; age unknowns into alert/case queues. |
| Daily by rail/currency | Local disbursement attempts/events/journals vs provider transfer/event/report exports and provider ledger/funding account movements | Every provider transfer maps to one local attempt; every economic event maps to one journal action or an exception. |
| Daily treasury | Provider cash/ledger/funding-account balance vs `provider_cash`/clearing GL and outstanding customer payable/holds | Explain timing differences; block new submissions when prefunding/limits are insufficient. |
| Periodic and on incident | Eligible destination evidence, stale/relinked accounts, high-risk changes, return rates, manual overrides | Suspend affected destinations, investigate exceptions, and record approvals. |

Reconciliation keys include provider transfer/authorization/event/sweep IDs, date/currency/minor units, funding account, source report row, `disbursement_id`, and attempt ID. Do not reconcile on customer name or masked account alone. A break is an explicit state with owner, evidence, amount, aging, resolution, and any correction journal—not a spreadsheet-only adjustment.

### 10.2 Operational controls

- **Release gates:** provider/sponsor-bank approval for exact use case; counsel/compliance/risk/accounting/treasury/privacy/security sign-off; supported-country/currency capability configuration; production runbook and escalation contacts; sandbox/limited pilot sign-off; feature flag default off.
- **Least privilege:** separate support, operations, reconciliation, and engineering roles. Destination changes, payout release, and manual adjustments require auditable maker/checker controls appropriate to risk policy.
- **Monitoring:** age in `submitting`/`outcome_unknown`, hold expiry, webhook verification failures, sync lag/cursor gaps, unmatched events, duplicate submit attempts, provider decline/return rates, destination-change velocity, negative/low prefunding, and manual override volume.
- **Incident response:** stop new submissions by rail/country without altering existing order evidence; preserve raw events/audit logs; reconcile before releasing holds; notify affected customers only from confirmed state.
- **Support tooling:** show masked destination, order timeline, non-sensitive reason category, provider references, journal/case links, and correlation ID. Never expose raw bank data, provider secrets, or internal risk rules.

## 11. Security, privacy, and compliance questions requiring decisions

The following are questions to resolve with qualified counsel, compliance, sponsor bank(s), providers, privacy/security, tax, treasury, and accounting. They are intentionally questions, not claims that the current system satisfies them.

1. What legal entity is the originator/sender, what is the end-to-end flow of funds, and is the consumer P2P wallet/cash-out model permitted in each provider/sponsor agreement?
2. Which US ACH SEC code is correct for the actual credit/debit flow, and what authorization, proof, return, notice, monitoring, and retention duties apply? Plaid warns using an incorrect ACH class can cause failures and other consequences ([Plaid: creating transfers](https://plaid.com/docs/transfer/creating-transfers/)).
3. What Canadian rail, rule set, notice/recipient information, return/reversal process, and sponsor-bank obligations apply to the selected outbound credit product? Do not derive outbound EFT rules from inbound PAD documentation.
4. What identity/KYC, sanctions, transaction monitoring, fraud, suspicious-activity, consumer-protection, money-transmission/registration, safeguarding, and complaints requirements apply to Manna's legal entities and the complete flow of funds in each jurisdiction?
5. What destination ownership evidence is sufficient by risk tier, how are joint accounts/legal name changes handled, and when is manual review mandatory?
6. What customer funds are safeguarded/prefunded, where are they held, who bears returns/negative balance exposure, and what reserve/hold/release policy is approved?
7. What disclosure, consent, receipt, error-resolution, cancellation, privacy, data residency, data-minimization, retention, and deletion requirements apply? Which artifacts must be retained and for how long?
8. What limits, velocity controls, cooling-off periods, authentication/step-up, device/account-takeover controls, and operational approval thresholds are required?
9. What accounting policy determines the cash-release/settlement point, return/adjustment treatment, unclaimed-property treatment, fee/tax treatment, and financial reporting reconciliation?
10. What vendor SLAs, incident reporting, audit rights, report retention, webhook verification, service-account access, key rotation, business-continuity, and manual investigation paths are contractually available?

## 12. Explicit non-goals

- Activating any real rail, setting `PLAID_TRANSFER_LIVE` or `CA_EFT_LIVE`, changing secrets, or moving real funds.
- Treating a Stripe platform `Payout` as a customer cash-out or mapping `payout.*` to wallet settlement.
- Supporting cross-border payouts, FX conversion, wires, cards/instant payouts, cash pickup, third-party beneficiaries, business recipients, payroll, merchant/vendor payouts, or recurring scheduled withdrawals in v1.
- Claiming provider, regulatory, licensing, ACH/PAD, sanctions, KYC, safeguarding, tax, or consumer-protection compliance without the required program review.
- Relying solely on KYC status, a linked bank account, a successful inbound debit, a platform payout, a UI confirmation, or a webhook as proof that a customer-owned destination was paid.
- Reusing inbound `transfer_intents` as the production disbursement aggregate without the data/state/accounting separation described here.

## 13. Implementation plan (design only)

### Phase 0 — program decision and architecture record

1. Choose supported launch corridor(s) and a provider/sponsor-bank product **only after written use-case approval**.
2. Produce a flow-of-funds diagram, accounting memo/chart of accounts, policy decision log, risk limits, disclosures, and provider capability matrix.
3. Document exact provider success/failure/return semantics and event/reporting coverage in adapter conformance tests.
4. Keep live flags disabled. Add a separate `CUSTOMER_DISBURSEMENT_ENABLED=false` default capability gate; it must be impossible for a configuration change alone to turn an unapproved provider product into a live cash-out.

### Phase 1 — database and ledger migrations

Use reviewed, versioned migrations (not an ad-hoc endpoint) to add:

| Table / change | Key fields and constraints |
|---|---|
| `recipients` | UUID, `user_id`, recipient type, legal-profile version/reference, country, status, created/revoked timestamps; v1 `UNIQUE(user_id)` self-recipient. |
| `recipient_destinations` | UUID, recipient ID, version, provider, provider destination reference, country/currency/type, display institution/mask, lifecycle state, evidence freshness, active/revoked timestamps; unique provider reference by provider/object type. |
| `destination_verification_evidence` | Destination/version, method/provider, opaque evidence reference, owner-match result/reason category, captured/refreshed/expiry timestamps, raw-data retention pointer; no raw bank credential. |
| `cashout_disbursements` | UUID, user/recipient/destination version, amount minor/currency, state, disclosure snapshot/hash, business idempotency key/request hash, correlation ID, hold journal ID, failure/review reason category, timestamps. |
| `cashout_attempts` | UUID, disbursement ID, provider/capability version, provider idempotency key/request fingerprint, provider authorization/transfer references, attempt state, submitted/response timestamps, retry/reconciliation linkage. |
| `journal_entries` / `journal_lines` | Append-only balanced journals, currency/minor units, account, business-event idempotency key, disbursement/attempt/provider-event references, reversal links. Migrate/projection-plan away from one-row `ledger_entries` assumptions. |
| `provider_events` extension | Provider delivery ID, economic-event ID, object/reference, raw encrypted/retained payload pointer/hash, normalizer version, cursor, process state, correlation; unique delivery and business-event keys where available. |
| `reconciliation_breaks` / `manual_review_cases` | Source/report evidence, amount/currency, state, owner, maker/approver, resolution journal/event, audit timestamps. |

Add foreign keys, check constraints for supported states/currencies/nonnegative amounts, partial unique active-destination rules, retention indexes, and unique keys that make duplicate submissions/events/journals impossible. Backfill nothing into the new model as “paid”; existing cash-out scaffold rows remain historical/reviewable records.

### Phase 2 — services and APIs

1. Add `DisbursementProvider` adapters and a capability registry keyed by country, currency, recipient type, and provider approval state.
2. Implement hosted destination-link/refresh endpoints; do not add raw account-number APIs.
3. Add endpoints (illustrative names):
   - `POST /api/cash-out/destinations/link-session`
   - `POST /api/cash-out/destinations/complete`
   - `GET /api/cash-out/destinations`, `PATCH /api/cash-out/destinations/{id}/revoke`
   - `POST /api/cash-outs` (requires business `Idempotency-Key`; creates review/order only)
   - `POST /api/cash-outs/{id}/confirm`
   - `POST /api/cash-outs/{id}/cancel` (best-effort by state)
   - `GET /api/cash-outs/{id}` and paginated history
   - internal authenticated worker/admin endpoints for reconcile/case actions, never public force-settle.
4. Implement transactional availability/hold creation, durable outbox/job dispatch, submission lease, provider lookup/recovery, append-only journal posting, and read-model projection.
5. Add verified webhook receivers and poll/sync workers. Preserve existing Stripe `payout.*` record-only behavior; add only a dedicated adapter mapping for an approved recipient-owned disbursement object.
6. Require reauthentication/step-up, CSRF/session protections appropriate to the app's auth model, rate/velocity controls, structured audit logs, redaction, and authorization checks on every destination/order action.

### Phase 3 — UI and communications

- Wallet cash-out entry point shows **available to withdraw**, not a raw account balance; clearly separates pending/held/reserved funds.
- Destination manager supports add/link, verification progress, name-match/review status at an appropriate privacy level, relink, revoke, and recent-change warning; never displays full account data.
- Review/confirm screen renders the immutable disclosure snapshot and requires explicit confirmation; errors are actionable without exposing fraud/risk criteria.
- Order details/timeline distinguishes “review,” “held,” “processing,” “sent,” “returned,” and “funds restored” from final bank receipt where evidence is weaker.
- Notifications are idempotent and triggered from the outbox after state/journal commit. Provide accessible, localized copy reviewed for US/Canada release corridor(s).

### Phase 4 — testing, pilot, and controlled release

1. Implement the test matrix in [`CUSTOMER_CASHOUT_DISBURSEMENT_TEST_MATRIX.md`](./CUSTOMER_CASHOUT_DISBURSEMENT_TEST_MATRIX.md), provider contract tests, migration tests, and ledger invariants before a live pilot.
2. Test sandbox/provider test environments and reconciliation reports; do not treat sandbox status timing as production proof.
3. Run a gated internal simulation and finance reconciliation exercise; obtain formal release approvals.
4. Start with narrow jurisdiction/currency/limit cohort, daily operations review, feature kill switch, and measured expansion only after return/failure/reconciliation controls work.

## 14. Source notes

Authoritative provider sources consulted on **2026-10-04** (availability, terms, and API behavior can change):

1. [Stripe — Receive payouts](https://docs.stripe.com/payouts) (platform balance to its configured bank account; payout timing/failure context).
2. [Stripe — Manage payout accounts for connected accounts](https://docs.stripe.com/connect/payouts-bank-accounts) (connected-account external destinations and US ownership-data option).
3. [Stripe — Canadian pre-authorized debit payments](https://docs.stripe.com/payments/acss-debit) (inbound PAD mandate, verification, delayed status, failure/dispute, Rule H1 reference).
4. [Stripe — ACH Direct Debit payments](https://docs.stripe.com/payments/ach-direct-debit) (inbound ACH authorization, verification, delayed failure/dispute context).
5. [Stripe — Webhooks](https://docs.stripe.com/webhooks) (signature verification, retry, duplicate, and out-of-order handling).
6. [Stripe — Idempotent requests](https://docs.stripe.com/api/idempotent_requests) (request idempotency behavior and retention caveat).
7. [Stripe — Financial Connections ownership](https://docs.stripe.com/financial-connections/ownership) (permissioned ownership data and varying institution availability).
8. [Stripe — Treasury outbound transfers](https://docs.stripe.com/treasury/connect/moving-money/out-of/outbound-transfers) (same-owner / connected-account context and event types).
9. [Plaid — Creating transfers](https://plaid.com/docs/transfer/creating-transfers/) (authorization, idempotency, ACH class, proof-of-authorization guidance).
10. [Plaid — Transfer events and event sync](https://plaid.com/docs/api/products/transfer/reading-transfers/) (event meanings, event sync, and webhook behavior).
11. [Plaid — Webhooks](https://plaid.com/docs/api/webhooks/) (retry, duplicate/out-of-order, polling recovery guidance).
12. [Plaid — Errors and returns](https://plaid.com/docs/transfer/troubleshooting/) (return, reversal, retry, and recovery semantics).
13. [Plaid — Transfer for Platforms](https://plaid.com/docs/transfer/platform-payments/) (beta scope and P2P ineligibility statement; platform ledger/hold context).
14. [Payments Canada Rule H1](https://www.payments.ca/sites/default/files/h1eng.pdf) (primary rule referenced by Stripe for Canadian PAD; review the current rule with the selected sponsor/processor).
