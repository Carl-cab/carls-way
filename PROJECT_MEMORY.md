# PROJECT_MEMORY.md

This file is the persistent project memory and single source of truth for **manna**. It must be kept in sync with the codebase and updated at the end of every development session, before the task is marked complete.

---

## Project Overview

**Purpose**: manna is a peer-to-peer (P2P) payment application, modeled on Venmo, that lets users send money, request money, and share a social feed of (public) transactions.

**Business objectives**:
- Provide a Venmo-equivalent P2P payment experience for North America
- Support both Canada (CAD) and the United States (USD) as a single platform
- Combine social/feed features (notes, emoji, privacy levels) with a simple wallet/balance model

**Target users**: Individuals in Canada and the US who want to split bills, pay friends/family, and request money socially (roommates, friend groups, etc.)

---

## Current Architecture

### Frontend
- **Next.js 16** (App Router, Turbopack), **TypeScript**, **Tailwind CSS v4**
- Route groups: `(auth)` for `/login`, `/register`; `(app)` for `/feed`, `/send`, `/request`, `/history`, `/friends`, `/profile`
- `app/page.tsx` — root route, redirects to `/feed` (authenticated) or `/login` (unauthenticated)
- Each route group has its own `layout.tsx`; `(app)/layout.tsx` provides the header (balance, brand), bottom nav, and floating Pay/Request buttons
- Brand: "manna", red/white maple-leaf-inspired theme, tagline "Pay Across North America."

### Backend
- Next.js API routes under `app/api/`:
  - `api/auth/register`, `api/auth/login`, `api/auth/logout`
  - `api/me` — current user profile
  - `api/users` — search users by name/email/username
  - `api/friends` — friend list, add/remove
  - `api/transactions` — feed (public), personal history (filterable), create payment/request
  - `api/transactions/[id]` — accept/decline pending requests
- Auth: JWT signed with `JWT_SECRET` (env, insecure fallback exists), stored in httpOnly cookie `manna-token`
- Route protection: `proxy.ts` (Next 16 middleware convention) — redirects unauthenticated users away from `(app)` routes and `/`, redirects authenticated users away from `/login`/`/register`

### Database
- **Neon Postgres** (serverless), accessed via `@neondatabase/serverless`
  - Connection: `DATABASE_URL` env var (required — `getSql()` throws if unset)
  - Lazy-initialized SQL client in `lib/db.ts`, schema created via `initializeSchema()` (`CREATE TABLE IF NOT EXISTS`, called on register)
- Tables: `users`, `friends`, `transactions` (see Database Changes Log) — now use `SERIAL PRIMARY KEY` and `TIMESTAMPTZ`, `ILIKE` for case-insensitive search
- **Migrated from better-sqlite3** on 2026-06-14 (concurrent session) to fix ephemeral-storage problem on Vercel

### Integrations
- None live yet. UI placeholders exist for:
  - "Add Money" via Interac e-Transfer (CA) / ACH (US)
  - "Cash Out" to bank (CA/US)
- No email, SMS, payment processor, or FX rate provider integrated

### Deployment Environment
- Target: **Vercel**
- Branch: `claude/cool-cerf-ErxD3` (active development branch)
- Database is now **Neon Postgres** — durable across deploys/invocations (resolves prior SQLite ephemeral-storage limitation)
- Required env vars: `DATABASE_URL` (Neon Postgres connection string — **required**, app throws if missing), `JWT_SECRET` (not yet enforced — falls back to an insecure default)

---

## Completed Features

### 1. Core P2P payment app ("Carl's Way")
- **Description**: Full-stack app — register/login (JWT cookie auth), wallet with $100 starting balance, send/request money by email or username, public/friends/private transaction privacy, social feed of public transactions, transaction history with filters (all/sent/received/pending) and accept/decline for pending requests, friends search/add, profile page with mock Add Money (Interac) / Cash Out modals. SQLite via better-sqlite3, Tailwind UI, red/white Canadian maple-leaf branding.
- **Date completed**: 2026-05-30
- **Files modified**: Initial full build — `app/**`, `lib/db.ts`, `lib/auth.ts`, `proxy.ts`, `package.json`, config files (commit `003d40a`)

