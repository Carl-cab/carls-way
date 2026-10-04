# Customer Cash-Out / Disbursement Test Matrix

**Status:** skeleton for the design in [Customer Cash-Out / Disbursement Design](./CUSTOMER_CASHOUT_DISBURSEMENT_DESIGN.md).
**Safety constraint:** All automated tests use mocks, fixtures, local database transactions, or provider sandbox facilities. They must not set `PLAID_TRANSFER_LIVE`, `CA_EFT_LIVE`, or production credentials, and they must not create a real payment.

## How to use this matrix

- Mark each row **Not started / Automated / Manual evidence / N/A** and link the test ID, fixture, run date, release evidence, and owner.
- For every approved provider/rail, implement an adapter-conformance suite in addition to application tests. Do not copy a status mapping from another rail without provider documentation and contract confirmation.
- Assertions involving delivery, return windows, authorization, limits, or ownership are **release validation questions**, not presumed provider guarantees. Capture the current provider documentation version and program approval evidence.
- A passing sandbox test does not authorize production activation. Production release requires the non-code approvals and reconciliation exercise listed in the design.

## A. Domain, API, and authorization

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-API-001 | Feature default closed | All normal environments, capability absent | Cash-out creation returns a safe unavailable response; no provider call, hold, or journal occurs. | Unit/integration | Not started |
| CO-API-002 | AuthN/AuthZ isolation | User A attempts User B destination/order reads, confirms, cancels, or revokes | 401/403 or non-enumerating 404; no state change; audit entry only when policy permits. | Integration | Not started |
| CO-API-003 | Business idempotency replay | Repeat `POST /cash-outs` with same opaque key and identical canonical body | Same `disbursement_id`/response; exactly one order and no duplicate hold. | Integration | Not started |
| CO-API-004 | Idempotency mismatch | Reuse key with changed amount, currency, destination, or fee | Conflict; no second order/hold/provider attempt. | Integration | Not started |
| CO-API-005 | Minor-unit validation | Boundary, fractional, negative, overflow, unsupported currency inputs | Strict currency exponent/minor-unit validation; no float rounding or provider call. | Unit/property | Not started |
| CO-API-006 | Availability race | Parallel confirmations that collectively exceed disbursable funds | At most one succeeds; holds never exceed disbursable balance; journals balance. | Integration/concurrency | Not started |
| CO-API-007 | Limits/risk block | Velocity, account lock, KYC/risk restriction, destination cooling-off fixture | Safe block/review state; no provider call; no sensitive decision detail returned. | Integration | Not started |
| CO-API-008 | Changed review snapshot | Change destination/amount/fee/disclosure after review before confirm | Original nonce fails; user must review/confirm immutable new snapshot. | Integration | Not started |
| CO-API-009 | Cancellation by state | Cancel before hold, while held, during submit, after provider accepted | Only allowed transitions occur; provider cancellation is attempted only if supported; no false “cancelled” assertion after irrevocable submission. | Integration | Not started |
| CO-API-010 | Resource enumeration/rate limit | Repeated guessed IDs and request flood | Rate limits and authorization work; response does not leak destination or transfer facts. | Integration/security | Not started |

## B. Recipient and destination ownership lifecycle

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-DST-001 | Hosted link happy path | Provider adapter returns destination token/reference and supported country/currency | Store opaque reference and mask only; never raw credentials; destination is not eligible until evidence policy passes. | Adapter/integration | Not started |
| CO-DST-002 | Ownership exact match | Provider evidence matches verified recipient profile | Destination becomes `eligible` only after configured freshness/status checks; evidence result and source ref are durable. | Adapter/integration | Not started |
| CO-DST-003 | Ownership partial/mismatch/unavailable | Fixtures for name mismatch, joint owners, unavailable ownership data, stale refresh | Follow explicit review/reject path; never default to eligible; sanitized UI reason. | Adapter/integration | Not started |
| CO-DST-004 | Verification action | Microdeposit/re-auth/additional provider step required | State becomes `verification_required`; no cash-out selection/submission before completion. | Adapter/integration | Not started |
| CO-DST-005 | Relink/provider Item error | Provider indicates invalid/revoked/relink-required destination | Destination suspended; new cash-outs rejected; in-flight orders moved to review only per documented policy. | Webhook/integration | Not started |
| CO-DST-006 | Destination update is versioned | Customer replaces or changes linked account | New destination/version created; in-flight order remains tied to immutable prior version; alert/cooling-off policy applied. | Integration | Not started |
| CO-DST-007 | Revocation/deletion | Customer/admin revokes destination | Cannot select for new order; retention/audit behavior follows approved policy; no raw account data leaked. | Integration/manual | Not started |
| CO-DST-008 | Cross-customer reference isolation | Same/different provider refs across users | Unique provider-object reference protects against attaching a destination to wrong recipient; access checks hold. | Integration | Not started |
| CO-DST-009 | Sensitive-data hygiene | Inspect DB, API payloads, logs, metrics, audit events, error paths | No full account/routing/transit number, access token, secret, or raw evidence PII outside approved encrypted/pointer store. | Security/manual | Not started |

