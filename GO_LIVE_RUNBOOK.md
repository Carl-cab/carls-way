# Manna Go-Live Runbook

**Purpose:** The exact, ordered steps to take Manna from sandbox to live money movement.
**Audience:** The account owner + engineering. Many steps are owner-only and external.
**Golden rule:** Do not enable a live flag until every prerequisite above it in this document is complete. Live flags default OFF and must be set deliberately.

**Verified against:** `master` at `e0f3f0d`, on 2026-10-26, by reading the tree
— not by exercising any rail. `e0f3f0d` is the tip after Sprint 1's five
merges (#69 `1bc81df`, #68 `ce7255a`, #67 `a08c82f`, #71 `0b609f4`, #70
`e0f3f0d`); the previous anchor read `1bc81df`, the first of those five. None
of the five touched a live flag or any rail, so **no box in this document
changed state as a result** — re-anchored to keep the line honest about what
tree it was read against, which is the whole point of having it.

This line exists because the value of a go/no-go procedure is entirely in its
currency: §4.1 read "NOT YET BUILT" for an endpoint that had been built and
merged, and an operator who finds one stale blocker has no way to tell which of
the others are stale too. **Re-anchor this line whenever the document is
revised, and treat an unanchored copy as unverified.**

A box checked here means *verified in the tree or by a recorded run*, named in
the item. It never means "exercised against a live rail" — nothing in this
repository has been.

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

### 4.1 Execute endpoint (🟢 BUILT — verified in code, never run against a live rail)

The live provider lifecycle is: `createIntent → review → confirm (ready) → **executeTransfer** (processing) → webhook → settled`.

**This section said "NOT YET BUILT" until 2026-10-26, which was wrong.**
`app/api/transfers/[id]/execute/route.ts` exists on `master` at `e0f3f0d`.
Corrected because a go/no-go document is only usable if every unchecked box is
genuinely unchecked — one stale blocker teaches an operator to discount the
rest. (This line cited `1bc81df` after the header anchor had moved to
`e0f3f0d`, which is the same staleness one level down. The execute, webhook,
provider and settlement paths are **unchanged** between those two commits —
`git diff --name-status 1bc81df e0f3f0d` over them returns nothing — so the
evidence carries to the current anchor rather than needing to be re-read.)

- [x] `POST /api/transfers/[id]/execute` exists and loads the intent, verifies
      ownership and `status = 'ready'`, reselects the provider through the
      factory, calls `provider.executeTransfer()` (sandbox providers throw by
      design) and records `processing`.
- [x] Gated to `execution_mode = 'live'`. It also refuses when the factory
      returns a *sandbox* provider, **before** claiming the intent, so a
      disabled rail cannot strand an intent in `submitting`.
- [x] Idempotency guard present: a stable key derived from the intent id is
      persisted *before* the provider call, and the claim runs inside a
      transaction with `SELECT ... FOR UPDATE`. It is the key, not the lock,
      that prevents a duplicate submission — **but only while the provider
      still holds that idempotency record.** This box previously said the key
      "guarantees a single debit" without qualification, which overstates it:
      provider idempotency records are retained for a bounded period, not
      forever, and `submitting` is deliberately retryable here (a caller that
      finds `submitting` with no reference recorded retries, because that state
      is indistinguishable from a crash between the provider call and the local
      write). So a retry that lands *after* the provider has expired the record
      is not protected by it and must go through reconciliation
      (`POST /api/admin/transfers/[id]/reconcile`) rather than through another
      execute. The exact retention window is the provider's, is not verified
      here, and is not a number this document should assert — confirm it
      against Plaid's and Stripe's current documentation before relying on any
      specific duration.
- [x] Rate limited per user id (`money:transfer-execute`) — the claim stops one
      intent being submitted twice but not how many intents one account pushes
      at a rail.
- [ ] **Still required before live:** exercise this endpoint end to end in the
      Plaid/Stripe **sandbox** with a live-shaped intent. Code review is not
      execution, and no transfer has ever been submitted to a rail.

### 4.2 Webhook settlement path (🟡 PARTIAL — handlers verified present, settlement never exercised on a rail)

Verified by reading `master` at `e0f3f0d`, not by running a rail. (Cited
`1bc81df` until 2026-10-26; the webhook and settlement paths are unchanged
between the two, so the reading stands at the current anchor.)