### 2. US support + rebrand to "Venmac"
- **Description**: Added `country` (CA/US) field to users and `currency` (CAD/USD) field to transactions. Register page now has a country toggle with dynamic province (CA) / state (US) dropdowns. Profile, send, request, feed, and history pages all became currency-aware (CAD vs USD formatting, Interac vs ACH transfer copy). App renamed from "Carl's Way" to "Venmac" across UI, metadata, cookie name, and DB filename.
- **Date completed**: 2026-05-30
- **Files modified**: `lib/db.ts`, `lib/auth.ts`, `app/api/auth/register/route.ts`, `app/api/me/route.ts`, `app/api/transactions/route.ts`, `app/(auth)/register/page.tsx`, `app/(auth)/login/page.tsx`, `app/(app)/layout.tsx`, `app/(app)/profile/page.tsx`, `app/(app)/send/page.tsx`, `app/(app)/request/page.tsx`, `app/(app)/feed/page.tsx`, `app/(app)/history/page.tsx`, `app/layout.tsx` (commit `2e73fcb`)

### 3. Auth cookie bug fix + rebrand to "manna"
- **Description**: Fixed a critical bug where `proxy.ts` checked cookie `carls-way-token` while `lib/auth.ts` set `venmac-token`, causing every request to be treated as unauthenticated (broken auth-gated routing). Also moved the SQLite DB path to `/tmp` on Vercel (read-only filesystem fix) and completed the rebrand from "Venmac" to "manna" (UI, metadata, cookie name, JWT secret default, DB filename, package name).
- **Date completed**: 2026-06-14
- **Files modified**: `proxy.ts`, `lib/auth.ts`, `lib/db.ts`, `app/layout.tsx`, `app/(app)/layout.tsx`, `app/(auth)/login/page.tsx`, `app/(auth)/register/page.tsx`, `package.json` (commit `b18220d`)

### 4. Migration from SQLite to Neon Postgres
- **Description**: Replaced `better-sqlite3` with `@neondatabase/serverless`. Rewrote `lib/db.ts` as a lazy-initialized Neon SQL client with `getSql()` and `initializeSchema()` (throws if `DATABASE_URL` is unset). Converted all API routes (`auth/register`, `auth/login`, `me`, `users`, `friends`, `transactions`, `transactions/[id]`) to async tagged-template Postgres queries. Schema updated to `SERIAL PRIMARY KEY` / `TIMESTAMPTZ`; user search now uses `ILIKE`. Removes the `/tmp` SQLite workaround entirely — this is the durable-storage fix called out as the top priority in this file.
- **Date completed**: 2026-06-14 (concurrent session, performed by a separate agent run while this session was in progress)
- **Files modified**: `lib/db.ts`, `app/api/auth/login/route.ts`, `app/api/auth/register/route.ts`, `app/api/me/route.ts`, `app/api/users/route.ts`, `app/api/friends/route.ts`, `app/api/transactions/route.ts`, `app/api/transactions/[id]/route.ts`, `package.json`, `package-lock.json` (commit `fc9c769`)

---

## Current Work In Progress

_None currently in progress — last session (2026-06-14) completed and pushed cleanly._

- **Feature**: N/A
- **Status**: N/A
- **Files involved**: N/A
- **Remaining tasks**: N/A

---

## Open Issues

| # | Bug / Issue | Priority | Recommended Solution |
|---|---|---|---|
| 1 | ~~SQLite on `/tmp` is ephemeral on Vercel~~ — **RESOLVED 2026-06-14**: migrated to Neon Postgres (commit `fc9c769`) | ~~Critical~~ Done | — |
| 2 | Balance transfer in `api/transactions/route.ts` uses two separate `UPDATE` statements (not wrapped in a DB transaction) — still true after Postgres migration (sequential `await sql\`UPDATE...\`` calls, no `BEGIN`/`COMMIT`) | High | Use Neon's transaction support (e.g. `sql.transaction([...])` / a pooled client with explicit `BEGIN`/`COMMIT`) to wrap debit + credit atomically |
| 3 | `friends`-privacy level is not enforced — feed only filters on `privacy = 'public'`, no join against `friends` table | Medium | Add friends-aware query branch to `/api/transactions?feed=true` |
| 4 | `JWT_SECRET` has an insecure hardcoded fallback (`manna-secret-key-change-in-production`) | High (security) | Throw/fail fast at startup if `JWT_SECRET` env var is missing in production |
| 5 | No rate limiting on auth/transaction endpoints | Medium (security) | Add Upstash Redis-based rate limiting middleware |
| 6 | No pagination on feed (`LIMIT 50`) / history (`LIMIT 100`) | Low | Add cursor-based pagination params |
| 7 | No cross-currency conversion — CA↔US transactions just use sender's currency with no FX | Medium | Add FX rate handling or restrict transactions to same-currency users initially |
| 8 | No email verification / password reset | Medium | Integrate email provider (e.g. Resend) for verification + reset flows |
| 9 | `DATABASE_URL` must be set in Vercel project env vars (Neon connection string) — deployment will throw at runtime if missing | High (deployment) | Provision a Neon database, add `DATABASE_URL` to Vercel env vars, confirm `initializeSchema()` runs successfully on first request |

