# CLAUDE.md — Manna App

> Load this file at the start of every Claude Code session. It is the single authoritative reference for the Manna codebase — covering architecture, conventions, known issues, and immediate priorities.

---

## Project Overview

Manna is a peer-to-peer payment application for cross-border money transfers between Canada and the United States. Users register with a country (CA or US), receive a $100 seed balance in their local currency (CAD or USD), and can send or request money from other users by username. Cross-border transfers use live FX rates from the Wise API. Bank accounts are linked via Plaid. The social feed shows public transactions across all users.

**Live URL:** https://carloscab74.vercel.app  
**Repository:** https://github.com/Carl-cab/carls-way  
**Stack:** Next.js 16 · React 19 · TypeScript 5 · Tailwind CSS 4 · Supabase PostgreSQL · Vercel

---

## Architecture Summary

The application is a Next.js 16 full-stack app using the App Router. There is no separate backend service — all server-side logic runs as Next.js API Routes (serverless functions on Vercel). The frontend and backend share the same repository.

```
Client (React 19)
    └── Next.js Middleware (proxy.ts)  ← JWT auth guard
        └── API Routes (/app/api/)     ← Business logic
            ├── Supabase PostgreSQL    ← Primary datastore (postgres.js, no ORM)
            ├── Plaid API              ← Bank account linking
            └── Wise API               ← Live FX rates
```

**Route Groups:**
- `app/(auth)/` — Public pages: `/login`, `/register`
- `app/(app)/` — Authenticated pages: `/feed`, `/send`, `/request`, `/history`, `/profile`, `/friends`
- `app/api/` — All backend endpoints

**Key Library Files:**

| File | Responsibility |
|---|---|
| `lib/db.ts` | `postgres.js` connection singleton and `initializeSchema()` |
| `lib/auth.ts` | JWT helpers, `getAuthUser()`, velocity limits, audit logging |
| `lib/fx.ts` | Wise API integration, FX rate caching, `buildFxQuote()` |
| `lib/plaid.ts` | Plaid client configuration and `requireEncryptedBankToken()` helper |
| `lib/stripe.ts` | Stripe client singleton (`getStripe()`) and `isStripeLive()` sandbox/live KYC gate |
| `lib/encryption.ts` | AES-256-GCM `encryptToken`/`decryptToken` helpers for Plaid access tokens |
| `lib/jsonb.ts` | `jsonbParam()` for binding a `jsonb` parameter and `readJsonbRecord()` for reading a column that may hold a legacy string scalar — see the JSONB rule under Coding Standards |
| `lib/ledger.ts` | Passive audit ledger helpers: `createLedgerEntry()`, `createLedgerPair()`, `getLedgerBalance()`, `backfillOpeningBalances()` |
| `lib/provider-events.ts` | Webhook event deduplication: `recordProviderEvent()`, `hasProcessedProviderEvent()`, `markProviderEventProcessed()`, `markProviderEventFailed()` |
| `lib/providers/TransferProvider.ts` | Core `TransferProvider` interface — all 7 methods each provider must implement |
| `lib/providers/TransferProviderFactory.ts` | Central provider selection logic — no other code should select providers |
| `lib/providers/SandboxUSProvider.ts` | US sandbox provider — simulates Plaid Transfer ACH, no real API calls |
| `lib/providers/SandboxCAProvider.ts` | CA sandbox provider — simulates Canadian EFT, no real API calls |
| `lib/providers/PlaidTransferProvider.ts` | US live ACH via Plaid Transfer — IMPLEMENTED, gated behind `PLAID_TRANSFER_LIVE` (default off). Never mutates balances. |
| `lib/providers/CanadianEFTProvider.ts` | CA live EFT via Stripe ACSS — IMPLEMENTED, gated behind `CA_EFT_LIVE` (default off). Never mutates balances. |
| `lib/settlement/types.ts` | Settlement event types, outcome objects, transition rules |
| `lib/settlement/settlement-rules.ts` | State transition validators and terminal/processing state checkers |
| `lib/settlement/SettlementProcessor.ts` | Core settlement processor — validates transitions, prepares outcomes, no balance mutations |
| `lib/settlement/SettlementOrchestrator.ts` | Settlement orchestrator — queries intents, plans outcomes, no side effects (pure planning); passes provider/provider_event_id for idempotency |
| `lib/settlement/SettlementExecutor.ts` | Settlement executor — executes settlement plans; Phase B3.1 status transitions, B3.2a ledger entries, B3.2b balance updates; all idempotent |
| `lib/transfers/router.ts` | Compatibility layer — re-exports from `lib/providers/TransferProviderFactory` (DEPRECATED) |
| `proxy.ts` | Next.js middleware — enforces auth on all `(app)` routes |
| `lib/environment.ts` | Sandbox/live gate. `MANNA_ENV=sandbox` spelled exactly, and `VERCEL_ENV=production` overrides it — no value of `MANNA_ENV` can weaken a production deploy |
| `lib/plaid-env.ts` | The single resolver for which Plaid host this process talks to. Fails closed: unset or unrecognised `PLAID_ENV` is sandbox. The client and the webhook verifier both call it, because they once defaulted to opposite hosts |
| `lib/plaid-error.ts` | `redactedErrorLog()` — the only object that may be passed to a logger from a provider catch. Allowlist-built, so `PLAID-SECRET` and `PLAID-CLIENT-ID` headers on an Axios error cannot reach a log |
| `lib/plaid-credentials.ts` | Trims Plaid credentials and logs their shape, never their value |
| `lib/settlement/handle-plaid-settlement.ts` | Plaid webhook → settlement plan |
| `lib/settlement/plaid-event-adapter.ts` | Maps Plaid Transfer event types onto settlement events |
| `lib/settlement/plaid-transfer-event-sync.ts` | Syncs Plaid Transfer events from a persisted cursor (`plaid_transfer_event_cursors`) |
| `lib/settlement/handle-stripe-settlement.ts` | Stripe webhook → settlement plan |
| `lib/webhooks/dlq.ts` | Dead-letter queue reads and requeue |
| `lib/internal-reconciliation.ts` | Balance/ledger reconciliation checks, run by the cron route |
| `lib/repositories/BaseRepository.ts` | Repository base. `exists()`/`count()` take a `sql` **fragment**, never a condition string — see the note under Coding Standards |
| `lib/rate-limit.ts` | Fixed-window limits per endpoint class; Redis when `REDIS_URL` is set, in-process otherwise |
| `scripts/verify-migrate.sql` | Read-only check that `/api/migrate` applied everything code reads. Safe against production |
| `lib/migrations/types.ts` | Migration versioning types. Carries the distinction the whole mechanism rests on: **detecting an end state is not knowing it ran**, which is why `baseline_detected` and `applied` are different statuses |
| `lib/migrations/registry.ts` | The three authorization-gated `migrations/*.sql` files, each with a read-only catalogue probe for its end state. Reuses `MONEY_COLUMNS` from `lib/db.ts` rather than restating it. The ~103 statements in the migrate route are deliberately **not** entries — they are a convergent reconciler, not versioned migrations |
| `lib/migrations/tracking.ts` | `schema_migrations` reads and writes: advisory-lock concurrency (`pg_try_advisory_lock`, refuses rather than queues), `partial`-before-work so a crash leaves evidence, drift detection by checksum, `adoptBaseline()`, and `describeState()` which answers "is this database current?". **Contains no `apply()` — executing migrations is Phase 3** |
| `scripts/reconciliation-check.sql` | The same reconciliation query `lib/internal-reconciliation.ts` runs, as a psql-runnable file, because that module has no CLI entry point and its cron route must not be pointed at a restore target. A **second source of one query**, so `lib/__tests__/reconciliation-sql-parity.test.ts` requires both to produce identical names, counts and statuses. Edit the two together. All seven rows must report `PASS` — and note `completed_internal_payments_in_scope` is a scope counter hardcoded `'PASS'`, not an invariant |
| `.gitleaks.toml` | Secret-scanning config. The allowlist is keyed on the exact synthetic literal, never a path — a path exemption would also hide a real credential pasted into that file later |
| `.github/workflows/codeql.yml` | CodeQL SAST, kept separate from `ci.yml` so `security-events: write` is not granted to the job running the test suite |

