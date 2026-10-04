# Staff-Only Real-Rail Test Matrix and Execution Runbook

**Classification:** Staff-only — financial operations and engineering

**Status:** Planning artifact only. **This document authorizes no transfer and this change made no provider call.** Do not enable `PLAID_TRANSFER_LIVE` or `CA_EFT_LIVE` while following this document unless the explicit approval gate below has been completed by the accountable staff.

**Scope:** Controlled, funded live-rail validation for US ACH add-money through Plaid Transfer and Canadian ACSS/PAD add-money through Stripe, after the production settlement design is operational. The current repository's `GO_LIVE_RUNBOOK.md` remains the program-level prerequisite authority. This runbook adds the evidence standard, capped execution controls, and failure handling for individual real-rail tests.

> **Cash-out is blocked.** Do not test, enable, or represent cash-out as real-rail ready. The current Canadian payout path is documented in code as paying the platform external account rather than a customer recipient; the recipient-account/FBO design, funding authorization, and end-to-end settlement design must be implemented and independently approved before a cash-out test plan can be created.

---

## 1. Non-negotiable guardrails

1. **Staff only; no customer money.** Use company-owned, KYC-cleared test identities and company-controlled source accounts that are allowed by the provider, sponsor bank, and compliance program. Do not use a personal, employee, or customer account unless Legal/Compliance has approved that exact use in writing.
2. **No direct database edits.** Use approved application, provider dashboard, and reconciliation procedures only. Ledger corrections are reversal entries, never mutations or deletions.
3. **One rail, one scenario, one live transfer at a time.** No concurrent test submissions; do not reuse an in-flight intent or idempotency key for another scenario.
4. **No pre-credit.** A `ready`, `submitting`, `processing`, `submitted`, `authorized`, or `posted` intent is **not** evidence of settled funds. Wallet credit/debit and settlement ledger entries occur only at settled/returned processing per the settlement pipeline.
5. **Capture opaque IDs, not secrets.** Record transfer-intent ID, correlation ID, provider authorization/reference/event IDs, masked bank account, timestamps, amounts, and response/status. Never record access tokens, webhook signing secrets, API keys, Redis URLs, or raw PII in the test packet.
6. **No flag change by the test operator alone.** Live flags are account-owner/deployment changes; this branch does not change them. The deployment owner must use the production change process and record an audit/change ticket.

---

## 2. Explicit approval gate — every box must be checked before a real call

A test coordinator opens a change/incident record and attaches evidence for all of the following. The **Approver** and **Executor** must be different people.

| Gate | Required evidence / named owner | Stop condition |
|---|---|---|
| Legal and compliance | Compliance owner confirms required licenses/sponsor-bank program, AML/KYC/sanctions procedure, PAD/ACH consent, records retention, and approved test identity/account | Any legal, KYC, sanctions, consent, or provider-program condition incomplete |
| Funding and settlement | Finance owner confirms funded FBO/omnibus model, sufficient cleared funds, reconciliation ownership, and a reserve for return/NSF exposure | Any balance remains seed/sandbox money or the funds cannot be reconciled to a real safeguarded account |
| Production readiness | Engineering owner verifies the execute endpoint exists, is idempotent, live webhooks authenticate and settle, schema/migrations are current, monitoring/DLQ/recovery work, and the Redis rate-limit verification is healthy | Missing execute path, unverified webhook settlement, failed integrity check, unresolved P0/P1, or rate-limit backend unexpectedly falls back without risk sign-off |
| Provider readiness | Provider owner confirms live product approval, webhook endpoint/subscriptions, test-account permission, applicable ACH/ACSS capability, and support escalation path | Provider mode, capability, recipient, event subscription, or support coverage unknown |
| Deployment approval | Accountable production owner records release SHA, change ticket, time window, rollback owner, and the exact single rail to be enabled; both flags remain off until this gate is signed | No dual approval, wrong SHA, missing rollback owner, or scope expands beyond one approved rail |
| Financial cap | Finance and Compliance approve the per-transfer and session caps below, record starting FBO/bank balances, and pre-authorize no more than the cap | Requested amount or aggregate exceeds cap |
| Two-person release | Written approvals from **Engineering release owner**, **Finance/Compliance owner**, and **accountable production owner**; executor and independent observer acknowledge the hold criteria | Any approver unavailable, approval older than one business day, or any gate changes after approval |