## C. Consent, disclosure, and customer experience

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-CNS-001 | Review content | Create eligible order | Amount/currency/fee/total, masked destination, estimate, cancellation and support language render from server snapshot. | UI/integration | Not started |
| CO-CNS-002 | Explicit confirmation evidence | Confirm review | Persist user, time, disclosure version/hash, destination version, request correlation, and nonce; duplicate confirmation is harmless. | Integration | Not started |
| CO-CNS-003 | Inbound/outbound terminology | US/CA review fixtures | Cash-out does not claim a PAD/ACH debit mandate; inbound mandate copy appears only in inbound funding flow. | UI/content | Not started |
| CO-CNS-004 | State language | Pending, unknown, sent, returned, restored fixtures | UI never labels a platform payout or “provider accepted” as customer receipt; avoids irreversible-delivery promise. | UI | Not started |
| CO-CNS-005 | Accessibility/localization | Keyboard/screen-reader and supported language review | Confirmation and error states meet product accessibility/localization acceptance criteria. | Manual/UI | Not started |
| CO-CNS-006 | Notification idempotency | Duplicate events/retries | At most one customer notification per business transition/version; messages use sanitized safe reason category. | Integration | Not started |

## D. Accounting, hold, reserve, and ledger invariants

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-LED-001 | Hold creation | Valid confirmation | Balanced append-only journal moves value from available wallet liability to withdrawal hold; projection makes funds non-spendable. | Integration | Not started |
| CO-LED-002 | Hold release before submission | Expiry/provider preflight rejection | One compensating journal restores availability; repeated event/action produces no duplicate release. | Integration | Not started |
| CO-LED-003 | Provider accepted/accounting point | Adapter fixture for configured success event | Correct hold/payable/cash entries only at policy-approved point; no platform payout event can trigger them. | Integration/adapter | Not started |
| CO-LED-004 | Return/reversal | Prior paid fixture then returned/reversed provider event | Append compensating entries tied to original; availability restored only at approved recovered-funds point; no mutation of prior line. | Integration | Not started |
| CO-LED-005 | Late adjustment | Adjustment after terminal success/return | Automatic posting stops or follows approved narrowly scoped policy; exception case and evidence created. | Integration | Not started |
| CO-LED-006 | Currency separation | CAD and USD orders | Every journal balances per currency; no implicit FX or netting; destination capability matches currency. | Unit/integration | Not started |
| CO-LED-007 | Negative/insufficient funds | Exact balance, just below balance, concurrent hold, reserve fixture | No overdraft from wallet projection; no provider submission if unavailable. | Integration/concurrency | Not started |
| CO-LED-008 | Outbox atomicity | Force process crash after state/journal before notification/job enqueue and vice versa | Transactional outbox retries safely; no lost submission/notification or duplicate financial action. | Fault injection | Not started |
| CO-LED-009 | Journal invariants/property tests | Generated event/order sequences | Sum debits equals credits per journal/currency; business-event uniqueness; all projections reconstruct from journals. | Property/integration | Not started |

## E. Provider submission, adapter behavior, and recovery

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-PRV-001 | Capability gate | Unapproved country/currency/recipient/provider | Adapter cannot be selected; no fallback to a platform payout or another rail. | Unit/integration | Not started |
| CO-PRV-002 | Preflight decline | Provider returns decline/risk rejection | Order rejects, hold releases once, reason category retained, no transfer created. | Adapter/integration | Not started |
| CO-PRV-003 | Stable provider idempotency | Submit retry/process restart | Persisted opaque provider key and request fingerprint remain stable; one logical provider transfer. | Adapter/integration | Not started |
| CO-PRV-004 | Concurrent submit | Two workers claim same held order | One active attempt or equivalent provider-idempotent calls; one provider transfer/reference; no duplicate journal. | Integration/concurrency | Not started |
| CO-PRV-005 | Timeout/ambiguous response | Provider accepts then drops response; provider returns timeout before acceptance | State is `outcome_unknown`, not failed/released; durable lookup data retained; reconciler determines outcome before resubmit. | Fault injection/adapter | Not started |
| CO-PRV-006 | Post-idempotency-retention recovery | Fixture represents provider idempotency window expired | System uses lookup/report/case workflow; it must not blind replay a create request. | Adapter/manual | Not started |
| CO-PRV-007 | Authoritative lookup | Existing provider transfer with Manna correlation metadata/reference | Reconciler attaches exact attempt/order; conflicting/unmatched result opens case, not guessed match. | Adapter/integration | Not started |
| CO-PRV-008 | Unsupported cancellation | Provider cannot cancel after submit | State stays provider-controlled; customer sees cancellation-request/result semantics, not false cancellation. | Adapter/integration | Not started |
| CO-PRV-009 | Provider mapping conformance | Native pending/posted/settled/failed/returned/reversed/adjustment fixtures | Mapping is documented per provider, valid transitions enforced, unknown native event retained for review. | Adapter contract | Not started |
| CO-PRV-010 | No direct balance mutation | Instrument provider adapter methods | Adapter has no database wallet/journal write access; all economics pass the domain accounting service. | Unit/architecture | Not started |