---

## Coding Standards

**TypeScript** is used throughout. All new files must be `.ts` or `.tsx`. Avoid `any` types; define interfaces for all API request and response shapes.

One documented exception: `scripts/status/report.mjs` is plain ESM. It was
`.ts` run through `tsx` and failed CI with `tsx: not found` — `npx` fetches on
demand locally, while CI installs `--frozen-lockfile` from declared
dependencies only. Both ways to keep `.ts` cost something: adding `tsx` pulls a
build toolchain in to render a Markdown table, and Node's native type stripping
needs 22.6+ while **CI pins Node 20**, so that route passes locally and fails
in CI. The script's inputs are git output, a JSON file and argv strings, so it
has no type surface worth the dependency. A new **ops script** with no type
surface may follow it; application code may not.

**Styling** uses Tailwind CSS utility classes exclusively. Do not write custom CSS outside of `app/globals.css`. The design language uses `blue-700` as the primary brand color. Red is
reserved for semantic meaning only — errors, failed and returned transfer
states, insufficient-balance warnings — so a red element should mean
something is wrong, never merely that it is prominent.

**Components** are Server Components by default. Add `'use client'` only when React hooks (`useState`, `useEffect`, etc.) or browser event listeners are required.

**API routes** must follow this response contract:
- Errors: `NextResponse.json({ error: 'Human-readable message' }, { status: 4xx })`
- Success mutations: `NextResponse.json({ success: true, ...data }, { status: 200 | 201 })`
- Always wrap route handlers in `try/catch` and return a 500 on unexpected errors.

**Database queries** must use the `postgres.js` tagged template literal syntax to prevent SQL injection:
```ts
// Correct
const rows = await sql`SELECT * FROM users WHERE id = ${userId}`;

// Never do this
const rows = await sql.unsafe(`SELECT * FROM users WHERE id = ${userId}`);
```

