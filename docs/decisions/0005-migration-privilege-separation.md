# 0005 — Where schema migrations run, and how that unblocks audit immutability

**Date:** 2026-10-18
**Status:** **Proposed** — the recommendation changes a production credential and
object ownership. Nothing here is implemented. This record exists to make the
decision on measured facts.
**Relates to:** 0004 (append-only audit architecture, which this unblocks),
0001 (executing the migration in CI)

## Why this decision exists

0004 established that the only control which actually defends audit rows
against the application's own credential is **privilege separation**: the app
connects as a role that does not own the audit tables. It also recorded the
obstacle — `app/api/migrate/route.ts` issues DDL over the same connection the
application uses for every query, so a non-owning app role breaks the only
mechanism by which the production schema changes.

That obstacle is the subject here. Audit immutability cannot proceed until it
is resolved.

## Verified risks in `/api/migrate`

Measured, not reviewed by eye. Pinned in
`lib/__tests__/migrate-route-security.test.ts` (13 cases), which records the
present weaknesses as assertions so that fixing one forces the assertion to be
inverted in the same change.

| # | Risk | Severity | Evidence |
|---|---|---|---|
| 1 | **DDL on GET, reachable by CSRF.** The route exports only `GET`, and the admin session cookie is `sameSite: 'lax'`. Lax deliberately *sends* cookies on top-level cross-site GET navigation, so a logged-in operations administrator who follows a link from any site runs the full pipeline — 103 statements including `upgradeLegacyMoneyColumns()`, an `ALTER TABLE ... TYPE` that takes `ACCESS EXCLUSIVE` and rewrites a balance table. | **High** | `mod.GET` is a function and `POST`/`PUT`/`PATCH`/`DELETE` are `undefined`; `adminSessionCookieOptions()` sets `sameSite: 'lax'` |
| 2 | **No Origin, Referer or CSRF-token check**, so nothing else interrupts #1 | **High** | route source contains no `origin`, `referer` or `csrf` |
| 3 | **The authenticated operator path has no rate limit.** The single `checkRateLimit` call sits inside the anonymous branch. Five consecutive operator runs all returned 200. | Medium | measured: `[200,200,200,200,200]`, no 429 |
| 4 | **No transaction.** 103 statements, each autocommitting. A failure part-way leaves the schema neither old nor new. | Medium | no `sql.begin` anywhere in the route; demonstrated on a disposable database — `initializeSchema()`'s tables stayed committed after a following statement failed |
| 5 | **Raw error text returned to the caller** (`{ error: String(err) }`), which on a postgres.js error carries the server message and can name objects and constraints. On a fresh deployment the caller may be anonymous. | Low–Medium | route source |
| 6 | **The route requires table ownership.** `ALTER TABLE` and `CREATE INDEX` are owner-only, and the route takes its connection from the same `getSql()` singleton the application uses. | **This is the coupling** | >50 DDL statements; `getSql()` in the route |

### Controls that do hold, and should not be lost

Verified working, and worth stating because a redesign could casually discard
them:

- A **customer JWT is refused with 403.** A customer credential and an
  administrator session are different things, and holding both does not combine
  into operator authority (tested with both present).
- An **administrator in a non-operations role is refused** (`SupportAgent`,
  `ComplianceOfficer`).
- The **anonymous window is narrow and split in two.** On an empty database
  `anonymousRecoveryMode()` returns `'full-bootstrap'`; on a populated one it
  returns at most `'auth-repair'`, which runs `repairAuthCriticalColumns()` — a
  **fixed, written-out allowlist of two columns** (`users.password_hash`,
  `users.token_version`), additive and idempotent, with no request value
  reaching the query text. Both anonymous paths are rate limited to 3/hour.

### One thing I could not verify

`clientIdentifier()` reads `x-real-ip` **first and unconditionally**, falling
back to the last hop of `x-forwarded-for`. Taking the *last* hop is the
defensive choice, since an attacker-supplied value is prepended. Whether
`x-real-ip` can be spoofed depends on whether Vercel's proxy overwrites a
client-supplied header of that name. **I could not test this** — this
environment cannot reach the deployment (403 CONNECT from the egress proxy). If
it is not overwritten, the anonymous rate limit is bypassable by rotating one
header. Recorded as **unverified**, not as a confirmed bypass.

## An out-of-band mechanism already exists

`migrations/` holds three hand-run files:

