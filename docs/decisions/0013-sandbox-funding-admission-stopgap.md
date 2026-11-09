# 0013 — Sandbox funding/withdrawal admission stopgap

- **Status:** **APPROVED by the owner 2026-11-09 (mechanism and limits). NOT IMPLEMENTED.** Two defects in this record's own mechanism were found by review of PR #77 and corrected on the same day — see the two "corrected after review of PR #77" sections below; the approval predates those corrections, and neither changes the approved limits.
- **Blocked on:** independent validation of `0012`'s accounting model, which the owner made a precondition. The approval above does not lift it.
- **Date:** 2026-11-08
- **Supersedes the sketch in** `0009-transfer-rail-velocity-admission.md` §"Sequencing" step 2, which said "admit at `settleSandboxTransfer()` … with `admitVelocity()` exactly as the P2P paths use it". **That instruction was wrong and must not be followed.**

## Why the earlier sketch was wrong

0009 step 2 proposed calling `admitVelocity()` at the sandbox balance movement. `admitVelocity()` writes to `velocity_checks`, and `velocity_checks` **has no domain column** — it is one undifferentiated pool per `(user_id, window_type, window_start, currency)` holding `money:send`, request-accept and `money:split-pay` consumption together.

So that sketch would have made a simulated `add_money` **consume the payer's real P2P outbound budget**. A user funding their sandbox wallet would lose capacity to send money to other users, for reasons unrelated to sending. And the mirror image is the defect 0012 just corrected from the other direction: a release crediting that pool, which was measured letting a payer move 750 against a 500 ceiling.

The lesson is the same one 0012 records: **a credit or a charge in the wrong accounting domain is wrong regardless of its amount**, and bounding the amount does not fix it. The owner's instruction — "Do not implement a sandbox add-money control that unintentionally consumes or releases P2P outbound velocity budget" — is this hazard named precisely.

## How simulated funding and withdrawal should be limited

Three domains, three independent budgets, no shared counter:

| Domain | Counter | Written by | Bounds |
|---|---|---|---|
| **P2P outbound** | `velocity_checks` | `admitVelocity()` | value a user sends to other users |
| **Funding** (`add_money`) | `velocity_claims` where `claim_kind = 'funding'` | `createVelocityClaim()` | unsettled value being pulled in |
| **Withdrawal** (`cash_out`) | `velocity_claims` where `claim_kind = 'withdrawal'` | `createVelocityClaim()` | value being pushed out to a bank |

Nothing mirrors a claim into `velocity_checks`, so cross-domain contamination is impossible by construction rather than by a guard.

### The ceiling is NOT `claimedExposure()` — corrected after review of PR #77

An earlier revision of this record said exposure per domain is derived by
`claimedExposure(userId, claimKind, currency)`. **That function is the wrong
input for this ceiling, and using it would defeat the owner's decision.**

`claimedExposure()` is a **rolling-window** measure: it sums `reserved` claims
whose recorded `hourly_`/`daily_`/`weekly_window_start` is at or after the
*current* window's boundary. The owner's approved sandbox cap is **cumulative
per test cycle**, resettable only by an authorized audited operation. Wire the
cap to that function and yesterday's funding drops out of the sum at midnight,
so the same user funds another CA$100 with no reset — the exact opposite of
"capacity does not come back on its own". The two statements sat four
paragraphs apart in this record and contradicted each other.

What the admission must read instead:

1. **A per-user, per-currency, per-cycle consumption total** that only an
   authorized reset clears. Two shapes work and the implementation picks one:
   a dedicated `sandbox_funding_cycles` row carrying `consumed` and a
   `cycle_id`, incremented in the settlement transaction; or an unwindowed
   `SUM(amount)` over funding claims tagged with the current `cycle_id`.
   Either way the cycle, not the calendar, bounds the sum.
2. **A release must NOT decrement it.** The cap bounds how much simulated
   funding a user has exercised in a cycle, which is a cumulative fact. This
   is the same distinction `0011` draws between an in-flight reservation and a
   realized total, and it is why the cap cannot be read off the reserved set
   at all: `reserved` is a state claims leave.

`claimedExposure()` keeps its own meaning — in-window in-flight exposure per
domain — and its limitation is now documented at the function itself.

### Serializing the aggregate decision — corrected after review of PR #77

The earlier revision said: *"Same write-then-verify ordering as
`admitVelocity()`: claim first, verify exposure after, throw to roll back."*
**That ordering does not work here, and the reason generalizes.**

Write-then-verify closes the TOCTOU in `admitVelocity()` because the rows it
writes are **shared**: one row per `(user, window_type, window_start,
currency)`. A second concurrent admission by the same payer upserts the *same*
row, blocks on the first transaction's lock, and only then reads a total that
includes the first claim. The lock is what makes the verify meaningful.