This applies to **helpers that accept part of a query** too. A helper taking a
`condition: string` can only be called by concatenating SQL, so it recreates the
hole one layer down. `BaseRepository.exists()`/`count()` did exactly that, and
five callers interpolated into them — three with request-shaped values. Because
`sql.unsafe` executes stacked statements, that was arbitrary SQL, not merely a
boolean oracle. Both now take a `sql` fragment, so the unsafe shape no longer
compiles:

```ts
// Correct
this.exists('users', this.sql`email = ${email.toLowerCase()}`);

// Never do this — the value cannot be bound, only concatenated
this.exists('users', `email = '${email.toLowerCase()}'`);
```

A table or column name is an identifier and cannot be a bound parameter; pass it
through `sql(name)`, which quotes it.

**JSONB columns** take a document, never stringified text. `JSON.stringify(v)`
bound to a `jsonb` column stores a jsonb **string scalar**, so `jsonb_typeof`
is `'string'` and every `->>`, `#>>`, `@>` and index lookup silently returns
NULL or no rows — no error anywhere. Adding a `::jsonb` cast does **not** fix
it. Use `jsonbParam()` from `lib/jsonb.ts`:

```ts
// Correct
VALUES (${userId}, ${action}, ${jsonbParam(sql, metadata)})

// Never do this — stores '"{\"ip\":\"1.2.3.4\"}"', and metadata->>'ip' is NULL
VALUES (${userId}, ${action}, ${metadata ? JSON.stringify(metadata) : null})
```

Both audit writers did this, and it was invisible because the paired reader
`JSON.parse`d the scalar back — application reads were correct while the column
was unqueryable. A reader of a column that may still hold legacy rows must use
`readJsonbRecord()`; a bare `JSON.parse` on a corrected row throws
`SyntaxError`.

**Copying one `jsonb` column into another is the trap that outlives the writer
fix.** `postgres.js` returns the source as an object, so the natural
`JSON.stringify(row.col)` plus `::jsonb` re-creates the string scalar even
though both ends are correct. This is how `webhook_dead_letters.raw_payload`
was double-encoded long after the `provider_webhook_events` writers had been
fixed — and it silently turned a NULL payload into the jsonb `null` literal
too. Bind the source value as is with `jsonbParam()`.

**Do not "repair" the source shape while copying.** It looks like a free fix
and it is not. `lib/webhooks/replay.ts` claims a dead letter only when
`dl.raw_payload IS NOT DISTINCT FROM e.raw_payload`, deliberately, so a corrupt
row cannot be replayed under another event — and that equality is between the
two *stored* representations. Normalising one side makes a legacy event
**unreplayable**: the claim matches nothing and the caller sees
`not_found_or_already_replayed` instead of reaching recovery. Measured. The
same caution applies to any copy whose two sides are later compared.

See `docs/decisions/0002-normalize-audit-jsonb-additively.md`.

**Authentication** in API routes always starts with:
```ts
const user = await getAuthUser();
if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
```

**Currency logic** — always determine the user's currency from their `country` field, never assume:
```ts
const currency = user.country === 'US' ? 'USD' : 'CAD';
```

---

## Development Workflow

**Local setup:**
```bash
git clone https://github.com/Carl-cab/carls-way.git
cd carls-way
pnpm install
# Create .env.local with all required variables (see Deployment Notes)
pnpm dev
```

**Package manager: pnpm, and only pnpm.** `pnpm-lock.yaml` is the single
lockfile; `package-lock.json` was removed because carrying both meant CI
validated one while Vercel built from the other, and deploys broke silently
for weeks when they drifted apart. Vercel and CI both run
`pnpm install --frozen-lockfile`, so a `package.json` change that forgets to
update the lockfile fails in CI instead of at deploy time. Never add an npm or
yarn lockfile back.

**Branching:** Feature branches off `master`. The `documentation/handoff-package` branch contains all handoff docs. Vercel auto-deploys on every push to `master`.

**Schema changes:** When adding a table or column, update **three** places:
1. `lib/db.ts` → `initializeSchema()` — so fresh environments get it on first boot.
2. `app/api/migrate/route.ts` → `ALTER TABLE … ADD COLUMN IF NOT EXISTS` or
   `CREATE TABLE IF NOT EXISTS` — so the live production database gets it.
3. `lib/__tests__/helpers/test-schema.sql` — so CI's clean database has it.

Missing any one of these has caused five separate production or CI incidents:
`users.token_version` (broke production login until the ALTER was run by hand),
the C1.4 dead-letter columns (the webhook *error* handler raised 42703 while
recording a failure, so events never left `received` and the provider
redelivered forever), `correlation_id` on four tables (`transactions` was in no
source at all, so the settlement trace endpoints raised 42703 everywhere), six
tables absent from the test fixture, and 21 columns plus the whole admin RBAC
surface absent from `lib/db.ts`. Add the object to `scripts/verify-migrate.sql`
too if application code reads it unguarded.

After deploying, call `POST /api/migrate` once (authenticated) to apply the
migration to production. **It is POST, not GET** — a state-changing GET was
reachable by CSRF; see `docs/decisions/0005-migration-privilege-separation.md`.
`GET` answers 405 with a pointer rather than failing silently.

