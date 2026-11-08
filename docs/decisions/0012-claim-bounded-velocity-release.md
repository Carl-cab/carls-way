# 0012 — Claim-bounded velocity release

- **Status:** Accepted
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

## The decision

A release must have an **identity**. A webhook names an *intent*, not a window.

`velocity_claims` records one row per claim, keyed `(provider, reference)` where `reference` is the transfer intent id. `lib/velocity-claims.ts` provides `createVelocityClaim()`, `finalizeVelocityClaim()`, `releaseVelocityClaim()` and `findVelocityClaimsNeedingReconciliation()`. `reverseVelocity()` is **deleted** — not deprecated, and with no compatibility shim, because a function that can free unattributed budget must not remain reachable.

Each required property is structural rather than conventional:

| Requirement | How it holds |
|---|---|
| A release identifies the original claim | The claim is looked up by `(provider, reference)`; there is no code path that releases without one |
| Never exceeds the original claimed amount | The amount comes from the claim row. **Nothing in the release path sums `velocity_checks` to decide how much to give back** — that was the defect |
| Never frees unrelated P2P or split-payment budget | Same: the amount is the claim's, and the compensating rows carry the claim's `user_id` and `currency` |
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

## Evidence

Suite: **67 files / 955 tests, all passing** on a database created fresh for the run with the CI fixture applied. Typecheck 0 errors; lint 0 errors / 30 pre-existing warnings. `scripts/verify-migrate.sql` reports `velocity_claims` and `velocity_claims_reference_key` both `OK`.

`lib/__tests__/velocity-claim-release.test.ts` — 19 cases against real PostgreSQL, titled by requirement. Mutation-checked, each mutation applied to the real source and the suite re-run:

| Mutation | Caught by |
|---|---|
| Bound the release by the current window total, crediting current windows | 2 cases — the late-return case reads `35000` instead of `45000` |
| **The actual original defect**: on `no_claim`, release from the window (what `reverseVelocity()` did) | 2 cases — the payer's entire 450 of P2P budget is drained; `expected +0 to be 45000` |
| Remove the early return and the `state <> 'released'` guard | 2 cases — a redelivered return releases again, and three concurrent deliveries all succeed instead of one |

The atomicity cases inject the failure by **proxying the executor** to throw on the second compensating insert. An earlier draft tried to force it by pointing the claim at a non-existent user, which cannot work — `velocity_claims.user_id` has a foreign key, so the *setup* threw rather than the release. The proxy is both honest and closer to the real hazard: it fails after the first insert is already written, which is exactly the old implementation's failure mode.

### Two tests were deleted rather than preserved

`velocity.test.ts` held an eight-case `describe('reverseVelocity')` block, and `settlement-b3.3.test.ts` asserted `velocityReversed === true` for any returned transfer. Both pinned the defective behaviour — "releases the reversed amount from every window" for a caller-supplied amount, and "the window nets back to zero". They were accurate about the code and wrong about what the code should do, so keeping them would have made the fix look like a regression. The settlement case is now **two** cases, because the old single assertion conflated "released nothing because there was no claim" with "released correctly".

## What this does not do

It does not implement 0009. There is still no claim **creation** on the transfer rail — `createVelocityClaim()` exists and is tested, but no route calls it. That is the sandbox stopgap's job and then Option C's. Until a rail creates claims, every return takes the `no_claim` path, which is correct and also means this release machinery is not yet load-bearing in production.

It does not change the three P2P money paths. Those consume budget through `admitVelocity()` and have no release path, by design: a completed P2P payment is not returnable.

## Migration impact

One new table and two indexes, added to all three schema sources per `CLAUDE.md`'s rule (`lib/db.ts`, `app/api/migrate/route.ts`, `lib/__tests__/helpers/test-schema.sql`) plus `scripts/verify-migrate.sql`. `POST /api/migrate` must be run after deploy. The unique-index creation is wrapped so a pre-existing duplicate reports a warning rather than aborting the rest of the migration, matching how `velocity_checks_window_key` is handled.

## Rollback

Revert the commit and re-run `/api/migrate`; the table is additive and unused by any live path, so dropping it is safe but unnecessary. **Reverting restores the defect**, so if it must be reverted, the rail stays disabled.
