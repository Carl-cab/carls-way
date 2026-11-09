# 0009 — Transfer-rail velocity admission

- **Status:** **Proposed — awaiting owner approval. Not implemented.**
- **Date:** 2026-11-08
- **Relates to:** `0008-atomic-velocity-admission.md` (which closed the same
  class of defect on the three P2P paths and deliberately left this rail out),
  `0007-money-bucket-policy-on-redis-loss.md`.

This record proposes an architecture and acceptance criteria. It changes no
code and sets no limits. The numbers a funding or withdrawal ceiling should
carry are a business decision, not an engineering one, and are deliberately
left blank.

## Where money actually moves on this rail

Traced against the tree, not from memory:

| Step | Route / module | Does a balance move? |
|---|---|---|
| Intent creation | `POST /api/transfers/intent` | **No.** Writes `transfer_intents` at `status='draft'`. Requires `kyc_status='verified'` and a linked bank account. Runs a velocity **preview** that consumes nothing |
| Review | `GET /api/transfers/[id]/review` | No. Read-only, returns region-appropriate consent language |
| Confirm | `POST /api/transfers/[id]/confirm` | **Sandbox: yes.** `confirmTransfer()` → `settleSandboxTransfer()` locks the intent, updates `balance_cad`/`balance_usd`, writes a ledger entry, sets `status='settled'`, all in one transaction. **Live: no** — it records consent and moves the intent toward `ready` |
| Execute | `POST /api/transfers/[id]/execute` | **No**, directly. Live only. Claims a `ready` intent → `submitting`, calls the provider, which records `processing`. The money moves **at the provider**, outside this system |
| Provider settlement | webhook → `SettlementOrchestrator` → `SettlementExecutor` | **Yes, for `add_money`.** The executor's balance update credits the wallet on `settled` and debits it on `returned`. `cash_out` balance updates are explicitly skipped |
| Failure / return | same chain | Balance reversed for `add_money`; `reverseVelocity()` called when `nextStatus === 'returned'` |
| Reconciliation | `POST /api/admin/transfers/[id]/reconcile` | Replays the provider authorization; where none was persisted, returns the intent to `ready` |

Two consequences follow directly and shape everything below.

**There is no velocity claim anywhere on this rail.** The intent route's
preview grants nothing, and no confirm, execute or settlement path writes
`velocity_checks`. Sandbox confirm moves a real platform balance with no
durable volume control at all — the same gap `money:split-pay` had until
2026-10-26, on a different rail.

**On the live rail, settlement is too late to refuse.** By the time a
settlement webhook arrives, the provider has already moved the money at the
bank. An admission control that first speaks at settlement cannot say no; it
can only record. That is the decisive fact for option B below.

## A defect this review found, which is a prerequisite

`SettlementExecutor` calls `reverseVelocity()` on a `returned` transfer. The
rail never consumed any budget, and `reverseVelocity()` releases
`min(amount, current window total)` — where the window total is the user's
volume from **every** path. So a returned transfer releases budget that
`money:send` and `money:split-pay` genuinely consumed.

That is free headroom with an obvious shape to abuse: fund by `add_money`,
spend the proceeds through P2P, let the funding transfer return NSF, and
recover outbound budget that was actually spent. It is **latent today** — a
`returned` status requires a provider webhook, and both live flags are off, so
no reachable path produces it — but it must be fixed before any rail is
enabled, and it is not fixed by choosing any of the three options on its own.
Whatever is adopted, a release must be bounded by **the claim being released**,
identified by intent, and never by a window total.

## Funding and withdrawal are not the same risk

The directive is right not to assume one policy. Velocity limits on this
codebase exist to bound how much value an account can move outward. The two
transfer directions sit on opposite sides of that:

- **`cash_out` (withdrawal)** is outbound. Its abuse case is an attacker with a
  compromised account draining it to an external destination, and it is the
  direction where a ceiling does the work velocity was designed for. It is also
  **blocked** today on separate grounds — recipient-owned destination,
  disbursement accounting, ownership validation and return architecture are all
  design-only.
- **`add_money` (funding)** is inbound. A funding ceiling does not protect
  against outbound drain; it protects against **return fraud** — deposit, spend
  the credited balance, then let the ACH/EFT debit return NSF, leaving the
  platform short. The exposure is not the amount moved but the amount
  *credited and spendable while still returnable*, over a settlement-plus-return
  window measured in days, not hours.

So the quantity to bound on funding is unsettled in-flight value, and the
natural window is the provider's return window — neither of which the current
hourly/daily/weekly ceilings express. Reusing the outbound budget for funding
would both mis-measure the risk and let funding volume refuse legitimate P2P
sends.

## Options assessed

### A. Reserve at confirmation, finalize at settlement

Claim budget when the user confirms consent; finalize it when the transfer
settles; release it on failure, cancellation or return.

- **Idempotency:** sound if the claim is keyed on the intent id — one intent,
  at most one claim, so webhook redelivery finalizes a claim already final and
  is a no-op. Needs a state column (`reserved` / `finalized` / `released`), not
  a bare amount, or a release cannot tell "not yet claimed" from "already
  released".