**Tests:** `pnpm test` (vitest) runs the suite in `lib/__tests__`. **57 files /
821 tests** as of this writing, and the suite is expected to stay fully green.
That count was stale at "51 files / 735 tests" for several changes; it is a
number worth keeping current precisely because it is the thing a reader checks
a run against.
Several files run against a real PostgreSQL instance rather than a mock,
because the defects they cover were mismatches between SQL in the app and the
actual schema — exactly what a hand-written fake cannot catch. Set
`DATABASE_URL` to a scratch database before running them, and prefer a
genuinely fresh one: reusing a database that an earlier run already migrated
has twice hidden a failure that CI then found on a clean one. **A fresh
database is not enough on its own** — apply the fixture first, exactly as
`.github/workflows/ci.yml` does in its "Prepare test schema" step:

```bash
createdb manna_scratch
psql "postgres://…/manna_scratch" -f lib/__tests__/helpers/test-schema.sql
DATABASE_URL="postgres://…/manna_scratch?sslmode=disable" pnpm test
```

Skip the fixture and four files fail on seeded rows they did not create —
`audit.test.ts` first, on
`admin_audit_logs_admin_user_id_fkey` — which reads like a regression and is
not one. And `?sslmode=disable` is required for a local server:
`resolveSslMode()` in `lib/db.ts` defaults to `'require'` for every URL that
does not ask otherwise, so without it every DB-backed file fails with
`Client network socket disconnected before secure TLS connection was
established`. Both were learned by hitting them. A test that
**mutates schema** must use a disposable database, not the shared one, and
restoring the object afterwards is not good enough: vitest runs files in
parallel, so the window where the object is missing is a race, not an ordering
problem. Measured — dropping `idx_transfer_intents_correlation_id` from the
shared database to exercise a detection probe broke
`stripe-settlement.test.ts`, which depends on that uniqueness guarantee.
`migrate-route-security.test.ts` and `migration-versioning.test.ts` both carry
the pattern: a uniquely named database, created and dropped per invocation. Also available:
`pnpm run typecheck` and `pnpm run lint` (0 errors; ~28 unused-variable
warnings are tolerated).

`lib/__tests__/migrate-route-execution.test.ts` runs the real
`POST /api/migrate` handler with the real database layer, so the statements that
production depends on are executed rather than only parsed. Before it existed,
changing one statement to `ADD COLUM` left typecheck clean and all 735 tests
passing — the failure would have surfaced only when an operator ran the endpoint
against production. Its declaration check is deliberately **static**, compared
against `scripts/verify-migrate.sql`: a catalogue check cannot detect a removed
statement, because the fixture and `initializeSchema()` create the same tables
regardless. See `docs/decisions/0001-execute-the-migration-in-ci.md`.

`lib/__tests__/schema-source-parity.test.ts` enforces the two-source rule
below mechanically: it parses every object `app/api/migrate/route.ts`
guarantees and requires all of them on a database built by
`initializeSchema()` alone, comparing declared column types as well as
presence. It checks one direction only — the migrate route is the authority on
what the live database holds — so an object added to `lib/db.ts` and *not* to
the route is still yours to catch by hand.

---

## Documentation Governance

Four files carry different kinds of truth, and conflating them is how a session
ends up acting on a stale claim:

| File | Holds | Rule |
|---|---|---|
| `CLAUDE.md` | Engineering instruction | Must match the tree. Correct it in place when the code moves |
| `CURRENT_STATUS.md` | Verified current state | Carries the commit it was verified against |
| `PROJECT_MEMORY.md` | Chronological record | Append-only. Correct an old entry by appending, never by editing history |
| `PRODUCTION_READINESS_BACKLOG.md` | Prioritized backlog | Re-mark an item only when a change verifies it, naming the evidence |

Plus `docs/audits/<date>-<topic>.md` for dated, command-level audit evidence and
`docs/decisions/NNNN-<slug>.md` for architectural decisions.

A material change appends a `PROJECT_MEMORY.md` entry naming: purpose and scope;
financial or security behaviour affected; tests run and their results; commit
SHA and PR; migration impact; unresolved findings; rollback requirement; next
recommended action.

Two habits this repo has learned the hard way. **Do not re-mark completion state
from memory** — reconstructing 686 lines of backlog status without re-verifying
manufactures exactly the false confidence the audit record exists to prevent;
mark the file stale and point at the evidence instead. And **a stale date on
current content is worse than an obviously old file**, because it invites trust:
`CURRENT_STATUS.md` read "2026-06-28" for months while its body was being
revised.

---

## Known Issues

The issues this section used to list (request acceptance legacy balance, Plaid
plaintext tokens, non-functional Activity filter chips, frontend password
validation mismatch) are fixed; see `PROJECT_MEMORY.md`. Open items now live
under **Known gaps, deliberately open** at the end of Current Priorities, so
there is one place to look rather than two.

---

## Transfer Provider Architecture

Transfers use a provider abstraction in `lib/providers/`. All providers
implement `TransferProvider` (`lib/providers/TransferProvider.ts`) and selection
happens only in `lib/providers/TransferProviderFactory.ts`. `lib/transfers/` is
a deprecated compatibility layer that re-exports from it — do not add to it:

