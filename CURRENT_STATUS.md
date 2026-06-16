# Manna — Current Status

Last updated: 2026-06-16

---

## What's Working

- **Auth**: Registration, login, JWT cookie, route guard via `proxy.ts`
  - `JWT_SECRET` now throws in production if unset (no silent dev fallback)
- **Payments**: Send / request / accept / decline — dual-currency (`balance_cad`/`balance_usd`), cross-border FX via Wise, velocity limits, audit logging
- **Activity feed**: Public feed; History page with working `sent / received / pending` filter chips
- **Friends**: Friend list (auto-accepted; no approval UI yet)
- **Bank linking**: Plaid Link flow, token exchange; tokens AES-256-GCM encrypted at rest (`is_token_encrypted = true` set on every new account)
- **KYC**: Stripe Identity session creation, webhook handler updating `kyc_status` server-side, profile KYC card with live states

---

## Security Gates in Place

- `requireEncryptedBankToken(userId, bankAccountId)` in `lib/plaid.ts`:
  - Returns decrypted token only when `is_token_encrypted = true`
  - Throws `RELINK_REQUIRED_MESSAGE` for legacy plaintext rows — callers must surface this to the user
- `kyc_status` can only be set server-side (webhook or create-session); no client path to set it
- Plaid access token never returned to the browser
- `JWT_SECRET` missing in production throws at request time

---

## Resolved Bugs / Security Issues

- Request acceptance used legacy `balance` — fixed
- Activity filter chips non-functional — fixed
- Frontend password validation mismatch — fixed
- Plaid access tokens stored in plaintext — fixed (AES-256-GCM)
- `JWT_SECRET` silent dev fallback in production — fixed

---

## In Progress / Next

1. **Add Money / Cash Out** — profile buttons still inert; no API routes exist yet
   - Must check `kyc_status === 'verified'` before any transfer
   - Must call `requireEncryptedBankToken()` — do not read `plaid_access_token_enc` directly
2. **KYC live test** — set Stripe env vars in Vercel, run `/api/migrate`, register webhook

---

## Env Vars Required in Vercel

| Variable | Status |
|---|---|
| `DATABASE_URL` | Set |
| `JWT_SECRET` | Set (production throws if missing) |
| `PLAID_CLIENT_ID` | Set |
| `PLAID_SECRET` | Set |
| `NEXT_PUBLIC_PLAID_ENV` | Set |
| `WISE_API_KEY` | Set |
| `WISE_ENV` | Set |
| `PLAID_TOKEN_ENCRYPTION_KEY` | Confirm set |
| `STRIPE_SECRET_KEY` | Needs to be set |
| `STRIPE_WEBHOOK_SECRET` | Needs to be set |
| `NEXT_PUBLIC_APP_URL` | Needs to be set |

---

## After Next Deploy

1. Call `GET /api/migrate` (authenticated) to add `is_token_encrypted` column to production `bank_accounts`
2. Register Stripe webhook: `https://carloscab74.vercel.app/api/webhooks/stripe`
   - Events: `identity.verification_session.verified`, `identity.verification_session.requires_input`