- [x] `app/api/webhooks/plaid/route.ts` exists and handles
      `TRANSFER_EVENTS_UPDATE` (the event Plaid actually sends; this section
      previously named `TRANSFER.STATUS_UPDATE`), with
      `lib/settlement/plaid-event-adapter.ts` mapping Plaid transfer statuses
      onto settlement events and `plaid_transfer_event_cursors` persisting the
      sync position.
- [x] `app/api/webhooks/stripe/route.ts` exists and handles
      `payment_intent.succeeded`, `charge.succeeded|failed|updated` and
      `payout.created|paid|failed|canceled`.
- [x] **Balance mutation boundary holds.** `PlaidTransferProvider.ts` and
      `CanadianEFTProvider.ts` contain **zero** references to `balance_cad` or
      `balance_usd` — measured, not assumed. Balances are written only by
      `lib/settlement/SettlementExecutor.ts` and
      `lib/settlement/apply-settlement.ts`.
- [ ] **Still required before live:** a webhook-driven
      `processing → settled/failed/returned` transition observed in a provider
      sandbox, and a dead-letter replay drill. Both are listed under
      operational proof and neither has been run.

### 4.3 Stripe SDK version pin (🟢 DONE)

- [x] `lib/stripe.ts` pins `apiVersion: '2026-06-24.dahlia'`. Installed
      `stripe@22.3.2` declares that exact string as `LatestApiVersion`, and
      `pnpm typecheck` is clean against it. No dependency change was required.
      The earlier type error was against `stripe@22.2.1`, which is not what
      `package.json` or the lockfile install.

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
| `PLAID_SECRET` | **production** secret | not sandbox; must match `PLAID_ENV` |
| `PLAID_ENV` | `production` | Code reads `PLAID_ENV`, not `NEXT_PUBLIC_PLAID_ENV`. Unset means **sandbox**. Set `production` only when the secret above is the production secret. |
| `WISE_API_KEY` | production token | |
| `WISE_ENV` | `production` | |
| `PLAID_TOKEN_ENCRYPTION_KEY` | 64-char hex | `openssl rand -hex 32`; never reuse dev key |
| `STRIPE_SECRET_KEY` | `sk_live_…` | live key triggers real KYC automatically |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | from live webhook endpoint |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_…` | Browser key for the Canadian ACSS mandate. Must belong to the same Stripe account as `STRIPE_SECRET_KEY`. |
| `NEXT_PUBLIC_APP_URL` | `https://<prod-domain>` | no trailing slash |
| `MANNA_ENV` | leave unset | Unset resolves to production. The only sandbox opt-in is the exact value `sandbox`, and `VERCEL_ENV=production` overrides it. Do not set `sandbox` on the production go-live. |
| `CRON_SECRET` | long random string | `Authorization: Bearer` credential for `/api/cron/*`. The reconciliation cron returns 503 when this is unset. |
| `REDIS_URL` | Redis connection URL | Optional. When set, rate limits use Redis; when unset, they use an in-process map. |
| `PLAID_TRANSFER_LIVE` | `true` | ⚠️ SET LAST — enables live US ACH |
| `CA_EFT_LIVE` | `true` | ⚠️ SET LAST — enables live CA EFT |

---

## 6. Database Migration (🟡 PARTIAL — the convergent reconciler has been run; one gated migration has not)

**`POST /api/migrate` has already been run against production** (recorded in
`CLAUDE.md` → Current Priorities). What remains here is not the reconciler but
the authorization-gated migration below, plus re-running the reconciler after
any *future* schema change. The step list is therefore a per-deploy procedure,
not an outstanding blocker:

- [ ] **Outstanding and separate:** apply the early-webhook correlation index
      migration through the authorized maintenance procedure in
      `sql/README.md`. It is deliberately **not** part of `/api/migrate`.
- [ ] **Per deploy, repeat:** deploy the code first (Vercel auto-deploys on push to `master`).
- [ ] **Per deploy, repeat:** call `POST /api/migrate` once, authenticated, to apply any `ALTER TABLE` changes
      (`curl -X POST -b <auth-cookie> https://<host>/api/migrate`). It is POST,
      not GET: a state-changing GET was reachable by cross-site request
      forgery. GET now answers 405 with a pointer.
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