- US users (`country = 'US'`) → `SandboxUSProvider`, or `PlaidTransferProvider` when `PLAID_TRANSFER_LIVE` is set
- CA users (`country = 'CA'`) → `SandboxCAProvider`, or `CanadianEFTProvider` when `CA_EFT_LIVE` is set

Both live providers are implemented and both flags default off. Selection is
made only in `lib/providers/TransferProviderFactory.ts`.

**Transfer flow (3 steps):**
1. `POST /api/transfers/intent` — creates `status='draft'`, routes to correct provider
2. `GET /api/transfers/[id]/review` — returns review details + region-appropriate consent language
3. `POST /api/transfers/[id]/confirm` — records `consent_confirmed_at`, then settles: the sandbox provider credits (add_money) / debits (cash_out) the platform balance and writes a ledger entry, setting `status='settled'`
4. `POST /api/transfers/[id]/execute` — **live only.** Submits a `ready` live
   intent to its provider: `ready → submitting → processing`, then a webhook
   settles it. Sandbox intents settle at confirm and are refused here. Two gates
   sit in front of the provider call: the row must be `execution_mode='live'`
   and `status='ready'`, and the factory must actually return a live provider —
   with the flags off it returns sandbox and the route refuses *before*
   claiming, so a disabled rail cannot strand an intent in `submitting`. Rate
   limited per user id (`money:transfer-execute`), because the claim stops one
   intent being submitted twice but says nothing about how many separate
   intents one account can push at a rail.

**Rules:**
- Both sandbox providers are execution_mode='sandbox' — no real bank/external API calls
- `executeTransfer()` throws on both sandbox providers — prevents accidental live calls
- Velocity is checked at intent creation but only recorded at confirm (future: at execute)
- Sandbox `confirmTransfer()` settles the platform balance atomically via `lib/providers/sandbox-settlement.ts` — the ONLY transfer path allowed to mutate a balance, and only while `execution_mode='sandbox'`. Live providers will move balances through the settlement engine instead.
- CA users see "Canadian transfer simulation" language — never ACH language
- US users see "US transfer simulation" language

**To add a live provider:** implement `TransferProvider` and select it from
`TransferProviderFactory` behind an env-gated condition. The interface and API
routes do not change.

**Live execution safety.** Both live providers persist a stable idempotency
key derived from the intent id *before* calling the provider, and claim the
intent inside a transaction with `SELECT ... FOR UPDATE`. The lock serialises
the claim; it is the idempotency key, not the lock, that guarantees a single
debit — a caller that finds `status='submitting'` with no reference recorded
deliberately retries, because that state is indistinguishable from a crash
between the provider call and the local write.

Two things make `submitting` recoverable rather than terminal. The transition
rules in `lib/settlement/settlement-rules.ts` allow `submitting → settled |
failed | cancelled` for webhook actors, so a webhook that outruns the local
reference write still lands. And `reconcileTransfer()` replays the provider
authorization; where no authorization was ever persisted it concludes the
provider was never asked to move money and returns the intent to `ready`, which
is what makes the execute route's `ready`-only rule safe rather than a trap.
Recovery is admin-only, through `POST /api/admin/transfers/[id]/reconcile`.

Live providers signal a **successful** submit by throwing an error carrying
`__submitted`, after recording `processing` themselves. Success therefore
travels on the error channel; a catch block that swallows errors broadly will
silently lose a submitted transfer.

## Current Priorities

`/api/migrate` has been run against production, so the Release 0.95 item that
used to head this list is done. What remains before any real rail carries
money:

1. **Apply the early-webhook correlation index migration** through the
   authorized maintenance procedure. Deliberately *not* part of
   `/api/migrate`.
2. **Operational proof.** Production cron and `CRON_SECRET`, Redis backend
   verification, a dead-letter replay drill, an unknown-outcome reconciliation
   drill, named alert ownership, escalation evidence.
3. **Business and provider approvals.** Provider product eligibility,
   compliance/KYC/consent, FBO and treasury funding with reserve controls,
   staff-controlled test accounts, two-person approval, and a one-rail-at-a-time
   US$1/CA$1 test window.
4. **Enable `PlaidTransferProvider`** — implemented; needs Plaid products
   updated to include Transfer, then `PLAID_TRANSFER_LIVE=true`.
5. **Enable `CanadianEFTProvider`** — implemented; needs live Stripe ACSS
   credentials, then `CA_EFT_LIVE=true`.

**Cash-out remains blocked.** The recipient-owned destination, disbursement
accounting, ownership validation, provider capability and return/reversal
architecture are design-only, and must not be built on the current platform
payout scaffold. Never treat `stripe.payouts.create` as a payment to an
arbitrary end user.

### Known gaps, deliberately open

- `AdminAuditService.verifyImmutability()` returns a hardcoded
  `verification_status: 'clean'` with `total_logs_checked: 0`. Nothing calls
  it, so no path trusts the false answer. A real implementation exists at
  `lib/rbac/AuditLogRepository.ts:359`, but it compares `COUNT(*)` to
  `MAX(id)` — it detects deletes, not updates. Deleting the stub or
  implementing it is a judgement call about what immutability should assert.
