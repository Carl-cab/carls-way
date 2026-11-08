# 0012 — Claim-bounded velocity release

- **Status:** Accepted — **revised 2026-11-08 after an independent inspection found a critical accounting defect in the first implementation. Read §"The first implementation was wrong" before anything else.**
- **Date:** 2026-11-08
- **Authorized by:** repository owner, who classified release of another transaction's velocity budget as a critical financial-control defect and required a claim-bounded, idempotent release design.
- **Prerequisite for:** `0009-transfer-rail-velocity-admission.md`'s sandbox stopgap and for enabling any transfer rail. **No rail may be enabled until this is verified.**

## The defect

`SettlementExecutor` called `reverseVelocity()` when a transfer reached `returned`. That function released:

```
min(requested_amount, SUM(total_amount) over the user's current window)
```

The window total is the user's volume from **every** money path. So a returned transfer freed budget `money:send` and `money:split-pay` had genuinely consumed.

The abuse shape is direct: fund by `add_money`, spend the credit through P2P, let the funding transfer return NSF, and recover outbound budget that was actually used. Each cycle restores spending capacity the account had already spent.

**It was latent, not reachable.** A `returned` status requires a provider webhook, and both `PLAID_TRANSFER_LIVE` and `CA_EFT_LIVE` are off, so no reachable path produced one. That is why it was reported rather than hot-fixed — and why fixing it is a prerequisite rather than an incident.

Two further defects lived in the same function, each matching a requirement the owner stated independently:

- **No transaction.** The three per-window inserts ran as three separate statements. A failure on the second left the first one's release committed — real budget handed back for a release that did not complete.
- **A swallowing `catch`.** It logged and returned normally, so that partial release was silent and the caller could not distinguish a failed release from a completed one. This is the "database errors do not silently create extra budget" requirement failing in the plainest way.

## The first implementation was wrong, and the tests asserted the defect

An independent GitHub inspection of `836a8cd` found that `createVelocityClaim()`
records a claim **without charging `velocity_checks`**, while
`releaseVelocityClaim()` wrote negative compensating rows **into**
`velocity_checks`. Investigated against the source and a real database, the
finding is **confirmed, and worse than reported.**

The root cause is architectural, not arithmetic. **`velocity_checks` has no
domain column.** It is one undifferentiated pool per
`(user_id, window_type, window_start, currency)` holding `money:send`,
request-accept and `money:split-pay` consumption together. Any credit into it
is therefore cross-domain by construction, whatever the amount is bounded by.

Measured, on a database built from the CI fixture:

| Probe | Result |
|---|---|
| Funding claim of 100 released against 450 of **pure P2P** volume | P2P usage `45000 → 35000`. The funding return paid back P2P spending |
| **Withdrawal** claim of 150 released against 400 of P2P volume | P2P usage `40000 → 25000`. Cross-domain in the second direction too |
| Release of a 300 claim from an **empty** start | Usage drove to **−300**. `parseDatabaseMoney` refused to read it — negative net usage |
| After that release, P2P admissions against a **500** hourly ceiling | Admitted **500**, then a further **250**. The payer moved **750 against a 500 ceiling** — a 50% bypass, from a return on a transfer that consumed nothing |

**The first version's own tests asserted this.** `velocity-claim-release.test.ts`
contained `expect(await consumed()).toBe(cad('350.00'))` after releasing a 100
claim against 450 of P2P volume, under a title claiming it proved the release
was "bounded by the claim". The amount was bounded; the *domain* was not, and
the title hid the difference. One case even commented that a claim owner going
negative against an empty window was "representable and auditable" — a
rationalisation of capacity creation.

This is the same failure as the deleted `reverseVelocity` tests, one revision
later and by my own hand: a test that encodes the current behaviour as the
expectation, so the defect reads as a feature and the fix would read as a
regression. Clamping the negative rows would have hidden the third probe and
left the first two untouched, so the model changed instead.

## The decision

