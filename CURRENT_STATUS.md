# Manna — Current Status

Last updated: 2026-06-16

---

## What's Working (Production Validated)

- **Auth**: Registration, login, JWT cookie, route guard via `proxy.ts`
  - `JWT_SECRET` now throws in production if unset (no silent dev fallback)
- **Payments**: Send / request / accept / decline — dual-currency (`balance_cad`/`balance_usd`), cross-border FX via Wise, velocity limits, audit logging
- **Transaction receipts**: `/transactions/[id]` — full receipt with status badge, FX breakdown, settlement date, copy-ID button; accessible only to sender/receiver (404 for others); feed and history cards tap to open receipt
- **Activity feed**: Public feed (`/api/feed` returns `privacy='public'` transactions); History page with working `sent / received / pending` filter chips
- **Notifications**: In-app notifications for friend requests, friend accept, payment received, money requested; unread badge in nav; `/notifications` page with mark-one / mark-all-read; click to navigate to related entity; 30-second polling in layout
- **Public receipt view**: Non-parties can see that a transaction is public but cannot access the full receipt; receipt page shows friendly message explaining privacy
- **Password reset**: Secure password reset flow via email; `POST /api/auth/forgot-password` (never reveals user existence), `POST /api/auth/reset-password` (validates token hash, single-use, 1-hour expiry); `/forgot-password` and `/reset-password` pages with full validation; login page has "Forgot password?" link; tokens are hashed (SHA-256) and stored with expiry
- **Friends**: Full approval flow — send request (pending), incoming requests with Accept/Decline, sent requests, accepted friends list; **Send button** beside each accepted friend routes to `/send?to=<username>` with username pre-filled
  - Production validated: accept ✅ decline ✅ self-add blocked ✅ duplicate blocked ✅
- **Bank linking**: Plaid Link flow, token exchange; tokens AES-256-GCM encrypted at rest (`is_token_encrypted = true` set on every new account)
- **KYC**: Stripe Identity session creation, webhook handler updating `kyc_status` server-side, profile KYC card with live states
- **Schema migration**: `/api/migrate` applied successfully in production — `friends.requested_by`, `friends.updated_at`, `bank_accounts.is_token_encrypted`, all KYC user columns live

---

## Security Gates in Place

- `requireEncryptedBankToken(userId, bankAccountId)` in `lib/plaid.ts`:
  - Returns decrypted token only when `is_token_encrypted = true`
  - Throws `RELINK_REQUIRED_MESSAGE` for legacy plaintext rows — callers must surface this to the user
- `kyc_status` can only be set server-side (webhook or create-session); no client path to set it
- Plaid access token never returned to the browser
- `JWT_SECRET` missing in production throws at request time
- Friend accept/decline: server enforces recipient-only authorization (`friend_id = user.userId`)

---

## Resolved Bugs / Security Issues

- Request acceptance used legacy `balance` — fixed
- Activity filter chips non-functional — fixed
- Frontend password validation mismatch — fixed
- Plaid access tokens stored in plaintext — fixed (AES-256-GCM)
- `JWT_SECRET` silent dev fallback in production — fixed
- Friends auto-accepted with no approval flow — fixed

---

## In Progress / Next

1. **Add Money / Cash Out** — profile buttons still inert; no API routes exist yet
   - Must check `kyc_status === 'verified'` before any transfer
   - Must call `requireEncryptedBankToken()` — do not read `plaid_access_token_enc` directly
2. **KYC live test** — set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` in Vercel; register Stripe webhook

---

## Env Vars Required in Vercel

| Variable | Status |
|---|---|
| `DATABASE_URL` | Set ✅ |
| `JWT_SECRET` | Set ✅ |
| `PLAID_CLIENT_ID` | Set ✅ |
| `PLAID_SECRET` | Set ✅ |
| `NEXT_PUBLIC_PLAID_ENV` | Set ✅ |
| `WISE_API_KEY` | Set ✅ |
| `WISE_ENV` | Set ✅ |
| `PLAID_TOKEN_ENCRYPTION_KEY` | Set ✅ |
| `STRIPE_SECRET_KEY` | Needs to be set |
| `STRIPE_WEBHOOK_SECRET` | Needs to be set |
| `NEXT_PUBLIC_APP_URL` | Needs to be set |
| `RESEND_API_KEY` | Needs to be set |
| `EMAIL_FROM` | Needs to be set |

---

## After Next Deploy

Register Stripe webhook: `https://carloscab74.vercel.app/api/webhooks/stripe`
- Events: `identity.verification_session.verified`, `identity.verification_session.requires_input`