- **Nothing enforces audit immutability.** Measured on a database built from
  the schema sources: no trigger, no rewrite rule, no RLS (`relrowsecurity =
  f` on both audit tables), no `REVOKE` in any schema source, no hash chaining.
  The application's single DB role can `UPDATE` and `DELETE` audit rows with no
  residue. Append-only is a convention here, so do not claim tamper resistance.
  `docs/decisions/0004-append-only-audit-architecture.md` sets out what would
  change that, with each layer's effect measured and its limits stated. Two
  facts from it are worth carrying here because they are easy to get wrong: a
  `BEFORE UPDATE OR DELETE` **row** trigger does not fire on `TRUNCATE`, so a
  `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger is required as well (one
  function serves both, since it raises for every `TG_OP`); and the application
  must keep `INSERT`, so no proposed layer prevents a compromised application
  **appending fabricated** rows — privilege separation protects the integrity
  of existing rows, not the authenticity of new ones.
- **`/api/migrate`: Phase 1 hardening is applied; two weaknesses remain.**
  Fixed, with the assertions in
  `lib/__tests__/migrate-route-security.test.ts` inverted in the same change:
  **POST only** (`GET` answers 405 with a pointer), **Origin validated before
  authentication**, the **operator path rate limited**
  (`schema:migrate-operator`, 6/hour on admin id), and **errors redacted** to a
  reference that the log carries.
  An absent `Origin` is **allowed on purpose** — a browser always sends it on
  POST, so a request without one is not cross-site forgery, and requiring it
  would disable the command-line auth-repair break-glass. No CSRF token, for
  the same reason: no browser client exists to supply one. Changing either
  would create the lockout Release 1.0 already suffered.
  **Still open:** no transaction across the ~103 statements, so a failure
  leaves the schema between versions; and the route still requires table
  **ownership**, which is the coupling that blocks audit immutability and what
  Phases 2-5 of
  `docs/decisions/0005-migration-privilege-separation.md` exist to resolve.
  `clientIdentifier()` resolution is now `x-vercel-forwarded-for` →
  `x-real-ip` → rightmost `x-forwarded-for` hop, each validated as a
  syntactically plausible IP, with `clientIdentity()` reporting which header
  the value came from. **Which of those the platform actually sets — and
  therefore which a client cannot forge — remains unverified, not cleared.**
  `api.vercel.com` and the deployment host both answer `403 CONNECT` through
  the engineering environment's egress proxy, so Vercel's own documentation
  cannot be read from here, and third-party accounts contradict each other and
  the official docs. Validation narrows the key space from "any string a client
  sends" to "any string shaped like an IP"; it does **not** stop an attacker
  rotating valid addresses, and nothing should describe it as doing so. Read
  every limit keyed on this as "best effort per *apparent* client".
  `clientIdentity().source` narrows the question to a real request instead of
  documentation, but **does not answer it on its own**: a forged
  `x-vercel-forwarded-for` that the platform overwrote and one it passed
  through both report the same `source`. The deciding fact is whether the
  resolved `id` **equals** the value the client sent, so the observation is a
  forged distinctive value plus that equality as a boolean — never the address
  itself.
  The operator limit's strength depends on a backend that can degrade
  silently. `REDIS_URL` **is set in production** (owner-reported 2026-10-20,
  name only), so the counter is nominally the shared 6/hour. But
  `lib/rate-limit.ts` falls back to in-process counters on any Redis client or
  command failure, which makes it `6 × instances`. That difference IS
  caller-visible — `allowed` and `remaining` change, and a caller spreading
  requests across instances can exceed the nominal limit; what the fallback
  provides is **no explicit signal that the backend failed**. And it
  **latches**: `redisUnavailable`
  has no production reset path (both resets are test-only), so a degraded
  instance stays degraded until it recycles. The **raw exception** is deliberately
  not logged, because a Redis client error can embed the credential-bearing
  URL; a generic degradation line *is* emitted to stderr, so a signal exists
  but carries no detail. Read "6/hour" as "6/hour
  while Redis is answering", and prove the backend with
  `POST /api/admin/operations/redis-rate-limit` rather than inferring it from
  the variable being set — bearing in mind that a pass covers only the
  instance that served the request, because the backend state is module-level
  (see the `REDIS_URL` row). Without `REDIS_URL` at all it is `6 × instances`
  by construction. It is deliberately **not** fail-closed —
  refusing the migration whenever Redis is absent would make an optional
  variable a hard dependency of the only schema-migration path and of the
  command-line break-glass, which is the Release 1.0 lockout shape. The threat
  is an authenticated operator's runaway loop, not an anonymous attacker, so
  degrading to a weaker limit beats denying schema repair. A counter in
  PostgreSQL — which this endpoint always has, since it cannot run without
  `DATABASE_URL` — is the real fix, and needs a counter table created ahead of
  the migration that it limits, so it belongs with Phase 2.
- **Fail-closed by risk class is an open owner decision, with a
  recommendation.** When shared rate limiting is lost — Redis unreachable, or
  no usable client header — every bucket currently fails *open*: the request is
  served under a weaker or collapsed limit. Whether that is right depends on
  the bucket, and the two failure modes are not symmetrical:

  | Bucket | Key | On Redis loss | On header loss (`source: 'none'`) | Recommended |
  |---|---|---|---|---|
  | `auth:login` | `client:email` | `5 × instances` per email | still per-email | **leave fail-open** — a refusal locks out real users and the per-email key bounds the damage |
  | `auth:register` | client | `3 × instances` | **global 3/hour** | fail-open, but the collapse is an availability cliff worth alerting on |
  | `auth:password-reset` | client | `3 × instances` | **global 3/hour** | as above |
  | `money:send`, `money:split-pay`, `money:transfer-execute` | user id | `N × instances` | unaffected — keyed on the authenticated user | **owner decision, one policy for all three.** Refusing protects velocity limits; it also blocks customer payments during an infrastructure fault |
  | `schema:migrate-operator` | admin id | `6 × instances` | unaffected | leave fail-open — see the Release 1.0 lockout note above |
  | `schema:bootstrap` | client | `N × instances` | **global** — any anonymous caller can exhaust the break-glass for everyone | leave fail-open; refusing recreates the lockout this path exists to break |

  The money buckets are the only genuine dilemma, and it is a business
  judgement, not an engineering one: silently losing shared velocity protection
  versus refusing legitimate payments during a Redis outage. **Not implemented
  either way** — doing so unilaterally would either weaken a financial control
  or interrupt customers. The buckets keyed on an authenticated user id are
  unaffected by header loss, which narrows the question to Redis availability
  alone.

- Historical `provider_webhook_events.raw_payload` rows hold string scalars.
  **Both current writers are correct** (`recordProviderEvent` and
  `ProviderEventRepository` both use `sql.json`) — an earlier note here claimed
  the writer was still broken, which was wrong; the comment in
  `lib/external-settlement-reconciliation.ts` already said so. That query and
  `parseStoredStripeEvent` normalize both shapes, so historical rows are read,
  not rewritten. SQL-side access to a *historical* row still needs
  `#>> '{}'`.