```
20260907_money_real_to_numeric.sql
20261003_widen_transactions_cross_border_amounts.sql
20261004_early_webhook_metadata_correlation.sql
```

They are deliberately **not** in `/api/migrate` — the last is item 1 of
CLAUDE.md's Current Priorities, to be applied "through the authorized
maintenance procedure". So the repository already runs two migration
mechanisms, and already routes the riskier changes away from the HTTP endpoint.

There is **no version tracking**: no `schema_migrations` table, nothing
recording which of those files has been applied where. Idempotency is relied
upon instead, which works for `ADD COLUMN IF NOT EXISTS` and does not work for
a type conversion.

This matters for the decision: moving schema changes off HTTP is not a new
architecture to invent. It is formalising the mechanism already in use, and
giving it the version tracking it currently lacks.

## Options

### Option A — Keep the HTTP endpoint, harden it

Add `POST`-only, an Origin check, a CSRF token, a rate limit, a transaction
where possible, and redacted errors.

- **Security:** closes risks 1–5. Leaves risk 6 **untouched.**
- **Complexity / cost:** lowest. No credential or ownership change.
- **Vercel / PostgreSQL:** no change.
- **Recovery:** unchanged; the auth-repair path survives as-is.
- **Banking readiness:** **fails the objective.** The application keeps
  ownership of every table, so audit rows remain modifiable with the
  application's own credential and 0004's Layer 1 can never land. It also
  leaves a public internet endpoint whose success condition is "arbitrary DDL
  ran against the production database", which is difficult to defend to a
  sponsor bank however well authenticated.

Rejected as the end state. **Parts of it are still worth doing now** — see the
sequence below.

### Option B — Separate runtime and migration credentials, keep a restricted mechanism

Two roles. `manna_app` (runtime) owns nothing, holds DML on business tables,
`INSERT, SELECT` only on the audit tables, and `USAGE, SELECT` on every
sequence — without which inserts into `SERIAL`-keyed tables fail outright. `manna_migrator` owns the objects and
is used *only* by a migration runner that is not publicly reachable. The narrow
`auth-repair` allowlist is retained as a separately gated break-glass.

- **Security:** closes risk 6, which is the one that blocks everything else,
  and removes DDL capability from the internet-facing credential entirely.
- **Complexity / cost:** moderate. One new role, a `GRANT` inventory, a
  `DATABASE_URL` change, and a runner. **No new vendor:** GitHub Actions is
  already in use and already holds secrets; `workflow_dispatch` gives an
  audited, human-triggered, non-public invocation.
- **Vercel / PostgreSQL:** compatible. Supabase is reachable from Actions with
  credentials. Vercel never needs DDL.
- **Recovery:** preserved deliberately — see the lockout discussion below.
- **Banking readiness:** this is the posture that supports least privilege and
  separation of duties.

### Option C — Remove the endpoint; migrations only via deployment/maintenance

As B, but with no HTTP migration surface at all, including no `auth-repair`.

- **Security:** strongest.
- **Recovery:** **this is where it breaks.** The `auth-repair` path exists
  because Release 1.0 shipped code reading `users.token_version` before the
  column existed; login and registration both failed, so no cookie could be
  obtained, so no authenticated endpoint could fix it — production was locked
  out until an `ALTER` was run by hand. Removing the path reintroduces that
  class of outage, and its recovery then depends entirely on an operator having
  working direct database access at the moment it happens. That is a reasonable
  posture *if* direct access is reliable and rehearsed, and a bad one if it is
  assumed.

Not recommended as a first step. It becomes the right end state once the
break-glass is proven out-of-band.

## Recommendation

**Option B**, implemented so that it is Option C for everything except a
deliberately narrow break-glass.

Concretely:

1. Schema changes run from a **`workflow_dispatch` GitHub Actions job** using
   `manna_migrator` from a repository secret. Not publicly reachable, requires
   a GitHub identity, and is logged by Actions.
2. `/api/migrate` keeps **only** the `auth-repair` allowlist — the two columns
   authentication reads — and loses the full pipeline. Risk 6 disappears from
   the app credential, because `ALTER TABLE users ADD COLUMN` on a table the app
   does not own will not run; that path therefore also moves to the migrator
   credential, obtained by the runner, with the HTTP route reduced to
   *requesting* a repair rather than performing one. If that indirection proves
   more machinery than the outage it prevents, the honest alternative is Option
   C plus a rehearsed direct-access runbook, and that is the owner's call.