`velocity_claims` rows are **per-intent** — `ON CONFLICT (provider,
reference) DO NOTHING`, and two different intents are two different
references. So two concurrent confirmations insert two *different* rows,
contend on nothing, and at `READ COMMITTED` each verifies against a snapshot
that cannot see the other. Two CA$60 confirmations both pass a CA$100 check.
There is no `FOR UPDATE` and no advisory lock anywhere in the claim-creation
path — verified against `lib/velocity-claims.ts` at `eee2656`.

**This is the same CWE-367 defect decision 0008 exists to close**, reproduced
on the funding path by copying a mechanism without its precondition. Which is
the third time in this program that a control was carried from one path to
another and lost the property that made it work.

The admission must therefore hold a lock that is shared across *distinct*
intents of one user and currency, for the whole span from reading consumption
to committing the claim. Either:

- **`pg_advisory_xact_lock(hashtext('sandbox_funding:' || user_id || ':' || currency))`**
  taken inside the settlement transaction before the read — released at commit
  by the transaction, so no unlock path can be forgotten; or
- **a `SELECT ... FOR UPDATE` on the per-cycle consumption row** from option 1
  above, which serializes on a row that every one of that user's funding
  confirmations must touch. Preferred, because the lock and the counter are the
  same object and cannot drift apart.

Serializable isolation with retries also works, but it imports a retry policy
into a money path for no benefit over a row lock on a row that already has to
exist.

**Required test, which the earlier criteria did not have:** two concurrent
confirmations of **distinct** intents by one user, each fitting the cap singly
but not together — exactly one admitted. Asserted as a **lock** observation,
not a scheduling race: hold one transaction open and require the second to be
unable to reach a decision. The obvious version of this test passed under the
read-then-write mutation in `0008`'s work, and that lesson is recorded in
`CLAUDE.md` precisely so it is not re-learned here.

