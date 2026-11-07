# 0008 — Atomic velocity admission in PostgreSQL

- **Status:** Accepted
- **Date:** 2026-11-07
- **Decided by:** repository owner (chose option B from the three recorded in `scripts/status/readiness.json`)
- **Supersedes:** nothing. **Relates to:** `0007-money-bucket-policy-on-redis-loss.md`, whose fail-closed requirement this implements explicitly rather than incidentally.

## Context

Every money path in this application admitted a payment against the payer's
velocity budget like this:

```
checkVelocityLimit()   -- read the rolling window totals
   ... move money ...
recordVelocity()       -- add this payment to those totals
```

The read and the write are separate statements. They ran on separate
snapshots, and nothing held the payer's `velocity_checks` rows in between — no
lock, no serialization, no conditional write. Two concurrent payments by one
payer therefore each observed the *pre-payment* total, each concluded there
was headroom, and both completed. The ceiling bounded a single request rather
than the account it was written to bound. This is CWE-367, time-of-check /
time-of-use, on the control decision 0007 describes as "the control that
actually caps how much a user can move".

The defect was pre-existing and system-wide. It was raised in review of PR
#74, which brought `money:split-pay` under the velocity control; that PR
inherited the race along with the control rather than introducing it.

Three options were recorded and put to the owner:

- **(A)** Take a per-payer lock — advisory, or `SELECT ... FOR UPDATE` on the
  payer's `users` row — before the check and hold it through the money
  movement, on all four money paths.
- **(B)** Make admission a single atomic operation in PostgreSQL.
- **(C)** Accept the race explicitly and document velocity ceilings as
  approximate under concurrency.

Option (A) was initially proposed and was **wrong as first stated**: a lock
taken before the check and released at commit is released *before*
`recordVelocity()` publishes the new total, so the next payment still reads a
stale value. A lock whose protected invariant is published after the lock is
dropped protects nothing. It became viable only once consumption moved inside
the money transaction — at which point it is strictly more machinery than (B)
for the same guarantee.

The owner chose **(B)**.

## Decision

Admission is one operation, `admitVelocity()` in `lib/auth.ts`, and it is
**write-then-verify** inside a transaction:

1. Upsert the three window rows (`hourly`, `daily`, `weekly`), incrementing
   count and amount. Each upsert takes a row lock that PostgreSQL holds until
   the transaction ends — not until the statement ends.
2. Re-read the window totals. Being after the write and in the same
   transaction, this read sees this admission's own claim plus every
   committed one.
3. If any ceiling is breached, **throw** `VelocityLimitError`, which rolls the
   claim back along with the payment.

A concurrent admission for the same payer blocks at step 1 on the row this one
holds, and resumes only once this transaction commits or aborts. It then
increments on top of a settled total and step 2 refuses it if that puts the
payer over. There is no interval in which two admissions observe the same
headroom, because the total is published by the same commit that releases the
lock — the exact property option (A) failed to provide.

Every money path calls it **inside its money transaction, passing `tx`**:
`money:send`, request-accept, and `money:split-pay`. That is what makes
consumption commit with the money and rollback release it, and it is also
required to avoid the `max: 5` pool deadlock documented in `CLAUDE.md`.

Refusal travels as a thrown error rather than a returned flag. This is not
stylistic. The claim is already written when the decision is made, so only a
rollback releases it; a thrown error aborts the caller's transaction by
construction, which makes "a refused payment consumes no budget" a property of
control flow rather than a convention each caller has to remember. A returned
`{ admitted: false }` would leave the increments committed by any caller that
forgot.

## Consequences

**The race is closed on the three paths that move a balance.** Velocity now
bounds an account, not a request.

**The post-commit velocity write is gone**, and with it a second defect: those
writes ran after the money had already moved, so a failure there returned 500
for a payment that had succeeded, with no recovery path and the payer's budget
unconsumed. That window was open on `money:send` and request-accept until this
change.

**`checkVelocityLimit()` survives as an explicitly non-binding preview**, with
exactly one permitted caller: `POST /api/transfers/intent`, where creating a
draft moves no money and grants no claim. It must never gate a balance
movement and must never be paired with `recordVelocity()` to do so.
`lib/__tests__/velocity-admission-callers.test.ts` is a static guard that
fails if a money path uses either, or if an `admitVelocity()` call omits its
executor. The guard exists because the defect was a *shape* copied from path
to path, not a bug in one function: fixing four callers while leaving the
unsafe pair exported means the fifth, written the same way, reintroduces it
silently.

**Refused payments now consume a lock briefly.** A payer at their ceiling
serializes their own concurrent attempts rather than running them in parallel.
That is the intended cost and it is bounded per payer; it does not serialize
distinct payers, which take disjoint rows.

**Decision 0007's fail-closed requirement is now implemented, not incidental,
for these three paths.** `admitVelocity()` has no `try/catch` and no caller
may add one; an evaluation failure propagates and aborts the transaction
before any balance moves. `split-pay-velocity.test.ts` and
`velocity-admission.test.ts` pin it.

**0007's observability ask is only partly addressed.** Moving the *velocity*
counters to an atomic PostgreSQL operation was always the durable half of that
record. The Redis-backed *rate-limit* buckets are untouched: they still
degrade silently to per-instance counting, nothing scrapes
`rateLimitBackendHealth()`, and no alert has a named owner. This record does
not close those.

**The transfer rail still consumes no budget at all.** `POST
/api/transfers/intent` previously carried a comment saying velocity was
"recorded only at confirm step"; no confirm or execute route has ever written
velocity. Sandbox confirm does move the platform balance. Closing that belongs
with the rail work and is deliberately not done here — recorded as an open gap
in `CLAUDE.md` rather than papered over.

## Evidence

Suite: **65 files / 932 tests, all passing**, against a database created fresh
for the run with `lib/__tests__/helpers/test-schema.sql` applied. Typecheck 0
errors; lint 0 errors, 28 pre-existing unused-variable warnings.

Mutation-checked, each mutation applied to the real source and the suite
re-run:

| Mutation | Caught by |
|---|---|
| Reverse `admitVelocity()` to read-then-write (the old shape) | 2 cases — the serialization test resolves `'admitted'`; the aggregate test reads 600 against a 500 ceiling |
| Drop the own-transaction wrapper, so a refusal cannot roll back | 4 cases |
| Drop the `tx` argument in `lib/splits.ts` | 5 cases, including the static guard and the pool-deadlock timeout at 5s |

One negative result is worth recording, because it nearly shipped. The obvious
concurrency test — fire two admissions that fit singly but not together and
assert exactly one succeeds — **does not detect the defect.** It passed under
the read-then-write mutation, because whether the two transactions interleave
is up to the event loop and the driver, and in practice the first finished
before the second read. A concurrency test that passes under the bug certifies
what it cannot see. The test that does detect it asserts the **lock**: hold the
first transaction open and observe that the second has not reached a decision.
That is a direct observation of the property with no reliance on scheduling,
and it is what `velocity-admission.test.ts` now does.