---

## Technical Debt

### Refactoring opportunities
- Extract shared currency formatting (`formatCAD`/`formatAmount`/`formatCurrency` duplicated across `feed`, `history`, `profile`, `send`, `request`, `(app)/layout`) into a single `lib/format.ts` helper
- Centralize input validation (amount bounds, email/username lookup) with a schema library (zod)
- `app/api/transactions/route.ts` mixes payment and request logic in one POST handler — consider splitting or using a discriminated request schema

### Performance concerns
- Single SQLite file with WAL mode does not scale well under concurrent serverless function instances (write lock contention)
- No caching on `/api/me` (called on every route change in `(app)/layout.tsx`)

### Security concerns
- Insecure JWT secret fallback (see Open Issues #4)
- No rate limiting (Open Issues #5)
- No CSRF protection beyond `sameSite: 'lax'` cookie setting
- No audit logging for balance-changing operations

---

## Database Changes Log

### Initial schema (2026-05-30, commit `003d40a`)
- `users`: `id, name, username, email, phone, password_hash, balance (default 100.00), province, avatar_color, created_at`
- `friends`: `id, user_id, friend_id, status (pending/accepted), created_at` — unique on `(user_id, friend_id)`
- `transactions`: `id, sender_id, receiver_id, amount, note, type (payment/request), status (completed/pending/declined), privacy (public/friends/private), created_at`

### US support migration (2026-05-30, commit `2e73fcb`)
- `users`: added `country TEXT NOT NULL DEFAULT 'CA'`
- `transactions`: added `currency TEXT NOT NULL DEFAULT 'CAD'`
- **Decision**: currency is determined by the **sender's** country at transaction creation time; no FX conversion performed

### No schema changes (2026-06-14, commit `b18220d`)
- Only DB *file location* changed (path moves to `/tmp/data/manna.db` on Vercel); schema unchanged

### Migration to Neon Postgres (2026-06-14, commit `fc9c769`)
- Storage engine changed from `better-sqlite3` (file-based) to **Neon Postgres** via `@neondatabase/serverless`
- `id` columns: `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`
- `created_at` columns: SQLite `TEXT DEFAULT (datetime('now'))` → `TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- Table structure (columns, defaults, constraints) otherwise preserved 1:1 from the SQLite schema
- User/content search switched to Postgres `ILIKE` for case-insensitive matching
- **Decision**: schema creation remains lazy/idempotent (`CREATE TABLE IF NOT EXISTS` in `initializeSchema()`), now invoked explicitly in the register route rather than on every DB access

---

## API Changes Log

### Added (2026-05-30, initial build)
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me`
- `GET /api/users` (search)
- `GET/POST/DELETE /api/friends`
- `GET/POST /api/transactions` (feed, history, create payment/request)
- `PATCH /api/transactions/[id]` (accept/decline)

### Modified (2026-05-30, US support)
- `POST /api/auth/register` — now accepts `country` field
- `GET /api/me` — now returns `country` field
- `GET/POST /api/transactions` — POST now derives and stores `currency` (CAD/USD) from sender's country; GET responses include `currency` per transaction

### Modified (2026-06-14, auth fix)
- No endpoint signature changes; internal auth cookie name changed from `venmac-token`/`carls-way-token` (inconsistent) to `manna-token` consistently across `lib/auth.ts` and `proxy.ts`

### Modified (2026-06-14, Postgres migration, commit `fc9c769`)
- No request/response shape changes for any endpoint — `auth/register`, `auth/login`, `me`, `users`, `friends`, `transactions`, `transactions/[id]` all switched their internal data access from `better-sqlite3` (sync) to `@neondatabase/serverless` (async tagged-template queries), but contracts are unchanged
- `auth/register` now also calls `initializeSchema()` before inserting, ensuring tables exist on a fresh Neon database

### Removed
- None

---

## Deployment History

| Date | Environment | Change | Notes |
|---|---|---|---|
| 2026-05-30 | Local / dev | Initial build completed, builds clean with `npm run build` | Branch `claude/cool-cerf-ErxD3` created |
| 2026-05-30 | — | US support + Venmac rebrand pushed | Build verified clean |
| ~2026-06 | Vercel | First Vercel deployment attempted | Returned `404: NOT_FOUND` at root — root cause likely a Vercel project configuration issue (Root Directory / production branch), not app code |
| 2026-06-14 | Local / dev | Fixed proxy/auth cookie mismatch, `/tmp` DB path fix for Vercel, completed "manna" rebrand | Build + runtime-verified locally (`/` → 307 → `/login` → 200, `/api/me` → 401). Pushed as commit `b18220d`. Vercel redeploy outcome not yet confirmed in this session. |

**Outstanding deployment action items**:
- Confirm Vercel project's **Root Directory** setting matches repo root
- Confirm Vercel **Production Branch** is set to `claude/cool-cerf-ErxD3` (or merge target)
- Set `JWT_SECRET` env var in Vercel project settings
- Plan migration off SQLite before relying on production data persistence

---

## Design Decisions

1. **Next.js App Router + API routes (monorepo, no separate backend)** — chosen for simplicity and fast iteration; avoids managing a separate server.
2. ~~**SQLite via better-sqlite3 for MVP**~~ — originally chosen for fast local setup with zero external dependencies. **Superseded 2026-06-14**: migrated to Neon Postgres (`@neondatabase/serverless`) because SQLite-on-`/tmp` could not provide durable storage on Vercel's serverless filesystem. Neon was chosen for its serverless-friendly HTTP-based driver (no persistent connection pool needed) and generous free tier.
3. **JWT in httpOnly cookie for auth** — standard, avoids client-side token storage; `proxy.ts` (Next 16's middleware convention, replacing `middleware.ts`) handles route gating centrally.
4. **Single `country` field drives currency** — rather than a separate `currency` preference, a user's country (CA/US) determines their balance currency and the currency stamped onto transactions they initiate. Simpler model; revisit if multi-currency wallets are needed.
5. **Privacy levels (public/friends/private) stored per-transaction** — feed currently only honors `public`; `friends`/`private` enforcement deferred (Open Issue #3).
6. **Branding iterated twice** (Carl's Way → Venmac → manna) per explicit user requests — codebase fully updated each time to avoid stale references; PROJECT_MEMORY.md should be checked for "current brand name" before any new UI work.

---

## Lessons Learned

- **Rebrand sweeps must cover non-obvious files**: the auth cookie mismatch bug (`carls-way-token` vs `venmac-token`) happened because `proxy.ts` was missed during a rename — it wasn't caught by `grep` initially because the search didn't include the root-level `proxy.ts` file. **Always grep the entire repo root, not just `app/` and `lib/`, when renaming.**
- **Next.js 16 uses `proxy.ts`, not `middleware.ts`**, for the middleware convention — this is a breaking change from earlier Next.js versions and is easy to miss if working from memory/training data (per `AGENTS.md` warning).
- **Vercel's filesystem is read-only outside `/tmp`** — any local-file-based storage (SQLite, file uploads) must branch on `process.env.VERCEL` and use `/tmp`, with the caveat that `/tmp` is ephemeral.
- **Paths with parentheses** (e.g. `app/(auth)/login/page.tsx`) break naive `bash -c "cat app/(auth)/..."` — must quote paths or use the `Read` tool directly.
- A local clean build (`npm run build` + `npm start` + curl checks) can validate routing/auth logic even without access to the live Vercel deployment — useful baseline before pushing.
- **Concurrent agent sessions can land conflicting work on the same branch.** A separate agent ran a full SQLite→Postgres migration while this session was also active; `git push` was rejected (non-fast-forward) and required `git fetch` + `git rebase origin/<branch>` before pushing. Always rebase onto the remote branch immediately before pushing, and re-verify the build after rebasing — don't assume your local state is the latest.
- When two sessions touch overlapping concerns (here: DB layer), **PROJECT_MEMORY.md must be reconciled against the rebased code**, not just the changes from your own session — re-check `lib/db.ts` and any files flagged as "modified by another process" before finalizing the memory file.

---

## Next Priorities

1. **Provision Neon Postgres database and set `DATABASE_URL` in Vercel** — confirm `initializeSchema()` succeeds against a real database, app currently throws at runtime without it (Open Issue #9)
2. **Wrap balance transfer in an atomic DB transaction** in `api/transactions/route.ts` using Neon transaction support (Open Issue #2)
3. **Enforce `friends`-privacy filtering** in feed/history queries (Open Issue #3)
4. **Fail fast on missing `JWT_SECRET`** in production (Open Issue #4)
5. **Confirm and fix remaining Vercel deployment configuration** (Root Directory, production branch) so the live URL serves the app end-to-end
6. Add cursor-based pagination to feed/history (Open Issue #6)
7. Add rate limiting to auth/transaction endpoints (Open Issue #5)
8. Decide on cross-currency (CA↔US) transaction policy — block, convert, or label only (Open Issue #7)
9. Email verification + password reset (Open Issue #8)
10. Extract shared currency-formatting helper (`lib/format.ts`) to remove duplication

---

## Session History

### Session 1 — 2026-05-30
- **Objectives**: Build a Venmo-style P2P payment app for Canada from scratch
- **Work completed**: Full Next.js 16 + TypeScript + Tailwind + better-sqlite3 app — auth, wallet, send/request money, social feed, friends, transaction history, profile with mock bank transfer UI. Branded "Carl's Way" (red/white, maple-leaf theme).
- **Files changed**: Entire `app/`, `lib/`, config files (commit `003d40a`)
- **Remaining work**: US support, branding finalization, deployment

### Session 2 — 2026-05-30
- **Objectives**: Extend the app to support US users; rename app to "Venmac"
- **Work completed**: Added `country`/`currency` model (CA/CAD and US/USD), dynamic province/state selection on registration, currency-aware UI across profile/send/request/feed/history/layout, ACH vs Interac copy for US vs CA. Renamed app from "Carl's Way" to "Venmac" across UI, metadata, cookie, DB filename.
- **Files changed**: `lib/db.ts`, `lib/auth.ts`, `app/api/auth/register/route.ts`, `app/api/me/route.ts`, `app/api/transactions/route.ts`, `app/(auth)/*`, `app/(app)/*`, `app/layout.tsx` (commit `2e73fcb`)
- **Remaining work**: Deployment to Vercel, fix any deployment-specific issues

### Session 3 — 2026-06-14
- **Objectives**: Fix Vercel `404: NOT_FOUND` at root; complete rebrand to "manna"
- **Work completed**: Diagnosed and fixed a critical auth cookie name mismatch between `proxy.ts` and `lib/auth.ts` (broken auth routing on every request). Fixed SQLite DB path to use `/tmp` on Vercel. Completed rebrand from "Venmac" to "manna" across all UI/metadata/config. Verified clean build and correct local routing behavior (`/` → `/login` → 200, `/api/me` → 401).
- **Files changed**: `proxy.ts`, `lib/auth.ts`, `lib/db.ts`, `app/layout.tsx`, `app/(app)/layout.tsx`, `app/(auth)/login/page.tsx`, `app/(auth)/register/page.tsx`, `package.json` (commit `b18220d`)
- **Remaining work**: Confirm live Vercel deployment now resolves; address durable-database migration before relying on production data; tackle Next Priorities list

### Session 4 — 2026-06-15
- **Objectives**: Create `PROJECT_MEMORY.md` as persistent project memory / single source of truth
- **Work completed**: Authored `PROJECT_MEMORY.md` covering overview, architecture, completed features, open issues, technical debt, database/API change logs, deployment history, design decisions, lessons learned, next priorities, and session history (sessions 1–3 reconstructed from git history and prior session context).
- **Files changed**: `PROJECT_MEMORY.md` (new file)
- **Remaining work**: Keep this file updated after every future session; begin work on Next Priorities list (DB migration is top priority)

### Session 5 — 2026-06-14/15 (concurrent migration + memory reconciliation)
- **Objectives**: Reconcile `PROJECT_MEMORY.md` with a concurrent agent session that migrated the database from SQLite to Neon Postgres
- **Work completed**: While preparing to push `PROJECT_MEMORY.md`, discovered (via rejected non-fast-forward push) that another agent run had pushed commit `fc9c769` — a full migration from `better-sqlite3` to `@neondatabase/serverless` (Neon Postgres), addressing the #1 open issue/priority from this file. Rebased onto `origin/claude/cool-cerf-ErxD3`, re-ran a clean build with a dummy `DATABASE_URL` to confirm it still compiles, and rewrote the affected sections of `PROJECT_MEMORY.md` (Architecture/Database, Completed Features #4, Open Issues #1 resolved + new #9, Database Changes Log, API Changes Log, Design Decisions, Lessons Learned, Next Priorities) to reflect the new Postgres-backed architecture.
- **Files changed**: `PROJECT_MEMORY.md` (this session's edits); `lib/db.ts` and all `app/api/**/route.ts` files changed by the concurrent session (commit `fc9c769`, not authored in this session)
- **Remaining work**: Provision a real Neon database and set `DATABASE_URL` + `JWT_SECRET` in Vercel (Open Issue #9); then proceed to atomic balance transfers (Open Issue #2) and friends-privacy enforcement (Open Issue #3)