A release must have an **identity**. A webhook names an *intent*, not a window.

`velocity_claims` records one row per claim, keyed `(provider, reference)` where `reference` is the transfer intent id. `lib/velocity-claims.ts` provides `createVelocityClaim()`, `finalizeVelocityClaim()`, `releaseVelocityClaim()` and `findVelocityClaimsNeedingReconciliation()`. `reverseVelocity()` is **deleted** — not deprecated, and with no compatibility shim, because a function that can free unattributed budget must not remain reachable.

Each required property is structural rather than conventional:

Funding and withdrawal exposure lives in `velocity_claims` and is **derived
from claim state** by `claimedExposure()`, scoped by `user_id`, `claim_kind`
and `currency`. **Nothing in this module writes to `velocity_checks` at all** —
not an insert, not an update, not a clamped one. `velocity_checks` is the P2P
outbound domain and stays that way. A release is a state transition that
removes the claim from the reserved set, so it reduces only its own domain's
exposure.

| Requirement | How it holds |
|---|---|
| A release identifies the original claim | The claim is looked up by `(provider, reference)`; there is no code path that releases without one |
| Never exceeds the original claimed amount | Exposure is a `SUM` over the reserved subset; releasing removes exactly one claim's own `amount` |
| A funding claim cannot reduce P2P velocity consumption | The module makes **no write to `velocity_checks`**, enforced by a static guard in `velocity-admission-callers.test.ts` |
| A withdrawal claim cannot reduce funding exposure | `claimedExposure()` filters on `claim_kind`, so the two domains are different sums |
| A release without an original charge cannot create negative usage or capacity | Exposure sums the **positive** `amount` of a subset of rows, so it cannot go below zero. A property of the model, not a clamp |
| Late returns cannot increase P2P headroom | No credit is ever written to `velocity_checks`, so there is nothing to mis-date |
| Duplicate webhook cannot double-release | `SELECT ... FOR UPDATE` serialises, and a conditional `UPDATE ... WHERE state <> 'released'` decides. Idempotency is keyed on the **claim**, not the event id — keying on the event would let two distinct deliveries each take the amount once |
| Late returns do not credit unrelated current windows | The claim records its **own** `hourly/daily/weekly_window_start` at claim time. A release credits those, not the windows current when the return arrives |
| Database errors do not silently create extra budget | Claim state and all three compensating rows are **one transaction**, and the function deliberately has **no `try/catch`** |
| Historical adjustments remain auditable | Compensating rows are appended, never mutated; the claim keeps `released_amount`, `released_at` and `release_event_id` |
| Reconciliation can identify mismatched claims | `findVelocityClaimsNeedingReconciliation()` reports claims stuck in `reserved` past an age, and counts `velocity_claim_release_mismatch` audit rows |

### Why a return with no claim releases nothing

The transfer rail holds no claims today — 0009 is approved but unimplemented. So `no_claim` is the **expected** outcome for a returned transfer right now, and the correct release is **zero**: the rail consumed no budget, so there is none to give back. Inferring an amount from a window is precisely the defect.

It is not silent. A mismatch row is written on the caller's transaction (not through `auditLog()`, which uses its own connection and swallows errors) because a return against an unknown reference is the signal reconciliation needs. `SettlementExecutor` reports `velocityReversed: false` with the reason, rather than claiming a reversal it did not perform.

### Why the window boundaries are recorded on the claim

From `0010`'s evidence: a US unauthorized-consumer-debit return can arrive **60 calendar days** after settlement, and a CA PAD personal-account dispute **90 calendar days**. By then the claim's original hourly and daily windows are long past. Crediting the *current* windows would hand back headroom in a window that never carried the charge — free budget, the same class of defect from the other direction.

## Transaction and audit integrity

The first implementation also called `auditLog()` from **inside** the release
transaction. `auditLog()` takes its own connection from `getSql()` and
swallows its errors — two defects at once, both already documented in
`CLAUDE.md`, and both reintroduced here by me. Confirmed by mutation:

