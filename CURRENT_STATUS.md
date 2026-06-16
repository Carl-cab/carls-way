# Manna — Current Status

Last updated: 2026-06-16

---

## What's Working

- **Auth**: Registration, login, JWT cookie, route guard via `proxy.ts`
- **Payments**: Send money (P2P), request money, accept/decline — all using `balance_cad`/`balance_usd` with cross-border FX via Wise
- **Activity feed**: Public feed; History page with working `sent / received / pending` filter chips
- **Friends**: Friend list (auto-accepted; no approval UI yet)
- **Bank linking**: Plaid Link flow, token exchange, accounts on profile (Plaid tokens AES-256-GCM encrypted at rest via `lib/encryption.ts`)
- **KYC foundation**: Stripe Identity session creation (`POST /api/kyc/create-session`), webhook handler (`POST /api/webhooks/stripe`) updating `kyc_status` server-side, profile KYC card with live states

---

## Resolved Bugs

- Request acceptance used legacy `balance` field — fixed
- Activity filter chips non-functional — fixed
- Frontend password validation mismatched backend — fixed
- Plaid access tokens stored in plaintext — fixed

---

## In Progress / Next

1. Add Money / Cash Out (profile buttons still inert — needs Plaid Transfer or Stripe ACH)
2. KYC live test (needs STRIPE_WEBHOOK_SECRET in Vercel + Stripe sandbox run)

---

## Env Vars Needed in Vercel

| Variable | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | Test key from Stripe dashboard (sk_test_...) |
| `STRIPE_WEBHOOK_SECRET` | From Stripe dashboard webhook endpoint (whsec_...) |
| `NEXT_PUBLIC_APP_URL` | Full origin, e.g. https://carloscab74.vercel.app |
| `PLAID_TOKEN_ENCRYPTION_KEY` | Confirm this is already set |

---

## After Next Deploy

1. Call GET /api/migrate (authenticated) to apply new KYC columns to production
2. Register webhook in Stripe Dashboard pointing to https://carloscab74.vercel.app/api/webhooks/stripe
3. Subscribe to: identity.verification_session.verified, identity.verification_session.requires_input
