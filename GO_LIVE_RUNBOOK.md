# Manna Go-Live Runbook

**Purpose:** The exact, ordered steps to take Manna from sandbox to live money movement.
**Audience:** The account owner + engineering. Many steps are owner-only and external.
**Golden rule:** Do not enable a live flag until every prerequisite above it in this document is complete. Live flags default OFF and must be set deliberately.

---

## 0. Reality Check — Read First

Manna today runs in **sandbox mode**. That means:

- Every user gets a $100 seed balance that is **not backed by real funds**.
- Sandbox "Add Money" credits the platform balance with **no real bank debit** behind it.
- P2P sends move these **internal ledger balances**, not real money.

**You cannot flip a switch to make this live.** Going live safely requires legal
authorization, provider approvals, live credentials, a real funding/settlement
model, and one remaining code endpoint. This runbook covers all of it, in order.

There are three classes of work below:
- 🔴 **OWNER-ONLY / EXTERNAL** — legal, provider approvals, credentials. Claude cannot do these.
- 🟡 **ENGINEERING** — code that still must be built/verified before live.
- 🟢 **DONE / READY** — already implemented and gated behind flags.

---

## 1. Legal & Regulatory (🔴 OWNER-ONLY) — BLOCKING

Transmitting money between the US and Canada is regulated money transmission.
**Operating live without this is illegal.** None of the technical steps matter until this is resolved.

- [ ] **US:** Obtain money transmitter licenses (MTLs) in each state you operate in, **or**
      partner with a licensed sponsor bank / BaaS provider (e.g. via a program manager)
      who holds the licenses and provides an FBO ("for benefit of") account structure.
- [ ] **Canada:** Register as a Money Services Business (MSB) with **FINTRAC**.
- [ ] **Compliance program:** Written AML/KYC policy, designated compliance officer,
      SAR/STR filing process, sanctions/OFAC + Canadian sanctions screening,
      record-retention policy (see the Operations Manual §10).
- [ ] **Terms of Service & Privacy Policy** reviewed by counsel; user consent captured at signup.
- [ ] **Cross-border FX disclosure** requirements reviewed (rate, fee, timing disclosures).

> Until this section is fully checked, keep both live flags OFF. Nothing downstream is safe.

---

## 2. Funding & Settlement Model (🟡 ENGINEERING + 🔴 OWNER) — BLOCKING

The current model credits balances with no real money behind them. Before live,
real funds must back every balance.

- [ ] **FBO / omnibus account** established with the sponsor bank / provider to hold customer funds.
- [ ] **Add Money** must move real money bank → FBO before crediting the ledger
      (today the sandbox credits on confirm with nothing behind it).
- [ ] **Cash Out** must move real money FBO → bank.
- [ ] **P2P sends** debit/credit internal ledger balances that are backed 1:1 by the FBO balance.
- [ ] **Cross-border** requires a funded position in **both** CAD and USD (or an FX
      liquidity provider such as Wise Platform) so the recipient can be paid in their currency.
- [ ] **Daily reconciliation** of ledger totals against the FBO bank balance (Operations Manual §6).

> This is the single biggest gap. The live *providers* exist; a funded settlement
> model does not. Do not go live on P2P/cross-border until balances are fund-backed.

---

## 3. Provider Approvals (🔴 OWNER-ONLY, lead time: days–weeks)

- [ ] **Plaid Transfer (US ACH):** Request and complete Plaid Transfer product
      enablement/underwriting on your Plaid account. Standard Plaid link/auth is
      **not** the same as Transfer. Confirm `transfer` is in your product list.
- [ ] **Stripe (CA ACSS / KYC):** Enable live mode; complete platform/Connect
      onboarding if using Payouts for cash-out; enable **ACSS Debit** (pre-authorized debit)
      and **Stripe Identity** in live mode.
- [ ] **Wise:** Obtain a production API key (and Wise Platform agreement if using it for FX liquidity).

---

## 4. Remaining Code Work (🟡 ENGINEERING) — BLOCKING for live transfers

### 4.1 Execute endpoint (NOT YET BUILT)

The live provider lifecycle is: `createIntent → review → confirm (ready) → **executeTransfer** (processing) → webhook → settled`.

Today there is **no** `POST /api/transfers/[id]/execute` route. Without it a live
transfer stops at `ready` and never submits to Plaid/Stripe.

- [ ] Build `POST /api/transfers/[id]/execute` that:
  - loads the intent, verifies ownership and `status = 'ready'`,
  - reselects the provider via `getTransferProvider(region, toExecutionMode(execution_mode))`,
  - calls `provider.executeTransfer(intentId, userId)` (sandbox providers throw by design — good),
  - returns the resulting `processing` status.
- [ ] Gate it so it is only reachable for `execution_mode = 'live'` intents.
- [ ] Add an idempotency guard so a double-submit cannot create two ACH/ACSS transfers.

### 4.2 Webhook settlement path (VERIFY)

- [ ] Confirm `app/api/webhooks/plaid` handles `TRANSFER.STATUS_UPDATE` and drives the
      SettlementOrchestrator/Executor to move `processing → settled/failed/returned`.
- [ ] Confirm `app/api/webhooks/stripe` handles ACSS PaymentIntent/Payout events similarly.
- [ ] Confirm the SettlementExecutor updates balances **only** on settlement (never in the provider).

