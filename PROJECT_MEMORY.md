# Manna App — Project Memory

> **Purpose:** This file is the single source of truth for any AI coding assistant (Claude Code, Cursor, Copilot) working on this project. Load it at the start of every session. It contains all design decisions, business rules, architecture constraints, coding conventions, and project history needed to continue development without losing context.

---

## What Is Manna?

Manna is a peer-to-peer payment application for cross-border money transfers between the United States and Canada. Users register with a country (CA or US), receive a $100 seed balance in their local currency, and can send or request money from other users. Cross-border transfers are powered by live Wise FX rates. Bank accounts are linked via Plaid. The app is a Next.js 16 full-stack application deployed on Vercel with a Supabase PostgreSQL database.

**Live URL:** https://carloscab74.vercel.app

**GitHub Repository:** https://github.com/Carl-cab/carls-way

---

## Architecture Rules (Do Not Violate)

**Database access** must always go through the `getSql()` singleton in `lib/db.ts`. Do not introduce an ORM (Prisma, Drizzle, etc.) unless explicitly instructed. The project uses `postgres.js` for direct parameterized SQL queries, which is required for compatibility with Supabase's transaction pooler.

**Schema migrations** are currently ad-hoc. To add a new column, you must add it to both `initializeSchema()` in `lib/db.ts` (so new environments get it on first boot) and to the `GET /api/migrate` endpoint in `app/api/migrate/route.ts` (so the live production database gets it via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). After deploying, call `/api/migrate` once to apply the change.

**Authentication** uses a custom JWT stored in an HTTP-only cookie named `manna-token`. Do not use NextAuth, Auth.js, or any third-party auth library. Use `getAuthUser()` from `lib/auth.ts` in every API route that requires authentication. Route-level protection is handled by `proxy.ts` middleware.

**Dual-currency balances** are stored as `balance_cad` and `balance_usd` on the `users` table. There is also a legacy `balance` column that must never be used in new code. Always determine which currency column to debit or credit by checking `user.country === 'US' ? 'USD' : 'CAD'`.

**Cross-border FX** must always call `buildFxQuote()` from `lib/fx.ts` before processing a cross-border payment. The resulting `fx_rate`, `fx_fee`, `sender_amount`, `receiver_amount`, and `estimated_settlement` must be recorded on the `transactions` row.

**Velocity limits** must be checked via `checkVelocityLimit()` before every outbound payment (`type = 'pay'`), and recorded via `recordVelocity()` after a successful debit. Limits are defined in `VELOCITY_LIMITS` in `lib/auth.ts` and vary by `kyc_status` ('pending' vs 'verified').

---

## Coding Conventions

All styling uses Tailwind CSS utility classes. No custom CSS is written outside of `app/globals.css`. Components use Server Components by default; `'use client'` is added only when React hooks or browser event listeners are required. API routes return `NextResponse.json({ error: 'Message' }, { status: 4xx })` for errors and `NextResponse.json({ success: true, ... })` for successful mutations. All database queries use the `postgres.js` tagged template literal syntax (e.g., `` sql`SELECT * FROM users WHERE id = ${id}` ``) — never string concatenation.

---

## Project History

The project was built and deployed through Manus AI. The following significant changes were made during the development and audit cycle:

A dual-currency migration was performed, adding `balance_cad` and `balance_usd` columns to the `users` table and `sender_currency`, `receiver_currency`, `fx_rate`, `fx_fee`, `sender_amount`, `receiver_amount`, `is_cross_border`, `payment_rail`, and `estimated_settlement` columns to the `transactions` table. This migration was applied to production via the `/api/migrate` endpoint.

A UX audit in June 2026 identified and fixed four bugs: (1) the profile page hung because `bank_accounts` was missing from the schema — fixed by adding the table to `initializeSchema()` and running `/api/migrate`; (2) the Request Money page sent `receiverEmail` but the API expected `receiverUsername` — fixed in `app/(app)/request/page.tsx`; (3) the Feed page showed "NaNd ago" because `timeAgo()` double-appended 'Z' to ISO timestamps — fixed in `app/(app)/feed/page.tsx`; (4) the History page showed "Invalid Date" for the same reason — fixed in `app/(app)/history/page.tsx`. The global layout header was also updated to use `balance_cad`/`balance_usd` instead of the stale legacy `balance` field.