## F. Webhooks, polling, normalization, and idempotency

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-EVT-001 | Signature verification | Valid and invalid Stripe/Plaid/provider-specific signed payload fixtures | Raw body verification required; invalid/missing signature is rejected before persistence/economic processing. | Unit/integration | Not started |
| CO-EVT-002 | Delivery duplicate | Same provider event delivered repeatedly | One raw event record/process result; no duplicate state, journal, projection, or notification. | Integration | Not started |
| CO-EVT-003 | Economic duplicate | Different delivery IDs represent same object+business event | Business-event uniqueness prevents duplicate effect; preserve both delivery evidence. | Integration | Not started |
| CO-EVT-004 | Out-of-order events | Settled before posted, return before local reference, stale pending after terminal | State machine converges safely or opens case; no backwards/invalid balance change. | Integration | Not started |
| CO-EVT-005 | Webhook fast acknowledgement | Slow downstream dependency fixture | Handler verifies/persists/enqueues then returns within provider window; worker owns processing. | Integration/performance | Not started |
| CO-EVT-006 | Retry/dead-letter | Repeated worker failure | Retries tracked; threshold produces durable dead letter/case; requeue is auditable and idempotent. | Integration | Not started |
| CO-EVT-007 | Poll/event-sync gap recovery | Drop webhook(s), advance provider cursor/events | Poll/sync imports all missed events; cursor monotonicity and pagination tested. | Adapter/integration | Not started |
| CO-EVT-008 | Payload retention/redaction | Persist raw event and inspect dashboards/logs | Access-controlled encrypted/pointer retention as approved; sensitive fields redacted from ordinary logs. | Security/manual | Not started |
| CO-EVT-009 | Stripe `payout.*` record-only regression | Stripe platform payout event fixture | Event may be retained operationally but cannot resolve/settle/debit any customer cash-out. | Unit/integration | Not started |
| CO-EVT-010 | Unknown provider reference | Valid event with absent/ambiguous reference | No guessed linkage or journal; exception queue includes correlation/provider evidence. | Integration | Not started |

## G. Failures, returns, reversals, and customer support

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-FLR-001 | Definitive failure before funds move | Provider `failed` fixture | Order final failure; appropriate hold/payable release once; message says funds did not complete rather than inventing bank detail. | Adapter/integration | Not started |
| CO-FLR-002 | ACH/EFT return | Posted/settled fixture then provider return code/reason | Preserve native code/reason safely; apply provider-specific accounting/reconciliation; destination review policy evaluated. | Adapter/integration | Not started |
| CO-FLR-003 | Reversal vs return distinction | Fixtures distinguish originator correction/reversal from bank return | State/economic treatment follows approved provider semantics; one is not mislabeled as the other. | Adapter contract | Not started |
| CO-FLR-004 | Customer says funds not received | Provider success fixture with support case | Support workflow collects provider trace/reference, reconciles before adjustment; cannot force settle/credit without authorization trail. | Manual/runbook | Not started |
| CO-FLR-005 | Suspected account takeover/destination fraud | Recent destination change + risk alert fixture | Freeze/review policy, audit trail, notification/escalation behavior, no automatic payment to changed destination outside approved policy. | Integration/manual | Not started |
| CO-FLR-006 | Manual adjustment controls | Operations correction proposal | Maker/checker, reason/evidence, append-only journal, and customer communication; no direct balance edit. | Integration/manual | Not started |

