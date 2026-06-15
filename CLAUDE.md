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
| `lib/plaid.ts` | Plaid client configuration |
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

**[HIGH] Request acceptance uses legacy balance field.**
File: `app/api/transactions/[id]/route.ts`
When a user accepts a pending money request, the `accept` branch deducts from the legacy `users.balance` column and ignores cross-border FX logic entirely. It must be rewritten to mirror the dual-currency and FX logic in `POST /api/transactions/route.ts` — checking `balance_cad` / `balance_usd` based on country, calling `buildFxQuote()` for cross-border requests, and recording FX fields on the transaction row.

**[HIGH] Plaid access tokens stored in plaintext.**
File: `app/api/plaid/exchange-token/route.ts`
The `plaid_access_token_enc` column stores raw Plaid access tokens despite the `_enc` suffix implying encryption. Application-level encryption must be added before enabling real ACH money movement.

**[MEDIUM] Activity filter chips are non-functional.**
File: `app/(app)/history/page.tsx`, `app/api/transactions/route.ts`
The History page sends `?filter=sent|received|pending` to the transactions API, but the API ignores this query parameter and always returns all 50 transactions. The `GET /api/transactions` route needs a `WHERE` clause branch for each filter value.

**[LOW] Frontend password validation mismatch.**
File: `app/(auth)/register/page.tsx`
The registration form enforces `minLength={6}` in the HTML input, but the backend `validatePassword()` in `lib/auth.ts` requires at least 8 characters, one uppercase letter, and one number. The frontend placeholder and `minLength` should be updated to match.

---

## Current Priorities

The following tasks are ordered by business impact and should be worked in sequence:

1. **Fix request acceptance bug** — Rewrite the `accept` branch in `app/api/transactions/[id]/route.ts` to use `balance_cad`/`balance_usd` and handle cross-border FX.
2. **Implement Add Money / Cash Out** — Wire up the inert "+ Add Money" and "Cash Out" buttons on the profile page to a Plaid Transfer or Stripe ACH integration.
3. **Implement KYC verification flow** — Integrate a KYC provider (Stripe Identity or Persona) and build the endpoint to update `users.kyc_status` to `'verified'`, which unlocks higher velocity limits.
4. **Encrypt Plaid access tokens** — Add AES-256-GCM encryption around the token stored in `plaid_access_token_enc` before any real ACH transfers go live.
5. **Fix Activity filter chips** — Add `?filter=` query parameter support to `GET /api/transactions`.

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
| `friends` | Social graph (currently auto-accepted, no approval flow) |
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

**After any schema change:** Deploy first, then call `GET /api/migrate` once with a valid auth cookie to apply `ALTER TABLE` changes to the live database.

**Rollback:** Vercel keeps a full deployment history. To roll back, navigate to the Vercel project dashboard → Deployments → select a prior deployment → Promote to Production.
