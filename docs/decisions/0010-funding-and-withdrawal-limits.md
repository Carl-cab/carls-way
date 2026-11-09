# 0010 — Funding and withdrawal exposure limits

- **Status:** **DECIDED 2026-11-09 — live funding and live withdrawals are DISABLED, effective permitted throughput ZERO. Not implemented; no limit is enforced anywhere in the tree, because no positive limit is approved to enforce.**
- **Date:** 2026-11-08, decided 2026-11-09
- **Required by:** `0009-transfer-rail-velocity-admission.md` (Accepted), which specifies separate funding and withdrawal budgets and deliberately proposes no numbers.

The owner's instruction was explicit: limits "must be proposed separately based on provider restrictions, fraud exposure, available safeguards, applicable compliance requirements, and operational recovery capability. Do not invent final production amounts."

So this record does two things and refuses a third. It sets out **what the providers already impose**, quoted and sourced. It **derives** what follows for Manna from those ceilings and from the rails' own return mechanics. It does **not** pick a fraud-loss tolerance, a treasury reserve or a compliance threshold, because those are not engineering facts and nothing in the tree determines them.

## 1. Provider-imposed ceilings — the hard outer bound

### Plaid Transfer (US rail, `PLAID_TRANSFER_LIVE`)

Quoted from Plaid's Transfer documentation:

> If your Implementation Checklist has not been approved, your transfer limits will be set at very low levels intended only to allow testing rather than true production usage (**maximum $100 per transfer, $500 per day, and $1,000 per month**).

> Any authorization you attempt to create over your limits will be automatically declined.

**This is Manna's current state.** The Transfer Implementation Checklist is not approved — enabling `PLAID_TRANSFER_LIVE` is itself still listed as blocked on "Plaid products updated to include Transfer". So **no Manna funding limit above $100 / $500 / $1,000 can take effect on the US rail today**: Plaid declines the authorization with `TRANSFER_LIMIT_REACHED` regardless of what Manna permits.

Two structural details matter beyond the numbers:

- Plaid's limits are **split by direction** — a Debit ceiling and a Credit ceiling, each with single-transfer, daily and monthly variants. That is independent confirmation that 0009's funding/withdrawal separation matches how the rail itself is governed; it is not a Manna invention.
- Plaid's windows are **calendar**: "Daily limits refresh every day and monthly limits refresh on the first day of the month at 12:00 AM EST".

### Stripe ACSS / PAD (CA rail, `CA_EFT_LIVE`)

Stripe publishes no fixed dollar ceiling for ACSS Debit comparable to Plaid's; limits are account-specific. What it does publish, and what dominates the risk model:

| Property | Value |
|---|---|
| Final confirmation | up to **5 business days** after submission |
| Dispute window, **personal** account | up to **90 calendar days** after the debit |
| Dispute window, **business** account | **10 business days** after the debit |
| Disputes per payment | once only |
| Dispute fee | CA$5.00, deducted from balance, not refunded on a win |

Stripe's own test fixtures include an account number whose scenario is "Fails the payment due to the payment amount causing the account to exceed its **weekly payment volume limit**" — so a per-account weekly volume ceiling exists at the rail and must be discovered per account rather than assumed.

## 2. The derivation that actually constrains the design

Manna's velocity windows are **hourly / daily / weekly**, anchored to the local hour, local midnight and local Sunday. Neither rail's windows match that.

**Finding 1 — a Manna ceiling must be tighter under *both* window definitions, or it is not a ceiling.** Manna's daily window is local-midnight-anchored; Plaid's is a calendar day refreshing at 12:00 AM EST; Stripe's relevant window is weekly per account. A Manna limit set *equal* to a provider limit will admit transfers the provider then declines, because the two windows do not cover the same set of transfers. Under 0009 that is worse than a poor UX: Manna would have **reserved** budget for a transfer the provider refused, and the reservation then has to be released — exercising the release path on every boundary mismatch rather than only on genuine failure.

**Finding 2 — the funding reservation horizon and the funding loss horizon differ by more than an order of magnitude.** This is the fact that forces 0011 to exist:

| Rail | Reservation horizon (submit → settled) | Loss horizon (returnable after settlement) | Ratio |
|---|---|---|---|
| US ACH, NSF (`R01`) | ~1–3 banking days | **2 banking days** | ~1× |
| US ACH, unauthorized consumer (`R05`/`R07`/`R10`/`R11`) | ~1–3 banking days | **60 calendar days** | ~20× |
| CA PAD, business account | up to 5 business days | **10 business days** | ~2× |
| CA PAD, personal account | up to 5 business days | **90 calendar days** | ~18× |

An in-flight reservation cannot be held for 60–90 days; that is not a policy choice, it is arithmetic about a control that is supposed to bound *concurrent* exposure. So the reservation must close at settlement, and something else must carry the remaining 55–85 days of return exposure. That something is 0011's realized-loss counter.

**Finding 3 — withdrawal exposure cannot be limited yet, because withdrawal is not built.** `cash_out` is blocked on separate grounds already recorded in `CLAUDE.md`: recipient-owned destination, disbursement accounting, ownership validation, provider capability and return/reversal architecture are all design-only, and the settlement executor explicitly skips `cash_out` balance updates. A withdrawal *limit* presupposes a withdrawal *path*. Proposing a number for one would imply a readiness that does not exist.

## 3. What is proposed

### Funding (`add_money`)