### 4.3 Stripe SDK version pin (VERIFY)

- [ ] `lib/stripe.ts` pins `apiVersion: '2026-06-24.dahlia'`. Ensure the installed
      `stripe` package version's types include that version (pin `stripe` in
      package.json to a matching version) so CI/`tsc` build is clean. This currently
      type-errors against `stripe@22.2.1`.

### 4.4 Ready and gated (🟢 DONE)

- Live providers implemented: `PlaidTransferProvider`, `CanadianEFTProvider`.
- Factory routing + `resolveExecutionMode()` gate live behind `PLAID_TRANSFER_LIVE` / `CA_EFT_LIVE`.
- Transfer routes (intent/review/confirm) resolve and persist execution mode per intent.
- KYC auto-verifies in sandbox and engages live Stripe Identity automatically once a live key is set (see `kyc-sandbox-verify` branch).

---

## 5. Live Environment Variables (🔴 OWNER-ONLY, set in Vercel)

Set these in the Vercel project (Production scope). **Add the two live flags LAST.**

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase prod pooler URL | Production database |
| `JWT_SECRET` | long random string | Rotate from any dev value |
| `PLAID_CLIENT_ID` | live client id | |
| `PLAID_SECRET` | **production** secret | not sandbox |
| `NEXT_PUBLIC_PLAID_ENV` | `production` | |
| `WISE_API_KEY` | production token | |
| `WISE_ENV` | `production` | |
| `PLAID_TOKEN_ENCRYPTION_KEY` | 64-char hex | `openssl rand -hex 32`; never reuse dev key |
| `STRIPE_SECRET_KEY` | `sk_live_…` | live key triggers real KYC automatically |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | from live webhook endpoint |
| `NEXT_PUBLIC_APP_URL` | `https://<prod-domain>` | no trailing slash |
| `PLAID_TRANSFER_LIVE` | `true` | ⚠️ SET LAST — enables live US ACH |
| `CA_EFT_LIVE` | `true` | ⚠️ SET LAST — enables live CA EFT |

---

## 6. Database Migration (🟡 ENGINEERING)

- [ ] Deploy the code first (Vercel auto-deploys on push to `master`).
- [ ] Call `GET /api/migrate` once, authenticated, to apply any `ALTER TABLE` changes
      to the production database (adds `provider_region`, `provider_name`,
      `execution_mode`, `consent_confirmed_at`, `idempotency_key`, `bank_account_id`,
      and any live-provider columns such as `plaid_account_id`).
- [ ] Verify `transfer_intents` and `ledger_entries` schemas match `lib/db.ts`.

---

## 7. Webhook Registration (🔴 OWNER-ONLY)

- [ ] **Plaid dashboard:** register the Transfer webhook → `https://<prod>/api/webhooks/plaid`.
- [ ] **Stripe dashboard → Webhooks (live):** add endpoint `https://<prod>/api/webhooks/stripe`,
      subscribe to Identity, PaymentIntent, and Payout events; copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
- [ ] Confirm both endpoints return 200 on a test event.

---

## 8. Go-Live Sequence (do in this order)

1. [ ] §1 Legal, §2 Funding, §3 Approvals all complete.
2. [ ] §4 Execute endpoint built + webhook settlement verified in **Plaid/Stripe sandbox** first.
3. [ ] Merge feature branches to `master` via PR; CI/build green.
4. [ ] Set §5 env vars **except** the two live flags. Deploy. Run §6 migration. Register §7 webhooks.
5. [ ] Smoke test in production with **live flags still OFF** (sandbox behavior on prod infra).
6. [ ] Enable `PLAID_TRANSFER_LIVE=true` for US only. Run one small real add-money
       ($1) end-to-end: intent → review → confirm → execute → webhook → settled →
       reconcile against FBO. Verify ledger + balance.
7. [ ] Run one small real cross-border US→CA ($1). Verify FX, recipient credit, reconciliation.
8. [ ] Enable `CA_EFT_LIVE=true`. Repeat the $1 add-money and CA→US tests.
9. [ ] Monitor first 24h closely (Operations Manual §3 daily review, §8 incident response).

---

## 9. Rollback

- [ ] **Instant kill switch:** set `PLAID_TRANSFER_LIVE=false` and `CA_EFT_LIVE=false`
      in Vercel and redeploy. New transfers immediately fall back to sandbox; **in-flight
      live transfers already at `processing` continue to settle via webhook** — do not
      assume the flag reverses them.
- [ ] **Full rollback:** Vercel → Deployments → promote the previous known-good deployment.
- [ ] Have the Operations Manual §8 (incident response) and §11 (escalation) on hand.

---

## 10. Definition of "Live"

Manna is genuinely live only when **all** are true:

- [ ] Legally authorized (licenses/sponsor bank + FINTRAC MSB) and compliance program operating.
- [ ] Customer funds held in a real FBO account, reconciled daily.
- [ ] Add Money / Cash Out move real money; balances are 1:1 fund-backed.
- [ ] Execute endpoint live; webhooks settle transfers; SettlementExecutor updates balances.
- [ ] Both live flags enabled after successful $1 end-to-end tests in each direction.

Until every box is checked, Manna is a functional **sandbox** — safe to demo, not to move real money.
