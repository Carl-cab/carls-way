# 0013 — Sandbox funding/withdrawal admission stopgap

- **Status:** **Proposed — awaiting owner approval. Not implemented.** This record is the corrected acceptance criteria and regression-test specification the owner asked for *before* implementation.
- **Date:** 2026-11-08
- **Supersedes the sketch in** `0009-transfer-rail-velocity-admission.md` §"Sequencing" step 2, which said "admit at `settleSandboxTransfer()` … with `admitVelocity()` exactly as the P2P paths use it". **That instruction was wrong and must not be followed.**
- **Blocked on:** `0012-claim-bounded-velocity-release.md`'s corrected accounting model, which must be independently validated first.

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

Exposure per domain is **derived** by `claimedExposure(userId, claimKind, currency)` — a `SUM` over the positive `amount` of `reserved` claims. Nothing mirrors a claim into `velocity_checks`, so cross-domain contamination is impossible by construction rather than by a guard.

**Where the admission goes.** `settleSandboxTransfer()` (`lib/providers/sandbox-settlement.ts`) already locks the intent row and moves the platform balance in one transaction. The claim is created **inside that transaction, on its `tx`** — so the balance change and the claim commit together or not at all, and no second pool connection is requested (`lib/db.ts` sets `max: 5`; the deadlock this avoids is documented in `CLAUDE.md` and was re-demonstrated in 0012's mutation testing).

**Refusal.** Over the funding ceiling, the admission throws and the transaction aborts, so no balance moves. Same write-then-verify ordering as `admitVelocity()`: claim first, verify exposure after, throw to roll back. The ordering matters for the same reason — a read-then-write check admits two concurrent confirmations on one pre-confirmation total.

**Withdrawal stays disabled.** `cash_out` is blocked on separate grounds already recorded in `CLAUDE.md`, and the settlement executor skips `cash_out` balance updates. The `withdrawal` claim kind exists and is tested so the domain is not retrofitted later, but **no route creates one**.

## Limits for the sandbox

Deliberately **not** the figures in `0010`. Those are derived from Plaid's and Stripe's ceilings and belong to a rail that moves real money; a sandbox balance is simulated, so a provider ceiling is not the binding constraint.

Proposed instead: **the sandbox funding ceiling is a constant in the code, set low, and distinct from every P2P limit.** A simplified limit is explicitly acceptable here — the control's purpose in the sandbox is to prove the *mechanism* (domains stay separate, refusal rolls back, duplicates do not double-count), not to price risk. One number per currency, owner-set, with no tiering.

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

## Decisions required from the owner

1. Approve this corrected approach, replacing 0009 step 2.
2. Set the sandbox funding ceiling per currency — one number, deliberately low, explicitly **not** the `0010` figures and **not** `VELOCITY_LIMITS`.
3. Confirm withdrawal stays uncreated in the sandbox: the claim kind exists, no route makes one.
4. Confirm that the reserve→finalize→release lifecycle stays unexercised here, so this cannot be mistaken for Option C.
