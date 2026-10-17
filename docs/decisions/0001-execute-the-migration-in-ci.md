# 0001 — Execute the migration route in CI, and check its declarations statically

**Date:** 2026-10-17
**Status:** Accepted
**Supersedes:** nothing

## Context

`app/api/migrate/route.ts` is the only mechanism by which the production schema
changes. Nothing executed its statements. Two tests appear to cover it and do
not: `migrate-route-anonymous-path.test.ts` mocks `@/lib/db` wholesale (on
purpose — it tests control flow), and `schema-source-parity.test.ts` parses the
file with regular expressions.

Measured on `40946fb`: changing one statement to `ADD COLUM` left typecheck
clean and all 735 tests passing. The failure would have appeared only when an
operator ran `/api/migrate` against production.

## Decision

Add `lib/__tests__/migrate-route-execution.test.ts`, which runs the real `GET`
handler with the real database layer and asserts the statements execute, report
no warnings, and are idempotent across repeated runs.

Two design choices are load-bearing, and both were arrived at by measurement
rather than preference.

### It runs against the shared test database, not a scratch one

`getSql()` memoises the first `DATABASE_URL` it sees, so pointing the route at a
scratch database would require module-registry manipulation. More importantly, a
populated database is the realistic case — production is populated, and a
statement that works on an empty table can fail on one with rows. Every
statement in the route is additive and idempotent; that contract is precisely
what is being asserted, so exercising it against a populated database is the
test rather than a risk to it.

### Declaration coverage is checked statically, not against the catalogue

The first version of the coverage check queried `information_schema` after the
run. That cannot detect a **removed** statement, for two compounding reasons:
the expectation is parsed from the route's own source, so deleting a statement
deletes its own expectation; and `test-schema.sql` and `initializeSchema()` both
create the same tables, so the catalogue holds them whether or not the route
does.

Measured: with the database assertion, deleting the `webhook_dead_letters`
`CREATE` passed all seven cases. The check therefore compares the route's
declarations against the list curated in `scripts/verify-migrate.sql` — which is
maintained independently of the route and names the objects whose absence makes
application code raise `42703` or `42P01` at runtime.

## Consequences

- A malformed, mis-ordered, or newly-invalid statement fails in CI instead of in
  production. Mutation-checked: the `ADD COLUM` typo fails 2 of 7 cases.
- A statement that disappears from the production migration path fails in CI.
  Mutation-checked: removing the `webhook_dead_letters` `CREATE` fails 1 of 7.
- The suite now writes to the shared test database through the route. This is
  safe by the route's own additive-and-idempotent contract, and `fileParallelism`
  is already `false`, so no other file races it.
- `scripts/verify-migrate.sql` becomes load-bearing for CI, not only for
  operators. Adding an object that application code reads unguarded without
  adding it there weakens the check — which is already the instruction in
  CLAUDE.md's schema rule.

## Alternatives considered

**Run the route against a disposable database per test.** Rejected for the
`getSql()` memoisation reason above, and because an empty database is the less
realistic of the two starting states.

**Execute `scripts/verify-migrate.sql` in CI instead.** Rejected: it verifies an
end state, so it would pass on a database that `initializeSchema()` had built
correctly even if the route were broken. The point is to exercise the route.

**Extract the statements into a .sql file and run that.** Rejected as a larger
change than the problem needs; it would move production's migration path rather
than test it, and the route also carries conditional logic (the money-column
detector, the reported-not-fatal index creation) that a flat file cannot express.
