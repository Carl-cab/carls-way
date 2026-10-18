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

Add `normalizeJsonbDocument()` to `lib/jsonb.ts` and use it with `jsonbParam()`
wherever a value read from one `jsonb` column is written to another:

```ts
const payload = normalizeJsonbDocument(row.raw_payload);
... VALUES (..., ${jsonbParam(sql, payload)}, ...)
```

It differs from `readJsonbRecord()` deliberately. `readJsonbRecord` is for
metadata records and wraps anything non-object in `{ raw }`;
`normalizeJsonbDocument` preserves arrays and scalars unchanged, because a
webhook payload may legitimately be any JSON document. Text that does not parse
is returned unchanged and therefore stored verbatim as a jsonb string: losing a
dead-letter payload is worse than storing it awkwardly.

It also **repairs** a legacy string-scalar source row on the way through,
rather than carrying the double-encoding forward into the new table. This is
not a rewrite of history — the source row is untouched; only the new
`webhook_dead_letters` row is written correctly.

## Consequences

- An operator can query dead-lettered payloads by JSON path, containment and
  index. 6 new cases in `lib/__tests__/dead-letter-jsonb-encoding.test.ts`.
- A NULL payload is SQL NULL again rather than the jsonb `null` literal.
- Mutation-checked. Restoring `JSON.stringify` + `::jsonb` fails 4 of 6.
  Keeping `jsonbParam` but dropping `normalizeJsonbDocument` fails exactly 1 —
  the legacy string-scalar source — which is precisely what the normalizer
  adds, so the two halves are independently guarded.
- One case asserts the *source* column is still written correctly, so a
  regression in `recordProviderEvent` is caught here too.
- Rollback is clean for this change, unlike 0002: no reader anywhere does a
  bare `JSON.parse` on `webhook_dead_letters.raw_payload`.
  `parseStoredStripeEvent()` already accepts both shapes, so reverting leaves
  documents written during the window fully readable.

## Alternatives considered

**Normalize in SQL with `CASE WHEN jsonb_typeof(...) = 'string' THEN (... #>> '{}')::jsonb ELSE ... END`,**
as `lib/external-settlement-reconciliation.ts` does on read. Rejected for the
write path: it repeats a five-line conditional at each call site and does not
fix the NULL-literal bug. The reconciliation query's version stays as it is —
it reads historical rows and must keep doing so.

**Leave it, since replay works.** Rejected. The queue exists for humans to
inspect, and the reader tolerance that makes replay work is exactly what makes
the problem invisible.

**Migrate the existing double-encoded `webhook_dead_letters` rows.** Not taken
here. These are failure evidence, the same argument as 0002, and the readers
tolerate both shapes. If a uniform column is wanted later it should be an
additive, separately authorized migration.