- **Concurrency:** the same write-then-verify shape as 0008 works, because
  confirm is a local operation with no external call in it.
- **Retries / provider timeouts / unknown outcomes:** the reservation **stays
  held** — correct, and the cost is that a user with a stranded `submitting`
  intent is held out of that budget until an operator reconciles. Acceptable
  for money, but it makes reservation expiry and the reconcile path part of the
  control rather than adjacent to it.
- **Abuse:** bounds in-flight exposure, which is the interval that matters.
- **Gap:** one budget for both directions, so it mis-measures funding (above).

### B. Admit at the first actual balance movement

- **Sandbox:** works, and is the minimal correct change there — confirm both
  decides and moves, in one transaction, so 0008's exact pattern applies.
- **Live: does not work as an admission control.** The first balance movement
  is the settlement executor, after the provider has moved the money. A refusal
  there would have to reject a settlement that already happened, which is
  incoherent; in practice it degrades to "record, never refuse".
- **Abuse:** leaves the submit-to-settle interval — days on ACH — entirely
  unbounded. A user could push an arbitrary number of concurrent live
  transfers, and the budget would only be consumed as they land.
- **Idempotency:** the best of the three, since the executor's balance update
  is already idempotent per intent and provider event.

B is therefore viable **only** as a sandbox-beta stopgap, and must not be
described as closing the rail's gap.

### C. Distinct funding and withdrawal limits, with reserve / finalize / release

A's lifecycle, with separate budgets per direction and funding measured as
unsettled in-flight value over the return window.

- Everything said for A, plus: the P2P outbound budget stops being
  contaminated by funding volume, and a funding return releases only funding
  budget — which is also what makes the `reverseVelocity()` leak structurally
  impossible rather than merely patched.
- **Cost:** the most work, and it needs limit numbers that only the owner can
  set. It also needs a claim record of its own; reusing `velocity_checks` rows
  would be a mistake, because that table is a rolling aggregate with no notion
  of a claim that can be released by identity.

## Recommendation

**Adopt C, built in A's shape.** One mechanism — reserve at confirm, finalize
at settlement, release on failure/return, keyed on the intent — with **two
separate budgets**, funding and withdrawal, and funding measured as unsettled
in-flight value rather than completed volume.

**Sequencing, so the sandbox beta is not blocked on it:**

1. **Prerequisite, independent of the choice:** bound `reverseVelocity()`'s
   release by the claim being released rather than by the window total. Until
   then no rail may be enabled.
2. **Sandbox now, under option B:** admit at `settleSandboxTransfer()`, inside
   the transaction that already locks the intent and moves the balance, with
   `admitVelocity()` exactly as the P2P paths use it. Small, consistent with
   0008, and it removes "a balance-moving path with no volume control" from the
   sandbox beta. Explicitly labelled a stopgap that does not generalise.
3. **C before any live rail**, as a separate authorized change with its
   numbers agreed first.

**One constraint that changes the guarantee, and must be said plainly.** The
directive forbids holding a database transaction open across a provider call,
rightly. On a rail with an external leg that makes "the claim commits with the
money" *impossible* — the money moves at the bank, not in this database. The
reserve commits before the provider call; the provider call runs in no
transaction; finalize or release commits after. So the live rail's invariant is
weaker than the P2P paths' by necessity:

> reserved before the external call, reconciled after — never atomic with the
> money.

Reconciliation is therefore not a safety net bolted on beside this control; it
is **part of** it. A reservation whose outcome is unknown is the normal case,
not the exception, and the control is only as good as the path that resolves
one.

## Acceptance criteria for C

Functional:

1. Confirming a transfer creates exactly one claim per intent, in state
   `reserved`, against the budget for its direction.
2. A settlement webhook moves that claim to `finalized`; redelivery of the same
   event is a no-op. Finalizing an already-finalized claim does not consume
   twice.
3. Failure, cancellation and `returned` move it to `released`; a release is
   bounded by the claim's own amount and identified by intent id, never by a
   window total. Releasing an already-released claim is a no-op.
4. Funding volume does not consume withdrawal or P2P budget, and vice versa.
5. A refused confirm leaves no claim and no intent state change.

Concurrency and failure, each asserted against a real PostgreSQL instance:

6. Two concurrent confirms by one user that fit singly but not together: exactly
   one is admitted. Asserted as a **lock** observation, not a scheduling race —
   see the note in 0008's addendum about the test that passed under the bug.
7. A reservation is neither lost on rollback nor double-counted on retry.
8. A provider timeout leaves the reservation held, and the reconcile path is the
   only thing that resolves it; a reservation stranded in `reserved` past a
   stated age is reported, not silently released.
9. No code path holds a transaction open across a provider call. Worth a static
   guard in the manner of `velocity-admission-callers.test.ts`, since this is a
   rule about shape that a reviewer reading one diff cannot check.
10. Concurrent confirm and settlement of the same intent cannot produce two
    claims or a finalize-then-reserve ordering.

