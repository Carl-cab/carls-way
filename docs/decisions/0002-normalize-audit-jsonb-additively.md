# 0002 — Fix the audit JSONB writers, normalize reads, and leave history alone

**Date:** 2026-10-17
**Status:** Accepted
**Supersedes:** nothing

## Context

Both audit writers bound `JSON.stringify(value)` to a `jsonb` column:

```ts
// lib/auth.ts                     → audit_logs.metadata
VALUES (${userId}, ${action}, ${metadata ? JSON.stringify(metadata) : null})
// lib/rbac/AuditLogRepository.ts  → admin_audit_logs.changes
${input.changes ? JSON.stringify(input.changes) : null},
```

That does not store an object. It stores the serialised text as a jsonb
**string scalar**. Measured against a real `jsonb` column:

| Bound value | `jsonb_typeof` | `m->>'ip'` | `m::text` |
|---|---|---|---|
| `JSON.stringify({ip:'1.2.3.4'})` | `string` | **NULL** | `"{\"ip\":\"1.2.3.4\"}"` |
| `sql.json({ip:'1.2.3.4'})` | `object` | `1.2.3.4` | `{"ip": "1.2.3.4"}` |

Two measured details are worth recording because they are the traps:

- Adding an explicit `::jsonb` cast to the stringified form does **not** fix
  it. The cast applies to text that is already a complete JSON document, so
  the result is still a string scalar. This is the intuitive fix and it is
  wrong.
- `sql.json(null)` stores SQL NULL, not the jsonb `null` literal, so a
  nullable column needs no special casing.

### Why it went unnoticed

The paired reader compensated for it exactly:

```ts
changes: row.changes ? JSON.parse(row.changes) : undefined,   // before
```

`postgres.js` hands a jsonb string scalar back as a JS string, so `JSON.parse`
decoded it into the original object. **Application reads were correct.** Only
SQL-side access was broken — and silently, because a JSON path operator against
a string scalar returns NULL rather than erroring. An auditor's
`WHERE changes->>'field' = ...` matched nothing, a `@>` containment filter
returned no rows, and a GIN index on the column would have indexed one opaque
string per row.

That is the half that matters here. The value of an audit trail is that it can
be queried by someone other than the application that wrote it.

### Why the writer could not be fixed alone

With a corrected writer the row comes back as an object, and `JSON.parse` of an
object stringifies it to `"[object Object]"` and throws `SyntaxError`. In
`createAuditLog` that lands in the catch and is reported as
`AUDIT_CREATE_FAILED`, so fixing only the writer would have taken admin audit
logging from "stored awkwardly" to "appears to fail outright". Measured, not
reasoned about. Writer and reader had to move in the same commit.

## Decision

Three parts.

**1. Writers bind documents.** A shared `jsonbParam()` in `lib/jsonb.ts`
replaces `JSON.stringify` at both sites. It is a named helper rather than an
inline `sql.json(...)` so the reasoning has one home and the next `jsonb`
column added to this codebase has something correct to copy.

**2. Reads normalize, permanently.** `readJsonbRecord()` accepts both an object
and a legacy string, and `AuditLogRow.changes` is typed
`Record<string, unknown> | string | null` so a future bare `JSON.parse` does not
compile. Unparseable text is returned as `{ raw: <text> }` rather than thrown:
on an audit path, losing a record because its metadata is malformed is worse
than surfacing the text verbatim.

**3. Historical rows are not rewritten.** No `UPDATE` is issued against
existing audit rows, here or in `/api/migrate`.

## Additive normalization vs. in-place migration

The alternative was a one-off `UPDATE ... SET metadata = metadata #>> '{}'
::jsonb WHERE jsonb_typeof(metadata) = 'string'`, making the column uniform and
letting the reader drop the legacy branch.

Rejected, on these grounds:

**Immutability and evidential value.** These tables are the audit trail. An
`UPDATE` across historical audit records is the precise operation the trail
exists to make detectable. Even a correctness-preserving rewrite destroys the
property that no row has been altered since it was written, and it would be
indistinguishable, after the fact, from a rewrite that changed something that
mattered.

**Authorization.** Altering production history is outside what this change is
authorized to do. It is a separate, separately-approved operation.

**It is not reversible.** The pre-migration bytes are gone unless a backup is
pinned and retained first. An additive change can be reverted by reverting a
commit.

**Query compatibility is restored either way, for new rows.** The compliance
question is whether audit records written from now on are queryable; they are.
Historical rows remain reachable by `metadata #>> '{}'`, so they are awkward,
not lost — and a view can paper over that without touching a byte.