- Historical audit rows written before the jsonb fix remain string scalars.
  They are evidence and are deliberately not rewritten, so `readJsonbRecord()`
  keeps its legacy branch for as long as those rows are retained.
- The schema-parity test type-checks only `ALTER`-added columns. A type
  mismatch on a column declared inside a `CREATE TABLE` body in the migrate
  route would not be caught.
- `ADD COLUMN IF NOT EXISTS` never alters an existing column's type, so no
  schema source can correct a width or precision mismatch. That needs a
  dedicated migration under the maintenance procedure — which is why
  `migrations/20261003_widen_transactions_cross_border_amounts.sql` exists.

---

## Important Commands

```bash
# Start local dev server
pnpm dev

# Build for production (also runs by Vercel on deploy)
pnpm run build

# Lint the codebase
pnpm run lint

# Run schema migration on production (call this after deploying schema changes)
curl -X POST -b <auth-cookie> https://carloscab74.vercel.app/api/migrate

# Test the FX quote endpoint
curl -s -X POST https://carloscab74.vercel.app/api/fx/quote \
  -H "Content-Type: application/json" \
  -d '{"amount":100,"fromCurrency":"CAD","toCurrency":"USD"}'

# Test the Plaid link token endpoint (requires auth cookie)
curl -s -X POST https://carloscab74.vercel.app/api/plaid/create-link-token \
  -b <auth-cookie>
```

---

## Database Notes

**Provider:** Supabase PostgreSQL, connected via the transaction pooler URL in `DATABASE_URL`.

**ORM:** None. All queries use `postgres.js` tagged template literals via the `getSql()` singleton in `lib/db.ts`.

**Tables:**

| Table | Purpose |
|---|---|
| `users` | Identity, auth, dual-currency balances, KYC status |
| `transactions` | All money movement — sends, requests, cross-border FX details |
| `bank_accounts` | Plaid-linked external accounts |
| `friends` | Social graph with request approval flow |
| `notifications` | In-app notifications for transactions and friend events |
| `password_reset_tokens` | One-time password reset tokens (hashed, 1-hour expiry) |
| `transfer_intents` | Transfer intent records — draft → reviewed → ready → processing → settled/failed/returned |
| `velocity_checks` | Rolling transaction volume per user for rate limiting |
| `ledger_entries` | Passive audit log of all financial movement — immutable, references transactions or transfer_intents |
| `provider_webhook_events` | Webhook event deduplication — provider + event_id uniqueness prevents duplicate processing |
| `audit_logs` | System audit trail. Append-only **by convention only** — no trigger, rule, RLS policy or `REVOKE` enforces it, and the application's single DB role can `UPDATE` and `DELETE` these rows. Do not describe it as immutable |
| `webhook_dead_letters` | Payloads of webhook events that exhausted their retries, for operator review and requeue |
| `plaid_transfer_event_cursors` | Sync position for `TRANSFER_EVENTS_UPDATE`. Missing means the Plaid Transfer webhook cannot persist its position and answers 500 |
| `transfer_recovery_flags` | Marks intents needing reconciliation |
| `splits` / `split_participants` | Split payments and each participant's portion |
| `admin_users` / `admin_roles` / `admin_permissions` / `role_permissions` / `admin_sessions` / `admin_audit_logs` | Admin RBAC. A separate auth context from `users`, not a flag on a customer row |

