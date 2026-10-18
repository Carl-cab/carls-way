# 0003 — Bind documents when copying one JSONB column into another

**Date:** 2026-10-18
**Status:** Accepted
**Relates to:** `docs/decisions/0002-normalize-audit-jsonb-additively.md`

## Context

0002 fixed the two audit writers that bound `JSON.stringify(value)` to a `jsonb`
column. That is not the whole of the defect class, because the same shape can be
reintroduced by code that touches no literal at all.

`markProviderEventFailed()` moves a dead-lettered event's payload from
`provider_webhook_events.raw_payload` into `webhook_dead_letters.raw_payload`.
Both columns are `jsonb`, and **both source writers are correct** —
`recordProviderEvent()` and `ProviderEventRepository` both use `sql.json`. The
copy was not:

```ts
const payload = typeof row.raw_payload === 'string'
  ? row.raw_payload
  : JSON.stringify(row.raw_payload ?? null);
... VALUES (..., ${payload}::jsonb, ...)
```

`postgres.js` returns a jsonb document as a JS object, so the `typeof` test
takes the `JSON.stringify` branch, and `::jsonb` applied to text that is already
a complete JSON document yields a **string scalar**. Correct writers at both
ends, and a double-encoded destination between them.

Measured through the real `recordProviderEvent()` and
`markProviderEventFailed()` against a real database — 4 of 6 new cases failed
before the fix:

| Assertion on `webhook_dead_letters.raw_payload` | Before |
|---|---|
| `jsonb_typeof` is `object` | `string` |
| `raw_payload->>'id'` | NULL |
| `raw_payload#>>'{data,object,id}'` | NULL |
| `@>` containment filter matches | 0 rows |
| a NULL source payload stays SQL NULL | became the jsonb **`null` literal** |

The NULL case is a second, independent bug in the same line:
`JSON.stringify(null)` is `"null"`, and `'null'::jsonb` is the JSON null
literal, not SQL NULL.

### Why it mattered, and why nothing appeared broken

`webhook_dead_letters` is the operator-review queue for events that exhausted
their retries. Every SQL-side look into a dead-lettered payload returned NULL or
no rows, silently. Replay itself kept working, because
`parseStoredStripeEvent()` tolerates the string form — the same compensating
reader that hid the audit defect in 0002. A control whose data cannot be
queried is not a control an operator can use.

### A documentation error this corrected

`CLAUDE.md` claimed `provider_webhook_events.raw_payload` "is still
double-encoded by its writer". That was wrong, and it was contradicted by a
comment already in the tree:
`lib/external-settlement-reconciliation.ts` says "Historical writers passed
JSON.stringify(payload) to a JSONB parameter... New writers use
sql.json(payload) and store an object." The claim was an inference drawn from
the *defensive readers* rather than a reading of the writers. The real defect
was one table over. Both `CLAUDE.md` statements are corrected.

## Decision

Bind the source value **as is** with `jsonbParam()` and drop the `::jsonb`
cast:

```ts
const payload = row.raw_payload;
... VALUES (..., ${jsonbParam(sql, payload)}, ...)
```

A document source yields a document; a legacy string scalar yields the same
scalar; NULL yields SQL NULL.

### The first version of this fix normalized the shape, and that was wrong

It also parsed a legacy string-scalar source into a document on the way into
the queue — an apparently free repair of a historical row. CodeRabbit's review
caught that it is not free, and the claim checked out:

`claimDeadLetterForReplay()` (`lib/webhooks/replay.ts:101`) joins the queue row
to its source row and requires

```sql
AND dl.raw_payload IS NOT DISTINCT FROM e.raw_payload
```

deliberately, so that a corrupt row cannot be replayed under another event. The
equality is between the two **stored** representations. Transforming one side
therefore breaks the claim: it matches no row, and the caller sees
`not_found_or_already_replayed` rather than reaching recovery. A legacy
dead-lettered event would have become **unreplayable** — a functional
regression introduced by a fix for a querying defect.

Measured directly, source scalar against both candidate queue shapes:

| Queue row | source `jsonb_typeof` | queue `jsonb_typeof` | `IS NOT DISTINCT FROM` |
|---|---|---|---|
| normalized (first version) | `string` | `object` | **false** |
| preserved (this decision) | `string` | `string` | `true` |

So the repair is not available from this seat at all. Making historical rows
uniform means changing the source too, which is a separately authorized
migration — the same conclusion as 0002, reached here by a different route.

`normalizeJsonbDocument()`, added for that first version, is **removed** rather
than left exported and unused.

### What this says about the general rule

"Normalize on the way through" is safe only where nothing later compares the
two representations. Here something does, and the comparison is a security
control rather than an implementation detail. The lesson recorded in `CLAUDE.md`
is the narrower one: fix the *encoding mechanism*, do not change the *value*.

## Consequences

- An operator can query dead-lettered payloads written from a document source
  by JSON path, containment and index.
- A NULL payload is SQL NULL again rather than the jsonb `null` literal, so it
  still satisfies `IS NOT DISTINCT FROM` and stays claimable. Plain `=` would
  not; that operator choice is load-bearing and is now covered by a test.
- Legacy string-scalar payloads keep their shape in the queue. They remain
  awkward to query by path (`#>> '{}'` first) and fully replayable. Replay
  itself was never broken, because `parseStoredStripeEvent()` accepts both.
- 9 cases in `lib/__tests__/dead-letter-jsonb-encoding.test.ts`, including
  three that assert the replay-claim equality **directly** for document,
  legacy-scalar and NULL payloads. Those three are the guard whose absence
  allowed the regression to be written: the original tests asserted only the
  stored shape, which the wrong behaviour satisfied.
- Mutation-checked. Restoring `JSON.stringify` + `::jsonb` fails 5 of 9;
  reintroducing the normalization fails 3 of 9, two of them equality cases.
- One case asserts the *source* column is still written correctly, so a
  regression in `recordProviderEvent` is caught here too.
- Rollback is clean: no reader does a bare `JSON.parse` on
  `webhook_dead_letters.raw_payload`, and `parseStoredStripeEvent()` already
  accepts both shapes.

## Alternatives considered

**Normalize in SQL with `CASE WHEN jsonb_typeof(...) = 'string' THEN (... #>> '{}')::jsonb ELSE ... END`,**
as `lib/external-settlement-reconciliation.ts` does on read. Rejected for the
write path twice over: it repeats a five-line conditional at each call site, it
does not fix the NULL-literal bug, and — the decisive reason — it is the same
shape change that breaks the replay claim above. The reconciliation query's
version stays as it is: it normalises on **read**, where nothing compares the
stored representations, which is exactly why that is safe and this would not
be.

**Leave it, since replay works.** Rejected. The queue exists for humans to
inspect, and the reader tolerance that makes replay work is exactly what makes
the problem invisible.

**Migrate the existing double-encoded `webhook_dead_letters` rows.** Not taken
here. These are failure evidence, the same argument as 0002, and the readers
tolerate both shapes. If a uniform column is wanted later it should be an
additive, separately authorized migration.