- **Pool deadlock.** `lib/db.ts` sets `max: 5`. A release holding a
  transaction connection and then asking the same pool for a second is the
  shape that deadlocked `paySplitPortion()`. Restoring the `auditLog()` call
  makes the six-concurrent-release test **time out at 5000 ms** and cascade
  into 10-second hook timeouts on the tests after it — it hangs rather than
  failing, which is what the bug does to a request.
- **Misleading success.** With the swallowing `catch` back, the two atomicity
  cases report `promise resolved "undefined" instead of rejecting`: a release
  whose audit write failed returned normally.
- **An audit row that outlives its own rollback.** Written on a separate
  connection, the audit row commits independently, so a rolled-back release
  leaves a record of something that did not happen — worse than a missing one.

The release now writes its audit row on the caller's executor, so it commits
and rolls back with the release and a failure propagates. The static guard
asserts the module never calls `auditLog()` again.

## Evidence

Suite: **67 files / 965 tests, all passing** on a database created fresh for
the run with the CI fixture applied. Typecheck 0 errors; lint 0 errors / 30
pre-existing warnings; `pnpm run build` succeeds. `scripts/verify-migrate.sql`
reports `velocity_claims` and `velocity_claims_reference_key` both `OK`.

`lib/__tests__/velocity-claim-release.test.ts` — 26 cases against real
PostgreSQL, titled by requirement. Mutation-checked, each mutation applied to
the real source and the suite re-run:

| Mutation | Caught by |
|---|---|
| **The reported defect**: reintroduce the cross-domain compensating rows | **12 cases across four files**, including the static guard |
| Restore the `auditLog()` call inside the transaction | 5 cases — a 5s pool-deadlock timeout, cascading hook timeouts, and two "resolved instead of threw" |
| On `no_claim`, release from the window (what `reverseVelocity()` did) | 2 cases — the payer's entire 450 of P2P budget is drained |
| Remove the early return and the `state <> 'released'` guard | 2 cases — three concurrent deliveries all release instead of one |

Two harness bugs were found by running these rather than by reading them, and
both are worth recording because each looked like a production defect at
first: the executor proxy needed `sql.json` carried across, or `jsonbParam()`
failed with "sql.json is not a function"; and the static guard's own
string-stripper blanked `'reserved'`, so its assertion could never have
matched.

### Five tests were rewritten because they asserted the defect

Three in `velocity-claim-release.test.ts`, one in `velocity-admission.test.ts`
("releases headroom when a claim is released" — it asserted P2P usage dropping
from 450 to 150), and one in `settlement-b3.3.test.ts` (which expected the
recorded P2P volume to fall from 100 to 50 after a funding return). Each is now
stated as the invariant it should have been, with the old expectation named in a
comment so the next reader sees what changed and why.

## What this does not do

It does not implement 0009. There is still no claim **creation** on the transfer rail — `createVelocityClaim()` exists and is tested, but no route calls it. That is the sandbox stopgap's job and then Option C's. Until a rail creates claims, every return takes the `no_claim` path, which is correct and also means this release machinery is not yet load-bearing in production.

It does not change the three P2P money paths. Those consume budget through `admitVelocity()` and have no release path, by design: a completed P2P payment is not returnable.

## Migration impact

One new table and two indexes, added to all three schema sources per `CLAUDE.md`'s rule (`lib/db.ts`, `app/api/migrate/route.ts`, `lib/__tests__/helpers/test-schema.sql`) plus `scripts/verify-migrate.sql`. `POST /api/migrate` must be run after deploy. The unique-index creation is wrapped so a pre-existing duplicate reports a warning rather than aborting the rest of the migration, matching how `velocity_checks_window_key` is handled.

## Rollback

Revert the commit and re-run `/api/migrate`; the table is additive and unused by any live path, so dropping it is safe but unnecessary. **Reverting restores the defect**, so if it must be reverted, the rail stays disabled.
