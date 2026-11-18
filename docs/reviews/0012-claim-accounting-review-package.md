# Review package — claim/exposure accounting (decision 0012)

**For a reviewer who did not write this code.** That is the whole point: the
author's own adversarial review already exists and does not satisfy the
requirement.

**Source SHA:** `55c8cee` (the model landed on `master` as `0cdadfa`, PR #77).
**Status of the prerequisite:** the owner required independent validation
before PR #77 merged, authorized the merge on 2026-11-18, and **waived the
requirement for that merge decision**. A waiver of a gate is not a pass
through it. The requirement still stands for transfer-rail activation and for
implementing decision 0013.

---

## Why an outside reviewer is required

This control has been got **wrong twice, in opposite directions**, and both
times the accompanying tests asserted the defect under titles claiming
correctness.

1. `reverseVelocity()` released `min(amount, current window total)`. That
   total spans every money path, so a returned funding transfer freed budget
   `money:send` and `money:split-pay` had genuinely consumed.
2. Its replacement wrote negative "compensating" rows into the same
   undifferentiated pool — the identical error with a tighter bound. Measured
   at the time: a funding release cut pure P2P volume 450 → 350, a withdrawal
   release cut it 400 → 250, and a release with no prior charge drove usage to
   **−300**, after which the payer moved **750 against a 500 hourly ceiling**.

The second was found by an outside inspection, not by the suite, **which
passed**. That is the precedent that makes self-review insufficient here.

---

## What to read, in this order

| File | Lines | Why |
|---|---|---|
| `docs/decisions/0012-claim-bounded-velocity-release.md` | — | The decision and its §"The first implementation was wrong" |
| `lib/velocity-claims.ts` | 469 | **The subject.** The whole module |
| `lib/auth.ts` → `admitVelocity`, `VELOCITY_LIMITS`, `velocityWindows` | 569 | The P2P side the claims must not touch |
| `lib/settlement/SettlementExecutor.ts` → `executeVelocityReversal` | 735 | The only production caller of release |
| `lib/settlement/SettlementOrchestrator.ts` → `reverseVelocity` plan field | 405 | How a `returned` status reaches it |

Tests, which are evidence to audit rather than to trust:
`velocity-claim-release.test.ts` (26 cases),
`velocity-claim-adversarial.test.ts` (11), `velocity-admission.test.ts` (12),
`velocity-admission-callers.test.ts` (static guards),
`settlement-b3.3.test.ts`.

---

## Schema

```sql
CREATE TABLE velocity_claims (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  reference TEXT NOT NULL,
  claim_kind TEXT NOT NULL,          -- the accounting domain
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL,
  hourly_window_start TIMESTAMPTZ NOT NULL,
  daily_window_start  TIMESTAMPTZ NOT NULL,
  weekly_window_start TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved',
  released_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  released_at TIMESTAMPTZ,
  release_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX velocity_claims_reference_key
  ON velocity_claims (provider, reference);
```

The unique index is load-bearing twice: it makes a release **identifiable**
(a webhook names an intent, not a window), and it is the guard against a
duplicate confirmation claiming twice.

Contrast `velocity_checks`, which has **no domain column** — one
undifferentiated pool per `(user_id, window_type, window_start, currency)`
holding `money:send`, request-accept and `money:split-pay` together. That
absence is the reason a cross-domain write is wrong *regardless of amount*.

---

## The financial invariants

Stated as the properties that must hold, not as a description of the code —
so a reviewer can check the code against them rather than the reverse.

1. **Domain separation.** `velocity_claims` and `velocity_checks` are disjoint
   ledgers. Nothing in `lib/velocity-claims.ts` may `INSERT`, `UPDATE` or
   `DELETE` against `velocity_checks`, in either direction, at any amount.
2. **Exposure is derived, never stored.** `claimedExposure()` SUMs positive
   `amount` over `state='reserved'`, scoped by `user_id` / `claim_kind` /
   `currency`. It cannot go negative by construction.
3. **A release reduces only its own claim**, identified by
   `(provider, reference)` — never by a window total.
4. **Idempotence.** Duplicate and concurrent deliveries create neither a
   duplicate claim nor a duplicate release, and manufacture no capacity.
5. **Audit is transaction-bound.** The audit row commits with the release or
   rolls back with it. It must not take its own connection — see the pool note
   below.
6. **Unknown outcomes stay recoverable.** A claim whose provider outcome is
   unknown is findable
   (`findVelocityClaimsNeedingReconciliation()`) and not silently dropped.
7. **Failures propagate.** No `try/catch` in the module: a database failure
   must surface, not be reported as success.

### The contract that is easy to get wrong in the other direction

`releaseVelocityClaim()` **returns** `{ released: false }` with a reason for
`no_claim` and `already_released`. Those are expected outcomes, not errors.
Only a genuine fault throws. A caller that treats every non-release as an
exception is wrong.

---

## What the reviewer is specifically asked to verify

Each maps to one of the owner's six stated requirements.

- [ ] **Complete separation of P2P, funding and withdrawal accounting.** Not
      only that no write crosses, but that no domain's outcome is *decided by
      reading* another's counter. The first version of this rule had only the
      write half, which is how the transfer-intent gate survived it (see
      "Known limitations" below).
- [ ] **Exposure cannot become negative**, under any sequence of create /
      finalize / release / duplicate release / release-without-claim.
- [ ] **Release is limited to its own claim.** Construct a user with claims in
      two domains and a large P2P balance; release one and show the others are
      untouched.
- [ ] **Duplicate and concurrent deliveries cannot manufacture capacity.**
      Note that `velocity_claims` rows are **per-intent** and contend on
      nothing, so write-then-verify does *not* serialize two concurrent
      confirmations of distinct intents against a shared per-user ceiling.
      That is a real limit of the model and the central design question for
      0013.
- [ ] **Audit records are transaction-bound.** Verify by rolling back a
      release and showing no audit row survives.
- [ ] **Unknown outcomes remain recoverable.**

### Three mutations worth re-running independently

The author verified these; a reviewer should not take that on trust.

1. Reintroduce any `velocity_checks` write into `lib/velocity-claims.ts` →
   expected: **12 cases across four files** fail, including a static guard.
2. Restore the `auditLog()` call inside the release transaction → expected:
   the six-concurrent-release test **hangs** and times out at 5s rather than
   failing an assertion. `lib/db.ts` sets `max: 5`; `auditLog()` takes its own
   connection, so five in-flight releases hold all five and each waits for a
   sixth. The pool deadlocks.
3. Remove any one of the three idempotency mechanisms in
   `releaseWithin` — the `FOR UPDATE`, the early already-released return, or
   the `state <> 'released'` update predicate. Expected: **behaviour does not
   change**, because they are 3-way redundant. A static guard asserts all
   three are present; a reviewer should decide whether redundancy without
   behavioural coverage is acceptable.

---

## Known limitations and unresolved issues

Stated plainly, because a review package that omits them wastes the
reviewer's time.

1. **`claimedExposure()` is a rolling-window measure.** It is the wrong input
   for 0009's in-flight exposure and for 0013's **cumulative** test-cycle
   ceiling: capacity would replenish at each calendar boundary with no
   authorized reset. Documented in the module and in 0013.
2. **The per-intent row cannot serialize a per-user ceiling** (above). 0013
   needs a shared lock — preferring `FOR UPDATE` on a per-cycle counter row.
3. **Only `returned` reaches the release path**, and it needs a provider
   webhook. Both live flags are off, so the release path is **unreachable in
   production today**. That bounds the blast radius and also means it has
   never run against real provider traffic.
4. **The cross-domain intent gate is still in the tree and still refuses.**
   `app/api/transfers/intent/route.ts` gates both `add_money` and `cash_out`
   on `checkVelocityLimit()` — the P2P *outbound* pool — and returns 429. So
   inbound value is refused by an outbound ceiling. Decision 0009 chose option
   C and requires the replacement control to exist **before** this is removed.
5. **The transfer rail consumes no velocity at all**, so there is currently no
   charge for a release to be the counterpart of. Measured 2026-11-18:
   CA$1,850 funded across 5 sandbox confirmations with the P2P counter
   untouched.
6. **Nothing here has run against production data**, and behaviour under
   Supabase's transaction pooler is unobserved.

---

## How to run the tests

```bash
createdb manna_review
psql "postgres://…/manna_review?sslmode=disable" -f lib/__tests__/helpers/test-schema.sql
DATABASE_URL="postgres://…/manna_review?sslmode=disable" pnpm test
```

A **fresh** database each time, and the fixture applied first — skipping it
fails four files on seeded rows they did not create, which reads like a
regression and is not one. `?sslmode=disable` is required for a local server.

Current measurement on this branch (`fix/sandbox-beta-blockers`): **71 files /
992 tests**, typecheck 0 errors, lint 0 errors / 29 pre-existing warnings.
Master at `55c8cee` was 68 / 977; this branch adds 15 — registration (6),
fixture parity (4), email failure (5).

---

## What a satisfactory outcome looks like

A written statement from the reviewer naming the SHA, each of the six
verification items, and either confirmation or a finding — including "did not
verify" where that is the truth. The requirement is not a green suite; the
suite was green both times this control was wrong.
