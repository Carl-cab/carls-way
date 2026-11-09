# 0011 — Realized-loss accounting and repeated funding returns

- **Status:** **DECIDED 2026-11-09 — provisional rules for a future controlled pilot. NOT IMPLEMENTED, and not to be activated on a live rail without a separate launch authorization and policy review.**
- **Date:** 2026-11-08, decided 2026-11-09
- **Decided by the owner, as direction:** separate realized-loss accounting, rather than accepting repeated NSF returns as harmless. This record works that direction out; it does not revisit it.
- **Follows from:** `0009-transfer-rail-velocity-admission.md` (Accepted) §"In-flight exposure is not realized loss", and `0010-funding-and-withdrawal-limits.md` (Proposed) Finding 2.

## 1. Why one counter cannot do this

0009's funding budget bounds **unsettled in-flight value** and releases the claim when a transfer is `returned`. A return, though, is precisely the moment the loss becomes **realized**: if the credited balance was already spent through P2P before the NSF came back, releasing the claim restores the payer's funding headroom while the platform is still short the money. The control then admits the next deposit as though nothing had happened — each round bounded only by the per-deposit ceiling, never by the cumulative amount already lost.

So "release on return" is correct for an in-flight **reservation** and wrong for a realized **loss**. The same event closes one quantity and opens the other.

The rails force this apart; it is not a modelling preference. From 0010's Finding 2:

| Rail | Reservation horizon | Loss horizon |
|---|---|---|
| US ACH, unauthorized consumer debit | ~1–3 banking days | **60 calendar days** |
| CA PAD, personal account | up to 5 business days | **90 calendar days** |

A reservation held for 90 days is not bounding concurrent exposure — it is a different control wearing the same name. The reservation must close at settlement, which leaves 55–85 days of return exposure that something else has to carry.

## 2. Proposed structure

Two counters, one event.

**`funding_reservation`** — exists today in 0009's design. Created at confirm, keyed by transfer intent, finalized at verified settlement, **released** on failure or return. Bounds how much unsettled funding one account can have in flight. Releases are claim-bounded per `0009` and per the `reverseVelocity()` remediation.

**`funding_realized_loss`** — new, and the subject of this record. **Incremented** when a settled funding transfer is returned and the credited value is no longer recoverable from the account's own balance. Never decremented by the return lifecycle; decremented only by **recovery** (§4). Bounds cumulative unrecovered loss per account.

A `returned` webhook therefore does two things at once: it *releases* the reservation (the transfer is no longer in flight) and *increments* realized loss (the money is gone). Both in one transaction, both idempotent on the provider event id, so a redelivered webhook does neither twice.

**The amount is not simply the transfer amount.** The loss is what cannot be clawed back from the account at the moment of return:

```
realized_loss = max(0, returned_amount − recoverable_from_balance)
```

A user who funded $100, spent nothing, and whose transfer returns has cost the platform nothing — the debit reverses against their own balance and realized loss is zero. A user who funded $100, moved it all out by P2P, and whose transfer returns has cost $100. This is the quantity worth bounding, and it is also the quantity an attacker maximises.

**Partial recovery must be representable.** A user who spent $60 of a returned $100 leaves $40 recoverable and $60 realized. A boolean "returned" flag cannot express that, which is a second reason the counter is separate from the reservation.

## 3a. Owner decision, 2026-11-09 — the rules in force for the pilot

The owner supplied the rules rather than the money figures, and the shape they
chose does not need money figures: **the thresholds are zero-tolerance.** This
is what §3 below asked for and could not derive, answered in a way that sidesteps
the undefined base rate.

| Trigger | Action |
|---|---|
| **Any positive unrecovered funding loss** on an account | Suspend that account's funding; open a manual risk review |
| **Two returned funding transactions within the applicable risk window**, *even where immediate realized loss is zero* | Suspend that account's funding |
| **Any positive aggregate unrecovered loss** across the platform | Halt all further funding, pending authorized investigation |

Four rules carried with them:

1. **All thresholds are per currency, with no hidden CAD/USD conversions.** A
   CAD loss and a USD loss are separate obligations against separate balances.
   No comparison may route through an FX rate.
2. **No automatic collections and no automatic write-offs are authorized.**
   §4's step 4 is therefore "none" for the pilot, and step 6 stays a manual,
   audited action. A counter that nothing collects against is the intended
   state, not an omission.
3. **Configurable and auditable**, with **simulated** tests. Not compiled
   constants, and not exercised against a live rail.
4. **Not active without separate authorization.** This record being decided is
   not a launch approval, and `0010` holds live funding at zero regardless.

**What the zero-tolerance shape means in practice, stated because it is easy to
miss.** Since any positive unrecovered loss suspends funding and any positive
aggregate loss halts the platform's funding rail, the first unrecovered dollar
is a stopping event. That is a deliberate choice for a pilot with no observed
return rate — it trades availability for bounded exposure, and it means the
pilot's expected mode of failure is a halt, not a loss. It should be
re-derived, not relaxed by habit, once a base rate exists.

**Escalation owner:** the **project owner, acting as interim Risk Operations
Lead**, until a responsible role is formally assigned. That closes the Tier 4
naming gap in §3 below, and it is explicitly interim — the same unowned-alert
weakness recorded against rate-limit degradation applies until the role is
assigned for real.

The analysis that produced the question follows. Its tier table is superseded
by the three rules above; it is kept because §3's two findings — that a count
trigger needs no money figure, and that per-account limits cannot bound
platform loss — are the reasons the owner's rules take the shape they do.

## 3. Proposed threshold and escalation — superseded by §3a