The authoritative list is whatever `initializeSchema()` builds; `scripts/verify-migrate.sql` checks a live database against it.

**Critical column rule:** The `users` table has a legacy `balance` column from before the dual-currency migration. **Never use it in new code.** Always use `balance_cad` and `balance_usd`. The legacy column exists only because dropping it requires a coordinated migration.

**Migration system:** Two distinct mechanisms, and conflating them is a mistake.

1. **A convergent reconciler** — the ~103 `ADD COLUMN IF NOT EXISTS` /
   `CREATE TABLE IF NOT EXISTS` statements in `app/api/migrate/route.ts`.
   Re-running is the designed behaviour, so per-statement versions are
   meaningless. It now records *that it ran* in `schema_migrations` under the
   fixed id `convergent_api_migrate`.
2. **Three authorization-gated financial migrations** in `migrations/`, run by
   hand under `sql/README.md`'s procedure. These are versioned in
   `schema_migrations` (decision 0005 Phase 2).

`schema_migrations` answers "is this database current?" — `describeState()` —
and fails closed via `assertSafeToProceed()` on anything blocking, drifted, or
unadopted. **An empty tracking table means "not adopted into tracking", not
"no migrations applied."** Adopt an existing database with
`docs/runbooks/migration-baseline-adoption.md`, which probes each migration's
end state and records `baseline_detected` / `baseline_pending` /
`baseline_unknown` — **never `applied`**, because no execution was observed.
`baseline_unknown` blocks on purpose: an unanswered question is the state in
which a balance-rewriting migration gets applied twice.

---

## Deployment Notes

**Platform:** Vercel (Hobby plan). Serverless functions for API routes, Edge Middleware for `proxy.ts`.

**Auto-deploy:** Every push to `master` triggers a Vercel build and deployment automatically.

**Required environment variables** (set in Vercel dashboard):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase transaction pooler connection string |
| `JWT_SECRET` | Long random string for signing `manna-token` JWTs |
| `PLAID_CLIENT_ID` | From Plaid dashboard |
| `PLAID_SECRET` | Production secret from Plaid dashboard |
| `PLAID_ENV` | Unset means sandbox. Set `production` only when `PLAID_SECRET` is the production secret. |
| `WISE_API_KEY` | API token from Wise developer settings |
| `WISE_ENV` | Set to `production` |
| `PLAID_TOKEN_ENCRYPTION_KEY` | 64-character hex string (32 bytes) used to AES-256-GCM encrypt Plaid access tokens before storing in `bank_accounts.plaid_access_token_enc`. Generate with `openssl rand -hex 32`. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` for sandbox, `sk_live_…` for production) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret from Stripe Dashboard → Developers → Webhooks (`whsec_…`) |
| `NEXT_PUBLIC_APP_URL` | Full origin URL without trailing slash, e.g. `https://carloscab74.vercel.app` |
| `MANNA_ENV` | `sandbox`, spelled exactly, declares a sandbox deployment. `VERCEL_ENV=production` overrides it, so no value here can weaken a production deploy |
| `CRON_SECRET` | Required by the reconciliation cron route; unset means the route refuses |
| `REDIS_URL` | Optional, and **set in production** (owner-reported 2026-10-20). Set it for a shared rate-limit counter. Unset falls back to in-process counters, which on serverless means the effective limit is `limit × instances` — weaker, and not sufficient alone for a production auth endpoint. Being set is **not** proof that limiting is shared: any client or command failure degrades that instance to in-process counting — which changes `allowed`/`remaining` and lets a caller spread requests across instances to exceed the nominal limit — the flag latches until the instance recycles, the **raw exception** is unlogged by design while a generic degradation line is emitted to stderr, so callers get no explicit failure signal and operators get one undetailed line. Prove it with `POST /api/admin/operations/redis-rate-limit`, which needs the `exceptions:manage` permission — **SuperAdmin or OperationsAdmin**; a lesser admin role gets 403, which is easy to misread as Redis being down. **One POST proves only the instance that served it.** `redisUnavailable`, `redisClient` and `memoryCounters` are module-level (`lib/rate-limit.ts:138`, `:137`, `:95`), so they are per serverless instance: another live instance can be latched into in-process counting while this one answers pass. Serverless instances cannot be addressed individually, so repeated POSTs give sampling confidence, not coverage — VERIFIED needs evidence covering every live instance, which in practice means monitoring the degradation signal rather than running the route by hand |
| `PLAID_TRANSFER_LIVE` | `true` enables live US ACH. Any other value, including unset, is sandbox |
| `CA_EFT_LIVE` | `true` enables live CA EFT. Any other value, including unset, is sandbox |

**After any schema change:** Deploy first, then call `POST /api/migrate` once with a valid auth cookie to apply `ALTER TABLE` changes to the live database. A command-line call sends no `Origin` header, which the route deliberately allows; a browser-originated request from another site is refused.

**Rollback:** Vercel keeps a full deployment history. To roll back, navigate to the Vercel project dashboard → Deployments → select a prior deployment → Promote to Production.
