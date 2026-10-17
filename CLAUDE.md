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

---

## Coding Standards

**TypeScript** is used throughout. All new files must be `.ts` or `.tsx`. Avoid `any` types; define interfaces for all API request and response shapes.

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

After deploying, call `GET /api/migrate` once (authenticated) to apply the migration to production.

**Tests:** `pnpm test` (vitest) runs the suite in `lib/__tests__`. 51 files /
735 tests as of this writing, and the suite is expected to stay fully green.
Several files run against a real PostgreSQL instance rather than a mock,
because the defects they cover were mismatches between SQL in the app and the
actual schema — exactly what a hand-written fake cannot catch. Set
`DATABASE_URL` to a scratch database before running them, and prefer a
genuinely fresh one: reusing a database that an earlier run already migrated
has twice hidden a failure that CI then found on a clean one. Also available:
`pnpm run typecheck` and `pnpm run lint` (0 errors; ~28 unused-variable
warnings are tolerated).

`lib/__tests__/schema-source-parity.test.ts` enforces the two-source rule
below mechanically: it parses every object `app/api/migrate/route.ts`
guarantees and requires all of them on a database built by
`initializeSchema()` alone, comparing declared column types as well as
presence. It checks one direction only — the migrate route is the authority on
what the live database holds — so an object added to `lib/db.ts` and *not* to
the route is still yours to catch by hand.

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
curl -b <auth-cookie> https://carloscab74.vercel.app/api/migrate

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
| `audit_logs` | Immutable system audit trail |
| `webhook_dead_letters` | Payloads of webhook events that exhausted their retries, for operator review and requeue |
| `plaid_transfer_event_cursors` | Sync position for `TRANSFER_EVENTS_UPDATE`. Missing means the Plaid Transfer webhook cannot persist its position and answers 500 |
| `transfer_recovery_flags` | Marks intents needing reconciliation |
| `splits` / `split_participants` | Split payments and each participant's portion |
| `admin_users` / `admin_roles` / `admin_permissions` / `role_permissions` / `admin_sessions` / `admin_audit_logs` | Admin RBAC. A separate auth context from `users`, not a flag on a customer row |

The authoritative list is whatever `initializeSchema()` builds; `scripts/verify-migrate.sql` checks a live database against it.

**Critical column rule:** The `users` table has a legacy `balance` column from before the dual-currency migration. **Never use it in new code.** Always use `balance_cad` and `balance_usd`. The legacy column exists only because dropping it requires a coordinated migration.

**Migration system:** Ad-hoc. New columns are added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `app/api/migrate/route.ts`. There is no versioned migration history.

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
| `REDIS_URL` | Optional. Set it for a shared rate-limit counter. Unset falls back to in-process counters, which on serverless means the effective limit is `limit × instances` — weaker, and not sufficient alone for a production auth endpoint |
| `PLAID_TRANSFER_LIVE` | `true` enables live US ACH. Any other value, including unset, is sandbox |
| `CA_EFT_LIVE` | `true` enables live CA EFT. Any other value, including unset, is sandbox |

**After any schema change:** Deploy first, then call `GET /api/migrate` once with a valid auth cookie to apply `ALTER TABLE` changes to the live database.

**Rollback:** Vercel keeps a full deployment history. To roll back, navigate to the Vercel project dashboard → Deployments → select a prior deployment → Promote to Production.