3. Apply Option A's hardening to whatever HTTP surface remains, since it is
   cheap and independent: `POST`, Origin check, rate limit, redacted errors.

This is the smallest architecture that leaves the production application with
no DDL capability and no ability to modify audit rows.

## Transition sequence

Ordered so that each step is independently reversible and nothing depends on an
unrehearsed one.

**Phase 0 — evidence and safety.** Verify a restorable backup of production by
performing a restore into a scratch database and running
`scripts/verify-migrate.sql` against it. A backup that has never been restored
is not a backup. **Blocks everything else.**

**Phase 1 — HTTP hardening (safe now, no credential change).** `POST`-only plus
Origin check, a rate limit on the operator path, redacted errors. Invert the
corresponding assertions in `migrate-route-security.test.ts`. Reversible by
revert.

**Phase 2 — migration versioning.** A `schema_migrations` table and a runner
that records what it applied. Needed before splitting credentials, because
otherwise nothing can say whether a given database is current — and the three
files in `migrations/` are already in that position.

**Phase 3 — the `workflow_dispatch` runner**, using the migrator credential,
validated against a restored copy from Phase 0. The route still works at this
point, so there is no window where neither mechanism functions.

**Phase 4 — ownership and grants.** This phase has a strict internal order,
because getting it wrong takes production down. An earlier draft of this record
put `REASSIGN OWNED` first and the `DATABASE_URL` switch in Phase 5, which
opens an outage window between them. Measured:

```
r_old owns t          → SELECT count(*) FROM t   → 1
REASSIGN OWNED BY r_old TO r_new
r_old (still the app's credential) → SELECT  → ERROR: permission denied for table t
                                   → INSERT  → ERROR: permission denied for table t
```

Ownership was granting the application everything **implicitly**. The moment it
moves, a role holding no explicit grants has no access at all — so the live
application would start failing every query while still pointed at the old
credential.

### Pre-granting to the old role does not work, and this is the trap

The obvious repair is to grant the old role its privileges explicitly *before*
reassigning. **It has no effect**, because the owner's ACL entry already
contains every privilege, so the grant adds nothing distinguishable, and
`REASSIGN OWNED` replaces that entry wholesale. Measured, granting to the owner
both as itself and from a superuser:

```
GRANT SELECT, INSERT, UPDATE, DELETE ON t TO r_old   (r_old is the owner)
relacl before reassign  →  {r_old=arwdDxt/r_old}      ← the grant added nothing
REASSIGN OWNED BY r_old TO r_new
relacl after reassign   →  {r_new=arwdDxt/r_new}      ← old entry replaced
r_old SELECT → ERROR: permission denied for table t
r_old INSERT → ERROR: permission denied for table t
```

An earlier revision of this record proposed exactly that pre-grant as the fix.
It was wrong, and it would have produced the same outage with one extra step
that did nothing. Privileges can only be granted to the old role **after** it
stops being the owner, because only then does a grant create a real ACL entry.

### What does work: reassign and re-grant in one transaction

PostgreSQL DDL is transactional, so both can commit together and **no window
exists and no maintenance pause is required.** Measured:

```sql
BEGIN;
  REASSIGN OWNED BY <old_role> TO manna_migrator;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <old_role>;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO <old_role>;
COMMIT;
```

```
relacl after  →  {r_new=arwdDxt/r_new,r_old=arwd/r_new}   ← a real, separate entry
r_old SELECT  →  1          r_old INSERT → succeeded
owner         →  r_new
```

The sub-steps therefore are:

- **4a.** Create `manna_app`. No grants yet.
- **4b.** In **one transaction**: `REASSIGN OWNED` to `manna_migrator`; grant the
  old `DATABASE_URL` role DML on business tables plus `USAGE, SELECT` on all
  sequences, so it keeps working unchanged; grant `manna_app` the same set plus
  `INSERT, SELECT` on the audit tables and nothing more.
- **4c.** `ALTER DEFAULT PRIVILEGES FOR ROLE manna_migrator IN SCHEMA public`
  for both `TABLES` and `SEQUENCES`, so objects created later inherit the grants
  instead of silently coming back inaccessible.
- **4d.** Verify the application still works on the old credential before
  touching `DATABASE_URL`.
- **4e.** Revoke the old role's grants only once the **rollback window has
  closed** — not merely once Phase 5 has succeeded. Until then they are what
  makes the Phase 5 rollback viable.