---

## Known Bugs

**Request acceptance uses legacy balance.** When a user accepts a pending money request, `PATCH /api/transactions/[id]/route.ts` deducts from the legacy `balance` field and ignores cross-border FX logic entirely. This is the highest-priority bug. The fix is to rewrite the `accept` branch to mirror the dual-currency and FX logic found in `POST /api/transactions/route.ts`.

**Plaid access tokens stored in plaintext.** The `plaid_access_token_enc` column stores raw Plaid access tokens despite the `_enc` suffix implying encryption. This must be resolved before enabling real ACH money movement.

**Frontend password validation mismatch.** The registration form enforces `minLength={6}` in the UI, but the backend `validatePassword()` requires at least 8 characters, one uppercase letter, and one number. The frontend placeholder should be updated to match.

**Activity filter chips are non-functional.** The History page sends `?filter=sent|received|pending` to the transactions API, but the API ignores this query parameter and always returns all 50 transactions.

---

## Unfinished Features

**KYC / Identity Verification.** The profile page shows a "Start verification →" button, but it has no click handler. The backend velocity limits already branch on `kyc_status === 'verified'`, so the unlock path is ready — only the KYC provider integration (e.g., Stripe Identity or Persona) and the endpoint to update `kyc_status` are missing.

**Add Money / Cash Out.** The profile page shows "+ Add Money" and "Cash Out" buttons, but they are inert. These require a Plaid Transfer or Stripe ACH integration to move funds between the Manna wallet and linked bank accounts.

**Friend Request Approval.** Adding a friend immediately sets the relationship to `accepted`. There is no pending-request inbox. The `friends` table has a `status` column and the API returns a `direction` field, so the data model supports it — only the UI and approval endpoint are missing.

---

## Immediate Next Tasks (Priority Order)

1. Fix `app/api/transactions/[id]/route.ts` — rewrite the `accept` branch to use `balance_cad`/`balance_usd` and handle cross-border FX.
2. Implement "Add Money" and "Cash Out" on the profile page using Plaid Transfer.
3. Implement the KYC verification flow and connect it to the "Start verification" button.
4. Encrypt Plaid access tokens before enabling real money movement.
5. Fix the Activity page filter chips by implementing `?filter=` support in `GET /api/transactions`.

---

## Environment Variables

| Variable | Where Set | Purpose |
|---|---|---|
| `DATABASE_URL` | Vercel | Supabase PostgreSQL connection string (transaction pooler) |
| `JWT_SECRET` | Vercel | Signs and verifies `manna-token` JWTs |
| `PLAID_CLIENT_ID` | Vercel | Plaid API client ID |
| `PLAID_SECRET` | Vercel | Plaid API secret (production) |
| `NEXT_PUBLIC_PLAID_ENV` | Vercel | Plaid environment — must be `production` |
| `WISE_API_KEY` | Vercel | Wise API token for live FX rates |
| `WISE_ENV` | Vercel | Set to `production` for live Wise endpoint |

---

## Key Files Quick Reference

| File | Role |
|---|---|
| `lib/db.ts` | DB connection singleton and schema definition |
| `lib/auth.ts` | JWT helpers, velocity limits, audit logging, input validation |
| `lib/fx.ts` | Wise API integration, FX rate caching, quote builder |
| `lib/plaid.ts` | Plaid client configuration |
| `proxy.ts` | Next.js middleware — auth route guard |
| `app/api/transactions/route.ts` | Core money movement logic |
| `app/api/transactions/[id]/route.ts` | Request accept/decline — **contains known bug** |
| `app/api/migrate/route.ts` | Ad-hoc schema migration runner |
| `app/(app)/layout.tsx` | Authenticated shell with header balance display |
