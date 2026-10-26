# 0007 — Fail-open or fail-closed for the money buckets when Redis is unavailable

**Status:** Proposed. **Awaiting an owner decision — not implemented either way.**
**Date:** 2026-10-26
**Decided against:** `master` at `0b609f4`

## The question, narrowed

Three buckets govern money movement. All three key on the **authenticated user
id**, read from source:

| Bucket | Limit | Key |
|---|---|---|
| `money:send` | 20 / hour | `user:${user.userId}` |
| `money:split-pay` | 30 / hour | `user:${user.userId}` |
| `money:transfer-execute` | 10 / hour | `String(user.userId)` |

Because the key is the authenticated user and never a header, **header loss
cannot collapse these buckets** — the failure mode that turns `auth:register`
into a single global counter does not apply here. Tests pin this
(`rate-limit-identity-outage-interaction.test.ts`). So the question reduces to
one case: **Redis unavailable.**

Today every bucket fails **open**: the limiter falls back to in-process
counters, so the effective limit becomes `limit × instances` — still per user,
just weaker. Nothing refuses.

## The two risks, stated at their real size

**Fail-open risk — abuse.** During a Redis outage a single user's ceiling rises
from 10 to `10 × instances` executions per hour. On Vercel's Hobby plan the
instance count is small and not controllable by the caller, so this is a
multiplier in the low single digits, not an unbounded hole. It is also **not
the only control**: `transfer_intents` carries a per-intent idempotency key and
a `SELECT ... FOR UPDATE` claim, so a replay cannot double-debit one intent,
and `velocity_checks` applies a separate rolling volume limit per user that
does not depend on Redis. The rate limit is the outermost of three layers, and
it is the only one that degrades.

**Fail-closed risk — refusing real payments.** If the money buckets refused
while Redis was unreachable, a Redis outage would become a **payments outage**.
Every send, split payment and transfer execution would fail for every customer
until Redis returned, even though the database, the providers and the
application were all healthy. The blast radius is total and customer-visible;
the fail-open blast radius is a modest multiplier on an already-bounded limit
for the subset of users who are actively abusing the system during the outage.

## Recommendation

**Keep all three fail-open, and add a signal instead of a refusal.**

The asymmetry decides it: fail-open costs a bounded multiplier on an abuse
ceiling that two other layers still constrain; fail-closed costs a full
payments outage triggered by a cache dependency. Trading customer payments for
a single-digit abuse multiplier is the wrong direction for a payments product,
and `velocity_checks` plus the idempotency key mean the worst case is "a
determined user sends more often than intended for the duration of an outage",
not "money moves twice" or "limits vanish".

What should change instead:

1. **Make the degradation observable.** `rateLimitBackendHealth()` already
   reports the active backend, a cumulative degradation count and the remaining
   cooldown. Nothing scrapes it. Until something does, a silent demotion to
   per-instance counting is indistinguishable from normal operation — which is
   the actual defect here, not the fail-open choice.
2. **Alert on it, with an owner.** A sustained degradation on a payments path
   deserves a page, not a log line. This is listed under operational proof and
   has no named owner yet.
3. **Move the counter to PostgreSQL for these three buckets.** The application
   cannot run without `DATABASE_URL`, so a Postgres-backed counter has no new
   dependency and no outage mode that Redis loss introduces. That removes the
   dilemma rather than choosing a side, and it belongs with decision 0005
   Phase 2, which already needs a counter table created ahead of the migration
   it limits.

## Explicitly preserved

`schema:migrate-operator` and `schema:bootstrap` stay fail-open regardless of
what is decided above. Refusing them when Redis is absent would make an
optional environment variable a hard dependency of the only schema-migration
path and of the command-line break-glass — the shape of the Release 1.0
lockout. The threat there is an authenticated operator's runaway loop, not an
anonymous attacker.

## What this document does not do

It does not change behaviour. No code implements a fail-closed path, and none
should until this decision is made, because doing it unilaterally would either
weaken a financial control or interrupt customers.

## Noted while writing this

`money:transfer-execute` keys on `String(user.userId)` while the other two use
`user:${user.userId}`. Keys are namespaced per bucket, so this cannot collide
and is **not a defect** — but it is an inconsistency that would matter if
anything ever iterated keys across buckets, and it is cheaper to note than to
rediscover.
