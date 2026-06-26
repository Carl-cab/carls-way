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
| `lib/stripe.ts` | Stripe client singleton (`getStripe()`) |
| `lib/encryption.ts` | AES-256-GCM `encryptToken`/`decryptToken` helpers for Plaid access tokens |
| `lib/transfers/types.ts` | `TransferProvider` interface, all transfer types and status enums |
| `lib/transfers/router.ts` | Routes US users → SandboxUSProvider, CA users → SandboxCAProvider |
| `lib/transfers/sandbox-us.ts` | US sandbox provider — simulates Plaid Transfer, no real API calls |
| `lib/transfers/sandbox-ca.ts` | CA sandbox provider — simulates Canadian EFT, no real API calls |
| `proxy.ts` | Next.js middleware — enforces auth on all `(app)` routes |

---

## Coding Standards

**TypeScript** is used throughout. All new files must be `.ts` or `.tsx`. Avoid `any` types; define interfaces for all API request and response shapes.

**Styling** uses Tailwind CSS utility classes exclusively. Do not write custom CSS outside of `app/globals.css`. The design language uses `red-700` as the primary brand color.

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
npm install
# Create .env.local with all required variables (see Deployment Notes)
npm run dev
```

**Branching:** Feature branches off `master`. The `documentation/handoff-package` branch contains all handoff docs. Vercel auto-deploys on every push to `master`.

**Schema changes:** When adding a new column, update two places:
1. `lib/db.ts` → `initializeSchema()` — so fresh environments get the column on first boot.
2. `app/api/migrate/route.ts` → add `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — so the live production database gets the change.

After deploying, call `GET /api/migrate` once (authenticated) to apply the migration to production.

**No test suite exists.** Manual testing is currently the only verification method.

---

## Known Issues

All previously tracked issues (request acceptance legacy balance, Plaid plaintext tokens, non-functional Activity filter chips, frontend password validation mismatch) have been fixed. See `PROJECT_MEMORY.md` session history for details.

---

## Transfer Provider Architecture

Transfers use a provider abstraction in `lib/transfers/`. All providers implement `TransferProvider` (see `lib/transfers/types.ts`). Provider routing is in `lib/transfers/router.ts`:

- US users (`country = 'US'`) → `SandboxUSProvider` (future: `PlaidTransferProvider`)
- CA users (`country = 'CA'`) → `SandboxCAProvider` (future: `CanadianEFTProvider`)

**Transfer flow (3 steps):**
1. `POST /api/transfers/intent` — creates `status='draft'`, routes to correct provider
2. `GET /api/transfers/[id]/review` — returns review details + region-appropriate consent language
3. `POST /api/transfers/[id]/confirm` — records `consent_confirmed_at`, sets `status='ready'`

**Rules:**
- Both sandbox providers are execution_mode='sandbox' — no money moves, no external API calls
- `executeTransfer()` throws on both sandbox providers — prevents accidental live calls
- Velocity is checked at intent creation but only recorded at confirm (future: at execute)
- Balance is never mutated by any current transfer route
- CA users see "Canadian transfer simulation" language — never ACH language
- US users see "US transfer simulation" language

**To add a live provider:** Create `lib/transfers/plaid-transfer.ts` implementing `TransferProvider`, swap it into `router.ts` behind an env-gated condition. The interface and API routes do not change.

## Current Priorities

The following tasks are ordered by business impact and should be worked in sequence:

1. **Run `/api/migrate`** — Apply new `transfer_intents` columns (`provider_region`, `provider_name`, `execution_mode`, `consent_confirmed_at`, `idempotency_key`, `bank_account_id`) to production
2. **Validate 3-step transfer flow in production** — US and CA user paths through intent → review → confirm
3. **KYC live test** — Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` in Vercel; register Stripe webhook
4. **Implement PlaidTransferProvider** — US live ACH debit/credit (after Plaid products updated to include Transfer)
5. **Implement CanadianEFTProvider** — CA live EFT integration

---

## Important Commands

```bash
# Start local dev server
npm run dev

# Build for production (also runs by Vercel on deploy)
npm run build

# Lint the codebase
npm run lint

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
| `audit_logs` | Immutable system audit trail |

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
| `NEXT_PUBLIC_PLAID_ENV` | Must be `production` |
| `WISE_API_KEY` | API token from Wise developer settings |
| `WISE_ENV` | Set to `production` |
| `PLAID_TOKEN_ENCRYPTION_KEY` | 64-character hex string (32 bytes) used to AES-256-GCM encrypt Plaid access tokens before storing in `bank_accounts.plaid_access_token_enc`. Generate with `openssl rand -hex 32`. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` for sandbox, `sk_live_…` for production) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret from Stripe Dashboard → Developers → Webhooks (`whsec_…`) |
| `NEXT_PUBLIC_APP_URL` | Full origin URL without trailing slash, e.g. `https://carloscab74.vercel.app` |

**After any schema change:** Deploy first, then call `GET /api/migrate` once with a valid auth cookie to apply `ALTER TABLE` changes to the live database.

**Rollback:** Vercel keeps a full deployment history. To roll back, navigate to the Vercel project dashboard → Deployments → select a prior deployment → Promote to Production.