### Funding cap and cadence

- **Per-transfer cap:** **US$1.00** for US ACH tests; **CA$1.00** for Canadian ACSS/PAD tests (or the provider's documented live minimum, approved in writing before execution).
- **Per-rail session cap:** **US$5.00 / CA$5.00 gross submitted**, inclusive of retries that are a new provider movement. A provider idempotent replay returning the same provider reference does not consume an additional cap, but must be evidenced before it is treated that way.
- **Maximum live movements:** five per rail per approved window, one outstanding at a time. Use simulated/provider test mechanisms for destructive or exotic cases when they exist; do not force an NSF, duplicate, or return against a real bank merely to complete a checklist.
- **Cap breach:** set the rail hold immediately, do not submit more transfers, notify Finance/Compliance, reconcile known exposure, and require a new written approval.

---

## 3. Roles, artifacts, and evidence packet

| Role | Required responsibility |
|---|---|
| Accountable production owner | Approves flag changes, release SHA, production window, and rollback execution |
| Engineering release owner | Verifies code path, deployment, logs/correlation tracing, webhook/DLQ/recovery behavior, and performs technical rollback |
| Finance/Compliance owner | Approves identity/account and caps, verifies funding and bank/FBO evidence, owns return/NSF disposition |
| Test executor | Performs only the approved action; stops on a hold criterion; records events contemporaneously |
| Independent observer/reconciler | Watches the provider/bank result independently, compares ledger/wallet evidence, signs close-out |

Create one evidence packet per test ID. Its header includes: change ticket; test ID; date/time and timezone; rail; release SHA; executor/observer/approvers; user ID; **masked** bank account; intent ID; correlation ID; amount/currency; starting wallet and FBO/bank balances; and cap remaining. Preserve immutable audit-event references and provider dashboard exports/screenshots according to retention policy.

### Required evidence vocabulary

| System | Record for every applicable test |
|---|---|
| Transfer intent | Intent ID; type; amount/currency; execution mode/rail; status timeline; idempotency key fingerprint (not secret); consent timestamp; provider authorization/reference ID; failure reason; correlation ID |
| Ledger | Immutable entry IDs, type (`transfer_settlement` or `transfer_reversal` when applicable), debit/credit, currency, amount, intent/reference linkage, and proof that no duplicate entry was created |
| Wallet | Pre/post balance, amount applied, currency, and proof it changed only on the documented terminal settlement/reversal event |
| Provider | Authorization decision, transfer/payout/reference ID, event ID/type/status/timestamp, idempotency/replay result, dashboard evidence, and support case if opened |
| Bank / FBO | Masked source/destination account, statement/transaction reference, date/time, amount, posting/return status, and FBO/reconciliation line; never attach full account or routing numbers to the general packet |

---

## 4. Pre-flight and controlled execution sequence

1. Confirm the approval gate and caps; attach approvals to the evidence packet. Confirm both live flags are still **off** before the approved production change.
2. Confirm release SHA, migration/schema state, staff access, monitoring, webhook signing health, DLQ visibility, recovery-flag view, and on-call/provider escalation contacts.
3. As an authorized `OperationsAdmin` or `SuperAdmin`, run `POST /api/admin/operations/redis-rate-limit`. Record only its non-secret result (`configured`, `reachable`, `activeBackend`, `verification`, `cleanup`) and audit ID. It must not be invoked anonymously. A failed/unexpected in-memory fallback requires Engineering risk sign-off or a hold before public/auth exposure is increased.
4. Record starting wallet, relevant ledger total, FBO position, provider dashboard baseline, and bank account baseline. Reconfirm no unrelated pending test transfer exists.
5. Enable **only the approved rail** through the approved deployment process. Do not enable both `PLAID_TRANSFER_LIVE` and `CA_EFT_LIVE` in a single test window. Capture the change timestamp and deployment identifier; do not place secrets in the packet.
6. Create one capped, uniquely correlated transfer intent; review consent language; confirm it. Capture `draft → ready`. Do not call any unapproved endpoint or alter a provider payload manually.
7. Submit exactly the approved scenario. Capture the provider response/event sequence, intent state transitions, and webhook records. For an unknown outcome, **do not resubmit as a new transfer**; use the documented idempotent recovery/manual-review path.
8. Wait for the provider/bank finality window. Reconcile the intent, immutable ledger, wallet, provider reference/events, and FBO/bank evidence. The observer signs the packet only when every expected item matches.
9. Disable the approved rail immediately after the case(s), even on success, unless a separate written continuation approval exists. Keep the other rail disabled. Reconcile all in-flight references before closing the change.

---

## 5. Hold, rollback, and escalation criteria

### Immediate hold — do not submit another transfer

Place the rail on hold for any of these conditions:

- transfer intent, provider, webhook, ledger, wallet, or bank/FBO amount/currency/reference does not reconcile exactly;
- duplicate provider reference, duplicate settlement/reversal ledger entry, duplicate wallet movement, or a second bank movement is observed or cannot be ruled out;
- timeout/unknown outcome after provider submission, webhook signature failure/missing expected event, out-of-order event that changes state unexpectedly, or any DLQ item for the tested transfer;
- unexpected in-memory rate-limit fallback, production configuration discrepancy, loss of audit/log correlation, provider capability/recipient mismatch, or missing consent;
- cap breach, unapproved participant/account, provider rejection with unexplained cause, return/NSF, suspected fraud/compliance issue, or any customer-impacting effect;
- inability to identify a single accountable engineer and Finance/Compliance owner during the window.

### Rollback / containment sequence

1. **Stop submissions first.** Do not retry by making a new intent.
2. Production owner sets the active rail's live flag to `false` through the approved deployment process and records timestamp/SHA. Set both flags false if scope or blast radius is unclear. This stops new live selection; it does **not** reverse provider-accepted/in-flight transfers.
3. Engineering preserves correlations, provider event IDs, logs, webhook records, DLQ/recovery flags, and audit records; do not delete or edit financial records.
4. Finance/Compliance freezes further test use of affected funds/accounts, identifies all `submitting`/`processing`/`posted` references, and reconciles provider and bank/FBO positions.
5. For a Plaid `submitting` intent with a persisted authorization and no reference, use the approved idempotent reconciliation path only after two-person review; never create a fresh transfer. `submitted`/`posted` uncertainty requires manual review, not automated resend.
6. Open an incident/support case as warranted. Resume only on new written approval after the root cause, financial exposure, and reconciliation are documented.

---

## 6. Detailed controlled real-rail test matrix

**Legend:** `✓` means evidence must be present; `—` means no movement is expected. The matrix specifies expected outcomes, not permission to force a real-world failure. Complete a row only when its scenario is approved and safe to exercise.

| ID | Scenario / safe method | Expected transfer-intent evidence | Expected ledger and wallet evidence | Expected provider evidence | Expected bank / FBO evidence | Pass / hold rule |
|---|---|---|---|---|---|---|
| RR-01 | **Success — US ACH add-money**. One US$1 approved Plaid live add-money using company test account. | `draft → ready → submitting → processing` then valid webhook sequence to `settled`; provider authorization and transfer reference persisted; single correlation/idempotency identity. | One immutable `transfer_settlement` entry for US$1; wallet increases exactly US$1 only at settled; no reversal/duplicate entry. | Authorization approved; one transfer ID; authentic `TRANSFER.STATUS_UPDATE` event(s) ending `settled`; event ID recorded. | Source bank debit and FBO credit/settlement evidence equal US$1; timing/references reconcile. | Pass only if all five sources match exactly. Hold for any pre-credit, missing reference, duplicate, or variance. |
| RR-02 | **Success — CA ACSS/PAD add-money**. One CA$1 approved Canadian live add-money using company test account and approved mandate. | `draft → ready → submitting → processing` then authenticated Stripe financial event to `settled`; consent timestamp and one provider reference. | One immutable CA$1 `transfer_settlement` entry; wallet increases exactly CA$1 only at settled. | One relevant PaymentIntent settlement event/ID recorded and processed once; record-only duplicate Stripe financial events do not settle twice. | PAD debit and FBO/settlement evidence equal CA$1 after ACSS timing; mandate/account masked evidence retained. | Pass only on exact reconciliation and one wallet/ledger application. Hold for missing mandate, mismatched event, or duplicate movement. |
| RR-03 | **Provider rejection**. Prefer provider-supported live test instrument/simulation; do not intentionally cause a real insufficient-funds event without written Finance/Compliance approval. | Plaid authorization decline/definite rejection results in `failed` with non-secret failure reason; no provider transfer reference if none exists. If Stripe rejects, status/failure follows authenticated terminal event/state machine. | No settlement ledger entry and no wallet movement. | Provider rejection code/status and event/attempt ID captured; no successful transfer reference. | No bank/FBO movement; confirm absence after provider/bank visibility window. | Pass if failed/rejected is durable and no money moved. Hold if a reference, ledger, wallet, or bank movement appears. |
| RR-04 | **Timeout / unknown outcome**. Use a controlled network/provider fault injection or an approved provider-side delayed response; never simulate by bypassing persistence. | Intent remains `submitting` if outcome unknown; durable authorization (if obtained) retained; not falsely marked `failed`; recovery flag/age recorded if applicable. | No settlement ledger or wallet movement before final provider outcome. | Correlate request/authorization; record whether transfer reference was returned. Do not issue a new transfer. | No assumed result; bank/FBO checked when applicable. | Pass if no unsafe retry/pre-credit occurs and recovery can determine one outcome. Hold until provider/reference reconciliation is complete. |
| RR-05 | **Provider duplicate / idempotent retry**. Re-run only the approved recovery/replay using the same persisted authorization/idempotency identity after a controlled lost-response case. | Same intent retains one provider reference; status becomes/keeps `processing`; no second intent or changed logical identity. | Before settlement: no movement. At terminal settlement: exactly one ledger entry and one wallet update. | Same provider transfer/reference returned on replay; provider shows one movement, not two. | One bank/FBO movement only. | Pass only if provider reference and all financial effects are singular. Immediate hold/rollback on any second movement. |
| RR-06 | **Webhook reorder**. Use provider-supported event replay/test tooling if available or non-financial controlled delivery; do not forge signatures or manually mutate production state. Deliver valid later/earlier statuses in a permitted non-monotonic order. | State machine accepts only valid progression; duplicate/invalid transition is recorded/rejected/idempotent and does not regress a terminal state. | Ledger/wallet effects occur once only for valid settled/returned terminal transition; no effect from an invalid/reordered duplicate. | Authentic event IDs/timestamps prove delivery order versus provider event time. | Bank/FBO result remains one movement consistent with final provider status. | Pass if terminal state and financial effects are idempotent. Hold if status regresses or money applies twice. |
| RR-07 | **Metadata-before-reference webhook**. Use approved provider test delivery where metadata/event arrives before the local provider reference is visible; do not manufacture a webhook. | Initial event may create a manual-review/not-found condition; once reference persists, correct valid event/replay maps to the original intent without creating another. | No ledger/wallet movement while reference cannot map; after safe matching, one terminal effect at most. | Original event ID, metadata/correlation, provider reference, and later matching/replay evidence all retained. | No bank/FBO conclusion until reference mapping is resolved. | Pass if the uncorrelated event is safely contained and reconciliation closes with one intent. Hold/manual review for any unmatched financial event. |
| RR-08 | **Return / NSF after prior success**. Prefer approved provider simulation. Do not deliberately overdraft an account. | Prior settled intent receives authenticated `returned`; return reason/event and manual-review requirement captured. | One immutable `transfer_reversal` entry as planned; wallet reversal matches original effect exactly; no deletion/edit of original settlement entry. | Return/NSF event/reference/reason and provider case retained. | Bank/FBO return/chargeback/NSF evidence, amount, fees (if any), and date reconcile; Finance owns exposure. | Pass only if reversal is single, exact, and reconciled. Mandatory hold and Finance/Compliance review before any further tests. |
| RR-09 | **Manual reconciliation**. Select an approved stale/unknown `submitting`, `submitted`, or `posted` test intent; no new submission. | Recovery flag/status/timestamps preserved; `submitting` can be reconciled only using persisted authorization; `submitted`/`posted` are manual review, not automatic resend. | Ledger/wallet must match proven provider/bank finality; no adjustment without approved immutable corrective entry. | Provider dashboard/support response identifies final state/reference; all queries correlated. | FBO/bank statement confirms one of settled/failed/returned/no movement. | Pass when a named reconciler documents final outcome with independent evidence. Hold for unresolved/ambiguous provider or bank result. |
| RR-10 | **DLQ replay**. Use a real authenticated event only after it has safely reached DLQ through an approved controlled failure, or validate in non-production first. Requeue once with two-person review. | Intent state after replay is valid/idempotent; webhook record retry count resets and requeue audit shows operator/time; no state regression. | Any required settlement/reversal occurs exactly once; duplicate delivery/replay adds no second entry or wallet change. | Original provider event ID retained; DLQ record has failure history, requeue timestamp, and replay outcome. | Bank/FBO shows no extra movement due to replay. | Pass if replay completes/records once. Hold if replay changes terminal financial result twice or DLQ is not auditable. |
| RR-11 | **Cash-out** — **BLOCKED; do not execute**. | No live cash-out intent should be submitted under this runbook. | No test ledger or wallet debit. | No Payout/recipient action. | No outgoing bank/FBO payment. | Remains blocked until recipient/FBO design, safe recipient binding, funding authorization, settlement/reversal behavior, provider capability, and an independently approved cash-out matrix are implemented. |

### Scenario-specific execution cautions

- **Do not turn RR-03 or RR-08 into a real NSF experiment.** The safer path is an approved provider test facility or sandbox proof; a live destructive test requires separate written approval, a known financial exposure owner, and a legal/compliance review.
- **Do not fake webhooks.** A manually crafted request does not verify the production provider signature or delivery path. Use provider-controlled test/replay capability or retain the scenario as non-production evidence until such capability is approved.
- **Do not treat a HTTP timeout as a provider rejection.** Unknown means the provider may have accepted the movement. Preserve authorization/reference clues, reconcile, and use the stable idempotent replay only where the implementation explicitly supports it.

---

## 7. Close-out checklist

The independent observer may sign close-out only after all applicable boxes are complete:

- [ ] Test stayed within per-transfer and aggregate cap; starting/ending cap balance recorded.
- [ ] Both systems have one matching logical transfer identity and provider reference where applicable.
- [ ] Transfer-intent timeline, webhook/provider-event records, ledger, wallet, provider dashboard, and bank/FBO evidence agree on amount, currency, direction, and final state.
- [ ] No unauthorized data/secret was recorded; PII and account numbers remain masked per policy.
- [ ] All DLQ items/recovery flags for the test are either closed with evidence or explicitly escalated; none is silently dismissed.
- [ ] Live flag rollback/disable timestamp is recorded; no new live intent remains unaccounted for.
- [ ] Finance/Compliance and Engineering sign the reconciliation result; any variance has an incident ID and rail remains held.

**No actual real-rail test is performed by this repository change.**