Operational — and distinct from the above, which is all code verification:

11. The reserved, finalized and released totals reconcile against
    `transfer_intents` and `ledger_entries`, as a query the existing
    reconciliation job runs.
12. Stranded reservations have a named owner and an alert.

## Unresolved: how long a finalized funding claim consumes capacity

Raised in review of PR #75 against criterion 2 above, and the criteria as
written do not answer it.

Criterion 2 moves a claim to `finalized` when the settlement webhook arrives.
It says nothing about whether a `finalized` claim still counts against the
funding ceiling, or when it stops counting — and settlement is **not** the end
of exposure. A credited ACH debit can still be returned: R01 NSF typically
within two banking days, an unauthorized consumer debit within 60 calendar
days; a Canadian PAD personal dispute within 90 calendar days. So the
reservation horizon and the loss horizon differ by a factor of roughly 12–18,
and the choice of anchor decides which one the ceiling actually bounds.

Neither obvious answer is safe on its own:

- **Stop counting at settlement** restores the user's full funding headroom
  while the credited funds remain returnable. This is what the claim ledger on
  `sec/claim-bounded-velocity-release` does today — `claimedExposure()` there
  sums only `state='reserved'`, so a finalize removes the amount from the total
  immediately. That file is **not** in this branch's tree, so the behaviour is
  stated as the reversal branch's, not as this commit's. It makes the ceiling
  a bound on *unsettled* value only, which is defensible but is not what
  "funding limit" reads as.
- **Count finalized claims indefinitely** makes the ceiling cumulative and
  eventually exhausts a legitimate user's capacity with no path to recovery.

What a decision has to state, and this record deliberately does not invent:

1. **The anchor** — which event starts the clock. The settlement webhook's
   receipt time, the provider's own settlement date, or the confirm time.
   These differ by days on a real rail, and only one of them is a fact the
   provider asserts rather than a time this system happened to observe.
2. **The horizon** — how long after that anchor a finalized claim keeps
   consuming capacity. Per direction and per rail, because the US and Canadian
   windows above are not the same, and because a withdrawal's reversal risk is
   not a funding return.
3. **Whether the horizon is the same number as the realized-loss window** in
   the section below. If it is not, there are two clocks and both need an
   owner.

Acceptance cases either answer needs, in the manner of criteria 6–10:

- A claim finalized and queried **before** the horizon expires still consumes
  capacity; the same claim queried **after** it does not. Both boundaries
  asserted, against a real PostgreSQL instance, with the anchor set explicitly
  rather than taken from `now()`.
- A claim finalized at the anchor's edge is counted on exactly one side of the
  boundary, so the comparison's inclusivity is pinned rather than incidental.
- Redelivery of the settlement event does not move the anchor, so a provider
  retry cannot extend or restart the window.
- The expiry is a property of the **query**, not a background job that mutates
  state, so a stalled worker cannot silently restore headroom.

**Not resolved here.** Both the anchor and the horizon are financial-policy
numbers, and this program's standing constraint is not to invent them. Until
they are set, read criterion 2 as finalizing the claim's *state* only, with its
capacity treatment undefined — which is a gap in the proposal, not a decision
already taken.

## In-flight exposure is not realized loss

Raised in review of PR #75, and it is a real hole in the proposal above rather
than a detail of it.

A funding budget built as option C bounds **unsettled in-flight value** and
releases the claim when a transfer is `returned`. But a return is exactly the
moment the loss becomes *realized*: if the credited balance was already spent
through P2P before the NSF return arrived, releasing the claim restores the
payer's funding headroom while the platform is still short the money. The
control then admits the next deposit as though nothing had happened, and the
cycle repeats — each round bounded only by the per-deposit ceiling, never by the
cumulative amount already lost.

So "release on return" is correct for an in-flight *reservation* and wrong for a
realized *loss*, and one counter cannot be both. The options:

- **Accept it**, on the grounds that the funding ceiling plus KYC plus the
  provider's own return monitoring bound the damage, and that repeat NSF is a
  fraud-operations problem rather than a velocity one.
- **Account for realized returns separately** — a second, non-releasing counter
  that a `returned` transfer increments and nothing decrements, with its own
  ceiling, so a payer who has cost the platform money loses funding capacity
  rather than regaining it.

This record does not choose. It is a loss-tolerance question, not an
engineering one, and the second option needs a number only the owner can set.
It is listed below as a decision rather than folded into C, because C is
implementable without it and this is the part that stops C from being a
complete answer to funding abuse.

## Decisions required from the owner

1. Approve or reject C as the architecture.
2. Approve step 2 (the sandbox stopgap) separately — it is a small change but
   it is a financial control, and it would make a sandbox transfer consume the
   same budget a P2P send does.
3. Set the funding and withdrawal ceilings, and the funding window. These are
   business numbers; this record deliberately proposes none.
4. Decide the **repeated-return** question above: accept that releasing a
   returned claim restores headroom while the loss stands, or add a separate
   non-releasing counter for realized returns — and if the latter, set its
   ceiling.
