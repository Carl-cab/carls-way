# Manna App – AI Project Context

## Introduction
This file serves as persistent memory for AI coding assistants (like Claude Code) working on the Manna App. It contains critical context, design decisions, and architectural rules that must be followed to maintain consistency.

## Architecture Decisions & Rules

### 1. Database Access
- **Rule:** Do NOT introduce an ORM (Prisma, Drizzle, etc.) unless explicitly instructed.
- **Decision:** The project uses `postgres.js` for direct SQL queries. This was chosen for performance and simplicity with Supabase's transaction pooler.
- **Convention:** Always use the `getSql()` singleton from `lib/db.ts`.

### 2. Schema Management
- **Rule:** Do NOT use traditional migration files yet.
- **Decision:** The schema is initialized via `initializeSchema()` in `lib/db.ts`. Recent schema updates (like adding multi-currency support) were applied via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in the `/api/migrate/route.ts` endpoint.
- **Convention:** If you need to add a column, add it to both `initializeSchema()` (for new environments) and the `/api/migrate` endpoint (for existing environments), then run the migration endpoint.

### 3. Dual-Currency Model
- **Rule:** NEVER use the legacy `balance` column in the `users` table for new logic.
- **Decision:** The app recently migrated from a single currency to a dual-currency model (`balance_cad` and `balance_usd`).
- **Convention:** When displaying balances, use the `getDisplayBalance()` helper in `layout.tsx`. When moving money, explicitly check the user's `country` to determine which balance column to debit/credit.

### 4. Cross-Border Transfers & FX
- **Rule:** All cross-border transfers MUST generate an FX quote and record the exact rate and fee in the `transactions` table.
- **Decision:** FX rates are fetched live from the Wise API (`lib/fx.ts`) and cached for 5 minutes in the `fx_rates` table.
- **Convention:** Use `buildFxQuote()` in `lib/fx.ts` to calculate receiver amounts and fees before inserting a cross-border transaction.

### 5. Authentication & Security
- **Rule:** Do NOT use NextAuth or Auth.js.
- **Decision:** The project uses a custom JWT implementation stored in HTTP-only cookies (`manna-token`).
- **Convention:** Use `getAuthUser()` from `lib/auth.ts` in API routes to authenticate requests. Route protection is handled by `proxy.ts` middleware.
- **Known Security Debt:** Plaid access tokens are currently stored in plaintext in the `plaid_access_token_enc` column. This must be fixed before launching real money movement.

### 6. Velocity Limits
- **Rule:** All outbound payments (`type = 'pay'`) MUST check velocity limits before processing.
- **Decision:** Limits are hardcoded in `lib/auth.ts` (`VELOCITY_LIMITS`) and vary based on the user's `kyc_status` ('pending' vs 'verified').
- **Convention:** Call `checkVelocityLimit()` before debiting, and `recordVelocity()` after a successful transaction.

## Project History & Recent Fixes
- **Audit Fixes (June 2026):**
  - Fixed a critical bug where the profile page hung because the `bank_accounts` table was missing. Added the `/api/migrate` endpoint to fix this in production.
  - Fixed a bug in the Request Money flow where the frontend sent `receiverEmail` but the backend expected `receiverUsername`.
  - Fixed timestamp parsing bugs ("NaNd ago" and "Invalid Date") in the Feed and History pages caused by double-appending 'Z' to ISO strings.
  - Updated the global layout header to display the correct `balance_cad` / `balance_usd` instead of the stale legacy `balance`.

## Immediate Next Tasks for AI Engineer
1. **Fix Request Acceptance Bug:** Update `PATCH /api/transactions/[id]/route.ts`. It currently deducts from the legacy `balance` field and ignores cross-border FX logic when a user accepts a money request. It must be updated to mirror the dual-currency and FX logic found in `POST /api/transactions`.
2. **Implement "Add Money" / "Cash Out":** The profile page UI has inert buttons. Wire these up to move funds between the Manna wallet and linked Plaid `bank_accounts`.
3. **Implement KYC Flow:** The profile page shows a "Start verification" button. Build the integration to update a user's `kyc_status` to 'verified', unlocking higher velocity limits.

## Coding Conventions
- Use Tailwind CSS for all styling. No custom CSS files other than `globals.css`.
- Use Server Components by default. Add `'use client'` only when React hooks or event listeners are required.
- API routes must return standard JSON error responses: `NextResponse.json({ error: 'Message' }, { status: 4xx })`.
- All database queries must be parameterized using the `postgres.js` tagged template literal syntax (e.g., `` sql`SELECT * FROM users WHERE id = ${id}` ``) to prevent SQL injection.