**Where the admission goes.** `settleSandboxTransfer()` (`lib/providers/sandbox-settlement.ts`) already locks the intent row and moves the platform balance in one transaction. The claim is created **inside that transaction, on its `tx`** — so the balance change and the claim commit together or not at all, and no second pool connection is requested (`lib/db.ts` sets `max: 5`; the deadlock this avoids is documented in `CLAUDE.md` and was re-demonstrated in 0012's mutation testing).

**Refusal.** Over the funding ceiling, the admission throws and the transaction aborts, so no balance moves. Same write-then-verify ordering as `admitVelocity()`: claim first, verify exposure after, throw to roll back. The ordering matters for the same reason — a read-then-write check admits two concurrent confirmations on one pre-confirmation total.

**Withdrawal stays disabled.** `cash_out` is blocked on separate grounds already recorded in `CLAUDE.md`, and the settlement executor skips `cash_out` balance updates. The `withdrawal` claim kind exists and is tested so the domain is not retrofitted later, but **no route creates one**.

## Limits for the sandbox

Deliberately **not** the figures in `0010`. Those are derived from Plaid's and Stripe's ceilings and belong to a rail that moves real money; a sandbox balance is simulated, so a provider ceiling is not the binding constraint.

**Set by the owner, 2026-11-09:**

| Currency | Cumulative sandbox funding capacity, per user per test cycle |
|---|---|
| CAD | **CA$100** |
| USD | **US$100** |

**Sandbox cash-out: disabled.**

Note the shape: **cumulative per test cycle**, not a rolling window. It is not
a velocity limit with a different number in it — there is no hourly, daily or
weekly boundary, and capacity does not come back on its own. A user who funds
CA$100 in a sandbox cycle has no funding capacity left until the cycle is reset.

**A test cycle may be reset only by an authorized, audited administrative
operation.** No public route, no customer-controlled reset, and no reset as a
side effect of any other action. That makes the reset itself a privileged
operation needing its own permission check and audit row — it is the one thing
in this mechanism that creates capacity, so it is the one thing most worth
pinning.

The control's purpose in the sandbox is to prove the *mechanism* — domains stay
separate, refusal rolls back, duplicates do not double-count — not to price
risk. One number per currency, no tiering.

What must **not** happen is the sandbox ceiling being read from `VELOCITY_LIMITS`. Sharing the constant would make a later change to P2P limits silently change funding behaviour, which is the same coupling as sharing the counter, one level up.

## Acceptance criteria

Each maps to an owner requirement, named so coverage is checkable against the requirement rather than against my summary.

**Domain separation** — the correction this record exists for:

1. A simulated `add_money` confirmation consumes **funding** exposure and leaves `velocity_checks` **byte-identical**.
2. After funding to the funding ceiling, a P2P send of the full P2P ceiling still succeeds. The two budgets are independent.
3. Conversely, a payer at their full P2P ceiling can still fund. No ordering dependency between the domains.
4. A simulated withdrawal claim, if one is ever created, moves neither funding exposure nor `velocity_checks`.

**Atomicity — "balance changes and velocity admission commit together":**

5. A successful confirmation leaves balance moved **and** claim created, in one commit.
6. A confirmation that fails after admission (insufficient platform balance, ledger insert failure) leaves **neither** — no claim, no balance change.
7. A confirmation refused for exceeding the funding ceiling moves no balance and leaves no claim.
8. The admission is passed the settlement transaction's `tx`. Asserted both behaviourally (concurrency) and structurally (a static guard), because the pool deadlock *hangs* rather than failing an assertion.

**Duplicate confirmation — "does not consume twice":**

9. Confirming the same intent twice creates **one** claim. The `(provider, reference)` unique index does this, not a prior read — a check-then-insert carries the same race as the velocity TOCTOU.
10. The second confirmation is rejected on intent status (`409`), and even if it were not, the claim count stays 1.
11. Six concurrent confirmations of one intent produce one claim and one balance movement.

**Sandbox containment:**

12. No live provider flag is read or set. `PLAID_TRANSFER_LIVE` and `CA_EFT_LIVE` stay default-off and are not consulted.
13. `execution_mode` must be `'sandbox'`; a `live` intent is refused by the existing gate before any claim is created.
14. The sandbox ceiling constant is **not** `VELOCITY_LIMITS`, asserted by a static guard.

**Not a substitute for Option C** — the owner's explicit concern:

15. The sandbox path creates a claim at `reserved` and **never finalizes or releases it**, because a sandbox transfer settles immediately and cannot return. A test asserts no sandbox path calls `finalizeVelocityClaim()` or `releaseVelocityClaim()`, so the reserve→finalize→release lifecycle stays unexercised and visibly unimplemented.
16. A static guard asserts no live provider path calls the sandbox admission helper.
17. `CLAUDE.md` and `0009` record this as a **temporary sandbox control, not evidence of live transfer readiness**, in the same words.

## Regression tests to write before implementation

A new `lib/__tests__/sandbox-funding-admission.test.ts` against real PostgreSQL — the subject is transaction boundaries, a unique index and row locks, none of which exist in a fake. Plus additions to the static guard file.

| Test | Pins criterion |
|---|---|
| funding confirmation leaves `velocity_checks` unchanged, byte for byte | 1 |
| funding to ceiling then a full-ceiling P2P send succeeds | 2 |
| full-ceiling P2P send then funding succeeds | 3 |
| balance and claim commit together | 5 |
| injected failure after admission leaves neither | 6 |
| ceiling refusal moves no balance, leaves no claim | 7 |
| six concurrent confirmations: one claim, one balance movement, no timeout | 8, 11 |
| duplicate confirmation creates one claim | 9, 10 |
| a `live` intent is refused before any claim | 13 |
| static: sandbox admission passes `tx`; ceiling is not `VELOCITY_LIMITS`; no sandbox path calls finalize/release; no live path calls the sandbox helper | 8, 14, 15, 16 |

**Mutation checks required before this is called done**, because a passing suite proved nothing in the last two revisions of this work:

- Swap the claim write for `admitVelocity()` — the original wrong sketch. Criteria 1–3 must fail.
- Drop the `tx` argument. The concurrency test must hang or fail, and the static guard must fail.
- Remove the unique index reliance (check-then-insert). The duplicate and concurrent cases must fail.
- Move the admission after the balance update. Criterion 7 must fail.

## Decisions required from the owner — all answered 2026-11-09

1. ~~Approve this corrected approach, replacing 0009 step 2.~~ **Approved** —
   the corrected domain-separated sandbox funding mechanism.
2. ~~Set the sandbox funding ceiling per currency.~~ **CA$100 / US$100
   cumulative per user per test cycle**, reset only by an authorized, audited
   administrative operation.
3. ~~Confirm withdrawal stays uncreated in the sandbox.~~ **Confirmed —
   sandbox cash-out disabled.**
4. ~~Confirm the reserve→finalize→release lifecycle stays unexercised here.~~
   **Confirmed**, and reinforced: the sandbox implementation must remain
   **explicitly separate** from the future live-rail architecture, so this can
   never be mistaken for option C having been built.

### Requirements the decision adds to the acceptance criteria above

- **Claims stay independent of `velocity_checks`.** Already criterion 1 here
  and already statically guarded by
  `lib/__tests__/velocity-admission-callers.test.ts`; restated because it is
  the invariant two previous implementations broke.
- **A successful sandbox funding operation commits the claim, the balance and
  the ledger changes atomically.** One transaction, or none of it.
- **Duplicate confirmation creates neither a duplicate claim nor a duplicate
  balance movement.**
- **Reset is privileged and audited**, per the table above.

**Status after this decision: approved, specified, and NOT YET IMPLEMENTED.**
It is also still **blocked on** `0012`'s corrected accounting model being
independently validated, which the owner made a precondition — the approval
above does not lift that block.