The owner's instruction was "Do not invent a financial loss threshold." I have not, and I want to be plain about why I cannot derive one: a loss threshold is a statement of risk appetite measured against capital, and **nothing in this repository carries either quantity**. There is no treasury balance, no reserve figure, no observed return rate — Manna has processed zero live transfers, so the base rate is undefined rather than small.

What I can propose is the **shape**, with the numbers named as owner inputs:

| Tier | Trigger | Proposed action |
|---|---|---|
| 1 — Observe | first realized loss on an account, any amount | Record. Flag the account for review. No restriction |
| 2 — Restrict funding | realized loss on an account exceeds **`FUNDING_LOSS_REVIEW`** *(owner input)*, or **2 returns within one loss horizon** | Suspend new funding for that account; existing balance unaffected; P2P unaffected |
| 3 — Suspend account funding | realized loss exceeds **`FUNDING_LOSS_SUSPEND`** *(owner input)* | Funding disabled pending manual review; recovery process opens |
| 4 — Platform circuit breaker | aggregate realized loss across all accounts within a rolling window exceeds **`PLATFORM_LOSS_HALT`** *(owner input)* | Halt the funding rail entirely, all accounts, alert the named owner |

Two things about this shape that are findings rather than preferences:

- **Tier 2's count trigger needs no money figure and should be adopted regardless.** "Two returns inside one return horizon" is the pattern that distinguishes a bank error from a probe, and it is expressible without knowing risk appetite. It is the cheapest useful control here.
- **Tier 4 exists because per-account limits do not bound platform loss.** An attacker with many accounts defeats every per-account tier; only an aggregate breaker bounds the total. This is the same lesson as the velocity TOCTOU in a different place — a ceiling that binds a request does not bind an account, and a ceiling that binds an account does not bind a platform.

Thresholds must be denominated **per currency**, not converted. A CAD loss and a USD loss are different obligations against different balances, and FX-converting them to compare against one number would understate or overstate depending on the rate on the day.

## 4. Proposed recovery policy — for review

| Step | Action |
|---|---|
| 1 | Recover from the account's own balance first, to the extent available, at the moment of return |
| 2 | Record the unrecovered remainder as realized loss against the account and the platform |
| 3 | Restrict per §3 |
| 4 | Attempt recovery by the approved collections route *(owner input: what route exists, if any)* |
| 5 | On recovery, **decrement** realized loss by the amount recovered and record the adjustment — never by editing the original entry |
| 6 | Write off only by an explicit, audited, two-person action *(owner input: who)* |

Step 5 is the only decrement path. The return lifecycle must never reduce realized loss, or the counter becomes the reservation again.

## 5. Audit requirements, carried from the repo's own history

`audit_logs` here is append-only **by convention only** — no trigger, no RLS, no `REVOKE`, and the application's single DB role can `UPDATE` and `DELETE` audit rows (see `0004`). So a realized-loss ledger stored under the same role carries the same weakness, and this record must not claim tamper resistance it does not have.

Minimum requirements:

- Every increment and decrement is a **row**, not a mutation of a running total, so the history reconstructs.
- Each row names the provider event that caused it, so a redelivered webhook is recognisable rather than merely idempotent-by-accident.
- Reconciliation can answer: for every returned funding transfer, is there exactly one realized-loss row, and does its amount equal `max(0, returned − recoverable)` as computed at that time?
- A loss row is never deleted. Corrections are compensating rows, matching how `velocity_checks` reversals already work.

## 6. Acceptance criteria, when implemented

1. A returned funding transfer with the balance intact records **zero** realized loss and releases the reservation.
2. A returned funding transfer whose credit was fully spent records the **full** amount and releases the reservation.
3. Partial spend records exactly the unrecovered part.
4. A redelivered `returned` webhook changes neither counter a second time.
5. Releasing a reservation never decrements realized loss.
6. Repeated returns accumulate; the counter does not reset with the window, unlike `velocity_checks`.
7. Recovery decrements by a compensating row and leaves the original readable.
8. Thresholds evaluated per currency, with no FX conversion.
9. Asserted against real PostgreSQL with concurrent and out-of-order webhook delivery, as `0008`'s tests are — a returned webhook arriving **before** the settled webhook must not produce a negative or double-counted loss.

## Decisions required from the owner — all answered 2026-11-09

1. ~~Approve the two-counter structure and the one-event-does-both rule.~~
   **Approved** in substance: separate realized-loss accounting, with release
   closing the reservation and the same event opening the loss.
2. ~~Supply the three thresholds per currency.~~ **Answered, and they are
   zero-tolerance** — see §3a. Any positive unrecovered account loss suspends
   that account's funding; two returns inside the risk window suspend it even
   at zero realized loss; any positive aggregate unrecovered loss halts
   platform funding. Per currency, no conversions.
3. ~~Name the escalation owner.~~ **The project owner, acting as interim Risk
   Operations Lead**, until a responsible role is formally assigned.
   Interim by the owner's own wording.
4. ~~State what collections route exists.~~ **None, and none authorized.** No
   automatic collections and no automatic write-offs. §4 step 4 is "none" for
   the pilot and step 6 remains a manual audited action.
5. ~~Confirm nothing here is readiness to enable a rail.~~ **Confirmed.** This
   record is decided and unimplemented; `0010` holds live funding and
   withdrawals at zero; activation needs a separate launch authorization and
   policy review.

### Added by the decision, and still open

The acceptance criteria in §6 are unchanged and unimplemented. Two further
requirements come from the decision itself: the controls must be
**configurable and auditable** rather than compiled constants, and they must be
exercised by **simulated** tests — never against a live rail.
