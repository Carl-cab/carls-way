# 0007 — Fail-open or fail-closed for the money buckets when Redis is unavailable

**Status:** Proposed. **Awaiting an owner decision — not implemented either way.**
**Date:** 2026-10-26
**Reviewed against:** `master` at `0b609f4` — the field read "Decided against",
which contradicted the status line one row above it: nothing has been decided.
`lib/rate-limit.ts` is byte-identical between `0b609f4` and `e0f3f0d` (the
current tip), so the reading still holds; the anchor is kept at the commit the
code was actually read at rather than advanced to look current.

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
from 10 to `10 × instances` executions per hour.

**How large that is, is UNVERIFIED, and an earlier draft of this record
asserted a bound it could not support.** It read: "On Vercel's Hobby plan the
instance count is small and not controllable by the caller, so this is a
multiplier in the low single digits, not an unbounded hole." No deployment
limit, observed count, or other evidence for that exists anywhere in this
repository, and this environment cannot obtain one — `api.vercel.com` and the
deployment host both answer `403 CONNECT`. Asserting a numeric bound in order
to justify a security posture is precisely the move this project's rules
forbid, so it is withdrawn rather than softened. **Treat `instances` as
unknown and therefore the multiplier as unbounded** until someone with
deployment access establishes a concurrency ceiling. If that number turns out
to be large, it strengthens the case for the Postgres counter in ask 3 below;
it does not by itself flip the recommendation, because the recommendation
rests on the asymmetry of the two failure modes rather than on the size of the
multiplier.

**What else constrains it, stated at its real scope.** `velocity_checks`
applies a rolling volume limit per user that does not depend on Redis, and it
is the control that actually caps how much a user can move during an outage.
The per-intent idempotency key and `SELECT ... FOR UPDATE` claim on
`transfer_intents` do **not** belong in that list, and an earlier draft wrongly
included them: they prevent one intent being debited twice, and say nothing
about a caller creating many separate intents. Conflating "cannot double-debit
an intent" with "cannot exceed a volume" is how a rate-limit decision gets
made on a control that was never a rate limit. So the layers that survive a
Redis outage are `velocity_checks` and nothing else; the rate limit is the
outermost layer and the only one that degrades.

**Fail-closed risk — refusing real payments.** If the money buckets refused
while Redis was unreachable, a Redis outage would become a **payments outage**.
Every send, split payment and transfer execution would fail for every customer
until Redis returned, even though the database, the providers and the
application were all healthy. The blast radius is total and customer-visible,
and it falls on **every** customer.

The fail-open blast radius falls only on the subset of users actively abusing
the system during the outage, and its *size* is unknown — this sentence said "a
modest multiplier on an already-bounded limit", which smuggled the withdrawn
claim back in after the section above had retracted it. The honest statement is:
the per-user limit still applies on every instance, the aggregate ceiling
loosens by an unmeasured factor, and `velocity_checks` continues to cap volume
per user. Who it affects is known; how much is not.

## Recommendation

**Keep all three fail-open, and add a signal instead of a refusal.**

The asymmetry decides it, and it decides it **without needing the multiplier's
size** — which is just as well, because that size is unverified. Fail-closed
converts a cache outage into a **total, customer-visible payments outage**:
every send, split payment and transfer execution fails for every customer
while the database, the providers and the application are all healthy.
Fail-open leaves the per-user limit in force on every instance and loosens the
aggregate ceiling by an unknown factor, for the subset of users actively
abusing the system during the window, with `velocity_checks` still capping
volume per user throughout.

One is a certain outage for everyone; the other is a loosened limit for
attackers. That ordering does not depend on whether `instances` is 2 or 200.
What the unknown multiplier does change is the urgency of ask 3: the larger it
could be, the less acceptable it is to leave the counter in Redis at all.

Stated precisely, the worst case under fail-open is "a determined user sends
more often than the nominal hourly limit for the duration of the outage, still
bounded by `velocity_checks`". It is **not** "limits vanish", which
per-instance counting does not cause.

Nor is it "money moves twice" — **while the provider's idempotency record is
still live.** That qualifier matters and an earlier draft of this paragraph
omitted it, saying the key "does prevent" it, flatly. That contradicted
`GO_LIVE_RUNBOOK.md` §4.1 *in the same commit*, which correctly notes the
retention is bounded. A retry arriving after the provider has expired its
record is not covered by the key and needs reconciliation. The guarantee is
real and it is time-bounded, and an unconditional version of it should not be
used to prop up this decision — which is the same failure as the instance-count
claim above, one paragraph later.

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