| Parameter | Proposed | Basis |
|---|---|---|
| Per-transfer ceiling, US | **≤ $100** | Plaid's unapproved-checklist ceiling. Not a Manna choice; anything higher is declined at the rail |
| Daily ceiling, US | **≤ $500** | as above |
| Monthly ceiling, US | **≤ $1,000** | as above |
| Per-transfer ceiling, CA | **≤ CA$100** | No published Stripe equivalent. Proposed by symmetry with the US rail so the two rails are not governed differently during beta, not from a Stripe source |
| Margin below provider ceilings | **Manna's limit strictly below the provider's**, not equal | Finding 1 — equal limits admit transfers the provider declines, and each such decline exercises the release path |
| Reservation window | **settlement**, not a fixed duration | Finding 2 |
| First live window | **US$1 / CA$1**, one rail at a time | Already the stated go-live condition in `CLAUDE.md`; a $1 transfer tests the rail without testing the limit |

### Withdrawal (`cash_out`)

| Parameter | Proposed |
|---|---|
| All ceilings | **0 — withdrawal remains disabled** |

Not a limit so much as a statement that the path does not exist. When cash-out is designed, its limits need their own record, because its abuse shape (account takeover draining to an external destination) is unrelated to funding's (return fraud).

### After Plaid's checklist is approved

The $100/$500/$1,000 figures stop being the binding constraint once Plaid raises Manna's limits, and at that point **these numbers must be re-derived rather than scaled**. The inputs then are the five the owner named, and three of them are not in this repository:

1. **Provider restrictions** — Plaid's approved Debit/Credit ceilings, Stripe's per-account weekly volume limit. Readable from the dashboards; not available to this session.
2. **Fraud exposure** — requires an observed return rate. Manna has processed zero live transfers, so there is no base rate. Nacha's enforcement thresholds (an unauthorized-return-rate ceiling computed over a 60-day window) are the external reference once volume exists.
3. **Available safeguards** — today: KYC-verified-only intent creation, velocity admission on the three P2P paths, balance-sufficiency on every debit. Not yet: any funding-specific control.
4. **Compliance requirements** — **open questions, not findings.** Manna is cross-border CA↔US, which raises whether FINTRAC's international electronic-funds-transfer reporting obligation and FinCEN's MSB funds-transfer recordkeeping rules apply, and at what thresholds, and whether Manna is a reporting entity at all. I am not able to determine any of that from the tree and have deliberately not written a number against it. It needs a compliance answer before a limit is set, because a limit above a reporting threshold creates an obligation rather than merely a risk.
5. **Operational recovery capability** — the honest input, and currently the weakest: there is no production cron verification, no dead-letter replay drill, no unknown-outcome reconciliation drill, and no named alert owner. A limit should not exceed what can be reconciled and recovered by hand, and today that is a small number because the recovery procedures are unexercised.

## 4. What this record does not do

It sets no final production amount. It does not approve enabling either rail. It does not assert any compliance obligation. The only numbers it states as binding are Plaid's own, quoted from Plaid.

## 5. Owner decision, 2026-11-09

**Live funding: DISABLED. Effective permitted throughput zero.**
**Live withdrawals: DISABLED. Effective permitted throughput zero.**

No positive live limit is approved at this stage. §3's table is therefore
**not** a set of approved ceilings; it is the provider-imposed outer bound that
any future proposal must sit strictly inside. Read every figure there as "the
most a provider would currently permit", never as "the amount Manna may move".

Four rules carried with the decision:

1. **Provider testing limits are not commercial approval.** Plaid's
   unapproved-checklist ceiling of $100/$500/$1,000 is what the rail will
   accept from an unapproved integration. It says nothing about whether Manna
   is approved to operate, and it must not be cited as though it did. The same
   applies to any Stripe sandbox figure.
2. **Prepare limits as configuration, not constants.** The future controlled
   pilot needs funding limits that are set and changed through an authorized,
   audited mechanism — so that the approved value is a deployment decision with
   a record, not a number compiled into a release. Zero is the current value,
   not the absence of a mechanism.
3. **Funding and withdrawal counters stay independent.** Not two readings of
   one counter, and not one counter with a sign convention. This is the same
   rule the release defect broke twice: a domain's exposure must be derivable
   without reference to another domain's volume.
4. **No live rail is activated by this decision**, and nothing in this record
   authorizes inferring otherwise.

### Still outstanding, and not resolved by the above

The compliance question in §3.4 — whether FINTRAC's international
electronic-funds-transfer reporting obligation and FinCEN's MSB funds-transfer
recordkeeping rules apply to Manna, and at what thresholds — **remains open and
is not answered here.** It is deliberately unaffected by setting the ceilings
to zero: a zero ceiling removes the exposure for now, but the question must be
answered before any positive limit is approved, because a limit above a
reporting threshold creates an obligation rather than merely a risk.

Likewise §3's requirement that limits be **re-derived rather than scaled** after
provider approval stands, and the five inputs it names — three of which are not
in this repository — are still the inputs.

## Decisions required from the owner — status

1. ~~Approve the funding ceilings, or supply different figures.~~
   **Answered: zero.** No positive live limit approved; prepare configurable
   limits for a future controlled pilot.
2. ~~Confirm withdrawal stays at zero.~~ **Confirmed.** Withdrawals remain
   disabled until separately implemented and authorized, with their own record.
3. **Still open** — the FINTRAC / FinCEN applicability question in §3.4. Needs
   a compliance answer or a routing decision before any positive limit.
4. ~~Confirm limits are re-derived, not scaled.~~ **Confirmed** by the decision
   that provider testing limits do not constitute commercial approval.