**Sequence privileges are not optional.** Every `SERIAL` column is backed by a
sequence, and the application omits those `id` columns on insert, so it calls
`nextval()`. Measured:

```
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ... TO r_app
r_app: INSERT INTO t (v) VALUES (...)   → ERROR: permission denied for sequence t_id_seq
GRANT USAGE, SELECT ON ALL SEQUENCES ... TO r_app
r_app: INSERT INTO t (v) VALUES (...)   → INSERT 0 1
```

Table grants alone leave every insert failing. `GRANT USAGE, SELECT ON ALL
SEQUENCES IN SCHEMA public` plus the default-privileges entry in 4d are both
required.

Rehearse the whole phase on the Phase 0 restored copy and enumerate every grant
by running the test suite against it — the grant list above is derived from the
schema, not from having watched the application fail, so treat it as a starting
point rather than complete.

### Two different rollbacks, which are easy to conflate

- **Rolling back Phase 5** (the credential switch) means pointing
  `DATABASE_URL` at the old role again. It works **only while 4b's grants to
  that role persist** — hence 4e's ordering. It does **not** restore ownership,
  and it does not need to: the application never needed ownership, only the
  grants.
- **Rolling back Phase 4** (the ownership move) is a separate, larger
  operation: `REASSIGN OWNED BY manna_migrator TO <old_role>`, or
  `ALTER TABLE ... OWNER TO` per object. This is required if the migration
  runner itself must go back to the old credential, because `ALTER TABLE` is
  owner-only — a grant-only rollback leaves the runner failing with
  `must be owner`, which reads as a new fault rather than an incomplete
  rollback.

Stating both matters because the cheap rollback (revert an environment
variable) does not undo the expensive change, and someone reaching for it
during an incident needs to know which problem it actually solves.

**Phase 5 — switch `DATABASE_URL`** to `manna_app`. Reversible by reverting the
environment variable, subject to the ordering constraint above.

**Phase 6 — audit immutability**, per 0004: the two triggers first (independent
of all the above, so they could in fact land at any point), then the
non-owning-role guarantee, which only becomes true after Phase 5.

### Rehearsal status

**Not rehearsed against production data.** This environment has no access to a
production copy, and customer data must not be placed in an insecure test
environment. Specifically **not run**:

- restore-from-backup verification (Phase 0)
- grant enumeration against a populated production-shaped database
- the full 103-statement route run to a failure on such a database
- whether `x-real-ip` is overwritten by Vercel's proxy

What *was* run is in the test file: the authorization matrix, the GET-only
surface, the missing operator rate limit, the absence of CSRF checks, and
non-atomicity on a disposable database.

## Audit immutability ordering (from 0004)

| Step | Depends on | Can start now? |
|---|---|---|
| Row trigger (`UPDATE`/`DELETE`) + **statement trigger (`TRUNCATE`)** | nothing | **Yes** |
| Non-owning app role | Phases 0–5 | No |
| Hash chaining | external anchor | No |

Both triggers are required, not one. Measured in 0004: with only the row
trigger, the owner's `TRUNCATE` succeeded and silently emptied the table,
because row-level triggers do not fire on `TRUNCATE`. One function serves both,
since it raises for every `TG_OP`.

The application role must keep `INSERT` on the audit tables, so a compromised
application can still append fabricated records. Privilege separation protects
the integrity of existing rows, not the authenticity of new ones, and no layer
proposed here addresses forgery. **No protection against a privileged operator
is claimed**, because that requires evidence storage outside the operator's
control, which does not exist.

## Alternatives rejected

**A migration framework (Prisma Migrate, node-pg-migrate, Flyway).** Not now.
The repository has no ORM by deliberate choice, and the problem to solve is
*which credential runs DDL from where*, not how DDL is authored. A framework
would add a dependency and a lockfile surface while leaving the credential
question exactly as it is. Revisit once Phase 2's version table exists and the
cost is a comparison rather than a guess.

**Supabase migration tooling.** Viable and worth evaluating at Phase 3, since
it is already the database vendor. Not chosen here because it was not tested
from this environment and the Actions runner needs no new vendor relationship.

**Leaving DDL in the app and relying on triggers alone for audit immutability.**
Rejected: the owner can `DISABLE TRIGGER`, and under Option A the app *is* the
owner, so the control would be one statement from being switched off by the
same credential it is meant to constrain.