## H. Reconciliation, reporting, and operations

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-REC-001 | Daily transfer reconciliation | Local attempts vs provider transfer/event report fixture | Exact one-to-one or explicit exception; amounts/currency/reference/date tolerances documented. | Integration/manual | Not started |
| CO-REC-002 | Provider cash/ledger reconciliation | Provider funding/ledger report vs GL fixture | Outstanding holds/payables and provider cash/clearing reconcile; unmatched row opens assigned break. | Integration/manual | Not started |
| CO-REC-003 | Aged unknowns | Advance clock over operational SLA | Alert/case assignment; order stays held until known; no silent release. | Integration | Not started |
| CO-REC-004 | Reconciliation idempotency | Rerun same report/import | No duplicate events, journal lines, or cases; resolution history remains auditable. | Integration | Not started |
| CO-REC-005 | Cutoff/timezone/holiday | Provider/local dates around DST, cutoff, weekend, holiday | Reporting uses stored instants and provider business-date policy; timing differences are explained, not lost. | Unit/integration | Not started |
| CO-REC-006 | Kill switch | Disable rail during queued/in-progress orders | Stops new create/submit according to policy; existing orders are reconciled and remain visible; no destructive rewrite. | Integration/runbook | Not started |
| CO-REC-007 | Access/audit review | Support/ops/admin role fixtures | Least privilege for destination data, release, reconciliation and adjustments; all privileged actions audited. | Security/integration | Not started |
| CO-REC-008 | Disaster recovery | Restore database/event cursor/job queue fixture | No duplicate submit after recovery; reconcile unknowns; restore runbook evidence captured. | Drill/manual | Not started |

## I. Security and privacy verification

| ID | Area / scenario | Setup / stimulus | Required assertions | Level | Status / evidence |
|---|---|---|---|---|---|
| CO-SEC-001 | Secrets scan | Repository, build logs, fixtures, docs | No real credentials, tokens, account numbers, or production webhook secrets. | CI/security | Not started |
| CO-SEC-002 | Encryption/access boundary | Attempt unprivileged database/log/API reads | Tokens/evidence protected; only service with need can decrypt/provider-call; access is audited. | Security/manual | Not started |
| CO-SEC-003 | Metadata/idempotency hygiene | Inspect requests, tracing, provider metadata | Opaque IDs only; no PII/full bank data/secrets in keys/metadata. | Unit/integration | Not started |
| CO-SEC-004 | Input/output hardening | Fuzz payloads, headers, query params, provider event shape | Schema validation, safe errors, no SQL/log injection, bounded payload handling. | Security/fuzz | Not started |
| CO-SEC-005 | Dependency/configuration | CI/SCA and deployment config review | Supported SDK/API versions, TLS/signature settings, feature gates default closed, production/live separation. | CI/manual | Not started |
| CO-SEC-006 | Retention/access deletion | Policy fixture and customer revoke request | UI revoke, legal/accounting retention, raw-event/evidence access and disposal follow approved data policy; proof logged. | Manual/integration | Not started |

## J. Release evidence checklist

A live release cannot be approved merely because rows above are green. Record links/approvals for:

- [ ] Provider/sponsor-bank written approval for the exact Manna flow, corridor, entity, recipient type, rails, limits, funding, and return handling.
- [ ] Legal/compliance/risk approval of disclosures, eligibility, KYC/sanctions/monitoring, privacy/retention, complaints/error handling, and all jurisdictional questions.
- [ ] Treasury/accounting approved flow of funds, prefunding/reserve policy, chart of accounts, reconciliation procedures, and adjustment authority.
- [ ] Security review of hosted collection, tokens, webhooks, access control, logging/redaction, threat model, and incident response.
- [ ] Provider adapter conformance suite, realistic sandbox evidence, load/fault tests, and independent reconciliation exercise.
- [ ] Operations runbook, on-call escalation, customer-support macros/training, maker/checker workflow, dashboards/alerts, and kill switch drill.
- [ ] Controlled-pilot success criteria, cohort/limits, monitoring cadence, rollback/hold strategy, and written go/no-go approval.

## Provider source references for test design

- [Stripe webhooks](https://docs.stripe.com/webhooks) — signatures, duplicates, retries, and out-of-order delivery.
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests) — request idempotency and pruning caveat.
- [Plaid webhooks](https://plaid.com/docs/api/webhooks/) — duplicate/out-of-order behavior, retry, and polling recovery.
- [Plaid Transfer event sync](https://plaid.com/docs/api/products/transfer/reading-transfers/) — event cursor and status/event semantics.
- [Plaid Transfer errors and returns](https://plaid.com/docs/transfer/troubleshooting/) — return, reversal, and recovery distinctions.
- [Stripe Canadian PAD](https://docs.stripe.com/payments/acss-debit) and [Stripe ACH Direct Debit](https://docs.stripe.com/payments/ach-direct-debit) — inbound delayed-failure context; these do not authorize an outbound customer cash-out rail.