**Indexing is a minor cost, not a blocker.** A GIN index on a mixed column is
created without complaint and works — measured, on a column holding one legacy
scalar and one document. It simply also indexes the legacy rows, which is
wasted space rather than an error, and those rows cannot satisfy a containment
or path query either way. So a `WHERE jsonb_typeof(...) = 'object'` predicate is
an available optimization — a partial index, matching the shape already used for
`velocity_checks` — not a requirement. No such index exists yet in any case.

**If a uniform column is later wanted**, the honest route is to write the
normalized value to a **new** column, leave the original untouched, and record
the derivation — additive, reversible, and it preserves the original bytes as
evidence. That is a separate decision and is not taken here.

There is precedent in the tree for tolerating both shapes rather than rewriting:
`lib/external-settlement-reconciliation.ts` already branches on
`jsonb_typeof(e.raw_payload) = 'string'`, and `lib/provider-events.ts:160`
accepts either shape for `raw_payload`. The same defect class exists on
`provider_webhook_events.raw_payload`; it is **not** fixed here, and is recorded
as an open item rather than silently bundled into an audit-logging change.

## A silent failure found while testing

`auditLog()` ended in `catch { /* Non-blocking */ }`. Non-blocking is right — a
failed audit write must not fail the action being audited — but total silence is
not. The regression test initially wrote no row at all and reported success: the
cause was `23503`, an FK violation on `audit_logs.user_id`, discarded without
trace. Any stale user id silently destroys the audit record.

The catch now logs the action and user id. It deliberately does **not** log
`metadata`, because callers put request-shaped values in it.

## Immutability, assessed rather than assumed

The directive asked whether immutability guarantees cover unauthorized `UPDATE`
or `DELETE`, including privileged database actions. Measured on a database built
from the schema sources:

| Control | Present |
|---|---|
| `BEFORE UPDATE` / `BEFORE DELETE` trigger on either audit table | **No** |
| Rewrite rule | **No** |
| Row-level security | **No** (`relrowsecurity = f` on both) |
| `REVOKE UPDATE, DELETE` from the application role | **No** — no `REVOKE` in any schema source |
| Append-only enforcement of any kind | **No** |
| Hash chaining or signatures over rows | **No** |

So **nothing enforces immutability at the database level.** The application
connects with a single role that performs all DML, which means the same
credential that writes an audit row can update or delete it, and a privileged
operator can do so with no residue. `audit_logs` is described as an "Immutable
system audit trail" in `CLAUDE.md`; that is an intent, not an enforced
property, and this change corrects the wording rather than leaving a claim the
schema does not support.

`AuditLogRepository.verifyImmutability()` compares `COUNT(*)` to `MAX(id)`, so
it detects gaps from deletes and cannot detect an update at all;
`AdminAuditService.verifyImmutability()` returns a hardcoded `'clean'`. Both
remain as they were — already recorded under CLAUDE.md's known gaps — because
making immutability real is a schema-and-privileges decision, not a one-line
repair, and it is out of scope for this change.

**No claim of cryptographic tamper resistance is made, because none is
implemented.**

## Consequences

- Audit records written from now on are queryable by JSON path, containment
  and index. Mutation-checked: reverting the `lib/auth.ts` writer fails 2 of
  13 cases, the repository writer 1 of 13, the reader 2 of 13.
- The repository-writer mutation fails only the SQL-side assertion, because
  the tolerant reader still round-trips a string scalar. That asymmetry is the
  original defect's invisibility, reproduced as a test signal — which is why
  the SQL-side assertions, not the round-trip, are what guard this.
- Readers carry a legacy branch for as long as pre-fix rows are retained. This
  is deliberate and is documented at the call site, not a TODO.
- `provider_webhook_events.raw_payload` still has the same defect.
- Immutability is now documented as unenforced instead of asserted.

## Alternatives considered

**Explicit `::jsonb` cast at the call sites.** Does not work; measured above.

**Store the metadata as `text`.** Would make the current encoding correct by
definition, but gives up every reason to use `jsonb` — querying, containment,
indexing — on the one table whose purpose is being queried by outsiders.

**Backfill into a new normalized column now.** Additive and safe, but it adds a
column, a backfill and a second source of truth to solve a problem nobody has
yet, since no jsonb index or SQL-side audit query exists on these tables today.
Recorded above as the route to take if one is needed.
