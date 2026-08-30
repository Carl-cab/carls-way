# MANNA — Complete Project Context Bundle

> **This is a single self-contained briefing document for an AI assistant.**
> It bundles the project's status, architecture, engineering history, key source
> code, and open risks. Everything needed to reason about the codebase is inline
> below; no external files are required.
>
> Generated from branch `phase3/transfer-safety` @ `5873dac`.
> Repository: https://github.com/Carl-cab/carls-way

---

## 0. Orientation — how to use this document

| Section | Contents |
|---|---|
| 1 | What Manna is, and its honest current status |
| 2 | Architecture and data model |
| 3 | Engineering history: what was done in Phases 1–3 and why |
| 4 | Full source of every security- and money-critical file |
| 5 | The test suites that prove the safety properties |
| 6 | Open blockers, categorised by severity |
| 7 | Suggested next steps |

**The single most important fact:** this application is a *fully working
sandbox*. It is **not deployed**, live money movement is **disabled by feature
flag**, and it is **not ready for live money**. Section 6 explains exactly why.

---

## 1. What Manna is

A peer-to-peer payment application for cross-border money transfers between
Canada and the United States.

- Users register with a country (CA or US) and receive a $100 seed balance in
  their local currency (CAD or USD).
- They send or request money from other users by username.
- Cross-border transfers use live FX rates from the Wise API, with a 0.5% fee;
  the recipient is paid in their own currency.
- Bank accounts link via **Plaid** (US) and **Stripe ACSS** (Canada).
- A social feed shows transactions users explicitly marked public.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript 5 (strict) ·
Tailwind CSS 4 · Supabase PostgreSQL (via `postgres.js`, no ORM) · Vercel.

There is no separate backend service — all server logic runs as Next.js API
routes.

### Current status, stated plainly

| Capability | State |
|---|---|
| Register → KYC → link bank → add money → send → receive → cash out | **Working end-to-end in sandbox** |
| Domestic transfers (US↔US, CA↔CA) | Working — instant, fee-free |
| Cross-border US↔CA with live Wise FX | Working — 0.5% fee |
| Immutable ledger, audit trail, atomic money movement | Working |
| Admin Operations Console (8 pages, RBAC, audit) | Built, but **unusable** — no admin login exists |
| Live money movement (real bank debits/credits) | **DISABLED** — providers implemented, flag-gated off |
| Execute endpoint for live transfers | **DOES NOT EXIST** — live paths are unreachable by design |
| Deployed? | **No.** The live URL runs `master`, which predates all of this work |

**Critically:** customer balances are **not backed by real funds**. The $100 seed
and all sandbox settlement credit balances with no money behind them. A real
FBO/custodial funding model is the single largest gap before any live launch.

### Verification status at time of writing

```
npm ci          PASS
typecheck       PASS (0 errors)
lint            PASS (0 errors, 33 pre-existing unused-var warnings)
tests           PASS (353/353 across 10 files)
build           PASS
13 invariants   PASS
live providers  DISABLED
execute endpoint ABSENT
```

---

## 2. Architecture

```
Client (React 19)
  └── Next.js Middleware (proxy.ts)   ← JWT auth guard + admin edge gate
      └── API Routes (/app/api/)      ← all business logic
          ├── Supabase PostgreSQL     ← primary datastore (postgres.js)
          ├── Plaid API               ← US bank linking + ACH transfers
          ├── Stripe API              ← CA ACSS debit + KYC identity
          └── Wise API                ← live FX rates
```

**Route groups**
- `app/(auth)/` — public: `/login`, `/register`, password reset
- `app/(app)/` — authenticated: `/feed`, `/send`, `/request`, `/history`, `/profile`, `/friends`, `/transfers`
- `app/admin/` — Operations Console (server-guarded)
- `app/api/` — all backend endpoints

**Core tables**

| Table | Purpose |
|---|---|
| `users` | Identity, auth, dual-currency balances (`balance_cad`, `balance_usd`), KYC status |
| `transactions` | P2P money movement, cross-border FX detail |
| `transfer_intents` | Bank transfer lifecycle: draft → ready → submitting → processing → settled/failed |
| `ledger_entries` | Immutable audit ledger of all financial movement |
| `bank_accounts` | Plaid/Stripe-linked external accounts (tokens AES-256-GCM encrypted) |
| `provider_webhook_events` | Webhook dedup — `UNIQUE(provider, provider_event_id)` |
| `admin_users`, `admin_sessions`, `admin_audit_logs` | RBAC + immutable admin audit |

> **Legacy trap:** `users.balance` is a dead column from before the
> dual-currency migration. **Never use it.** Always use `balance_cad` /
> `balance_usd`.

### Transfer lifecycle (bank transfers)

```
POST /api/transfers/intent        → status='draft', provider selected by region
GET  /api/transfers/[id]/review   → review details + region-appropriate consent
POST /api/transfers/[id]/confirm  → records consent, then:
       sandbox → settles immediately (credits/debits balance + ledger entry)
       live    → status='ready', awaiting an execute endpoint that DOES NOT EXIST
```

### Provider selection (the go-live gate)

`lib/providers/TransferProviderFactory.ts` is the **only** place a provider is
instantiated. Live providers are returned **only** when the region's environment
flag is the literal string `'true'`:

- US: `PLAID_TRANSFER_LIVE=true` → `PlaidTransferProvider`
- CA: `CA_EFT_LIVE=true` → `CanadianEFTProvider`
- otherwise → `SandboxUSProvider` / `SandboxCAProvider`

Neither flag is set anywhere. `'TRUE'`, `'1'`, `'false'` all fall back to
sandbox. A database row claiming `execution_mode='live'` **cannot** escalate,
because the factory re-checks the environment flag independently.

---

## 3. Engineering history

The project arrived with four diverged git branches, a broken `npm ci`, 53
failing tests, 111 lint errors, and a KYC fail-open vulnerability. Three phases
of work addressed that.

### Phase 1 — Branch integration

Reconciled four branches into one reviewable baseline **without** merging to
`master`. Backup branches were created for all four heads first.

Findings:
- Only **3 files** were modified on both sides; only `app/api/migrate/route.ts`
  truly conflicted, and both sides were purely additive (`IF NOT EXISTS`).
- `kyc-sandbox-verify` was an **exact patch-id duplicate** of a commit already
  present in the feature branch — correctly *not* merged.
- **`npm ci` was already broken on `master`**: the Stripe ACSS commit added
  `@stripe/*` dependencies to `package.json` without regenerating the lockfile,
  so any CI would have failed to install.
- Empirically mapped Stripe SDK version → pinned API version and pinned
  `stripe@~22.3.2` rather than changing the declared `apiVersion` — changing the
  API version a payment integration negotiates is a behavioural change, not a
  build fix.

### Phase 2 — Security remediation

| Check | Before | After |
|---|---|---|
| Typecheck | 22 errors | **0** |
| Lint | 111 errors | **0** |
| Tests | 53 fail / 83 pass | **0 fail / 316 pass** |
| KYC | fail-**open** | **fail-closed** |
| Admin authorization | 401 only | **enforced** (edge + server + per-permission) |
| CI | none | **green pipeline** |

**Five security fixes:**

1. **KYC fail-open closed (highest severity).** `isStripeLive()` returned false
   when `STRIPE_SECRET_KEY` was *absent* or a test-mode key, and the KYC route
   auto-verified users on that branch. A production deployment that lost its
   Stripe secret would have **silently begun approving every user's identity**.
   Replaced with an explicit environment model (`lib/environment.ts`, §4.1):
   production is the default; `VERCEL_ENV=production` cannot be downgraded; a
   missing/malformed credential raises `ConfigurationError` → HTTP 503 with
   `kyc_status` untouched. `isStripeLive()` was deleted, not patched.

2. **Unguarded ledger mutation.** `/api/admin/ledger/backfill-opening-balances`
   wrote `ledger_entries` behind only *any authenticated customer* plus a shared
   header, and its GET was fully anonymous. Now requires an admin session **and**
   the `exceptions:manage` permission.

3. **Admin pages had no server-side guard.** The console layout was a client
   component, so protection depended on the client failing to fetch data. It is
   now a server component that resolves the session against the database and
   calls `notFound()`.

4. **Stripe webhook returned HTTP 200 on handler failure**, so Stripe never
   retried and financial events were **permanently lost**. Now returns 500
   (safe because signature is verified first and processing is idempotent).

5. **`/api/migrate` executed DDL with zero authentication**, contradicting its
   own documentation.

**Three genuine implementation bugs** were surfaced by fixing the test/lint debt:
- `COUNT(*)` returns a *string* from PostgreSQL (bigint); five admin statistics
  services were doing string concatenation instead of addition.
- `BaseRepository.handleError` re-wrapped every `NotFoundError` into a
  `TransactionError`, erasing error identity.
- `sanitizeCorrelationId` had no defined contract and emitted `--`.

### Phase 3 — Transfer safety

Made the live-transfer architecture safe **before** exposing execution.

**Plaid:**
- Provider idempotency is created and persisted when the transfer intent is
  created. That persisted key is reused unchanged for execution, retries, and
  recovery; if a legacy row has no persisted key, the deterministic fallback is
  derived from the durable `transfer_intents.id`. The execution path never
  generates a new `Date.now()`-based key, request ID, or other fresh value.
- **SDK finding that changed the design:** in `plaid@42.2.0`,
  `TransferCreateRequest.idempotency_key` is `@deprecated` — the type docs state
  *"Deprecated. `authorization_id` is now used as idempotency instead."* So the
  authorization is persisted **before** `transferCreate`, which is what makes a
  provider-success/database-failure window recoverable.
- New `submitting` state so "provider outcome unknown" can never be confused
  with `failed`.
- **A third defect found during the work:** `SELECT … FOR UPDATE` ran *outside*
  a transaction, so the lock released immediately and gave **no** concurrency
  protection at all.
- `transferAuthorizationCreate` now also receives the stable key (that call's
  `idempotency_key` *is* supported and not deprecated).

**Canadian ACSS — audited, not assumed equivalent:**
- It had **no idempotency of any kind**, plus the same two defects.
- Its semantics genuinely differ from Plaid's:
  - no separate authorization step (`paymentIntents.create({confirm:true})` and
    `payouts.create` each move money in one call);
  - Stripe idempotency is a **request option**, not a body field;
  - `paymentIntents.search` exists but **`payouts.search` does not**.
- Reconciliation therefore uses authoritative metadata lookup for add-money and
  idempotent replay for cash-out. **No shared abstraction was forced** across the
  two providers — that would have concealed the difference rather than reduced
  risk.

**35 targeted safety tests** (17 Plaid + 18 ACSS) cover normal success,
duplicate execution, process restart, concurrency, provider timeout, confirmed
failure, provider-success-with-lost-write recovery, and webhook races in four
orderings.

---

## 4. Source code — security and money-critical files

Every file below is complete and unmodified.


### 4.1 Environment model — the KYC fail-closed gate


#### `lib/environment.ts`

```typescript
/**
 * Deployment environment resolution.
 *
 * SECURITY CONTRACT — read before changing anything in this file.
 *
 * Permissive ("sandbox") behaviour must be an explicit, positive opt-in. It is
 * never inferred from the absence of a credential, because "credential is
 * missing" and "this is a development machine" are different facts, and
 * conflating them means a production deployment with a misconfigured secret
 * silently degrades into permissive mode.
 *
 * Rules enforced here:
 *
 *  1. Sandbox requires `MANNA_ENV=sandbox`, spelled exactly. Anything else —
 *     unset, empty, typo'd, "dev", "test", "SANDBOX_" — resolves to production.
 *  2. Production is the default. An unconfigured deployment is treated as
 *     production and therefore fails closed, rather than opening up.
 *  3. `VERCEL_ENV=production` overrides `MANNA_ENV=sandbox`. A production
 *     deployment target can never be downgraded into permissive mode by an
 *     environment variable, however it was set.
 *  4. A missing or malformed credential is a *configuration error*, surfaced as
 *     ConfigurationError. It is never an environment signal.
 */

export type DeploymentEnvironment = 'production' | 'sandbox';

/**
 * Raised when the deployment is production but a capability it depends on is
 * not configured. Callers must translate this into a controlled failure —
 * never into a permissive fallback.
 */
export class ConfigurationError extends Error {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.capability = capability;
  }
}

/**
 * Resolve the deployment environment.
 *
 * Production is the default. Sandbox is only ever returned for an exact,
 * explicit `MANNA_ENV=sandbox`, and never on a Vercel production deployment.
 */
export function getDeploymentEnvironment(): DeploymentEnvironment {
  // Rule 3 — the platform's own production signal wins over anything else.
  // Checked first so that no value of MANNA_ENV can weaken a production deploy.
  if (process.env.VERCEL_ENV === 'production') {
    return 'production';
  }

  const declared = process.env.MANNA_ENV?.trim().toLowerCase();

  // Rule 1 — exact positive opt-in only.
  if (declared === 'sandbox') {
    return 'sandbox';
  }

  // Rule 2 — unset / unknown / malformed all resolve to production.
  return 'production';
}

export function isSandboxEnvironment(): boolean {
  return getDeploymentEnvironment() === 'sandbox';
}

export function isProductionEnvironment(): boolean {
  return getDeploymentEnvironment() === 'production';
}

/**
 * Stripe secret keys are `sk_live_…` (live) or `sk_test_…` (test mode).
 * Anything else is not a usable Stripe secret key.
 */
function isWellFormedStripeSecretKey(key: string): boolean {
  return /^sk_(live|test)_[A-Za-z0-9]/.test(key);
}

/**
 * Assert that identity verification (KYC) can actually be performed.
 *
 * In production this requires a present, well-formed Stripe secret key. If that
 * is missing or malformed the function throws ConfigurationError, and the caller
 * must fail the request. It must NOT fall back to approving the user.
 *
 * In sandbox this is a no-op: sandbox does not call Stripe at all.
 */
export function assertKycProviderConfigured(): void {
  if (isSandboxEnvironment()) {
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;

  if (!key || key.trim() === '') {
    throw new ConfigurationError(
      'kyc',
      'STRIPE_SECRET_KEY is not set. Identity verification cannot run in production without it.',
    );
  }

  if (!isWellFormedStripeSecretKey(key.trim())) {
    throw new ConfigurationError(
      'kyc',
      'STRIPE_SECRET_KEY is malformed. Identity verification cannot run in production with an unusable key.',
    );
  }
}

/**
 * Whether automatic (non-provider) identity verification is permitted.
 *
 * True only in an explicitly declared sandbox environment. This is the single
 * gate guarding auto-verification; it deliberately consults no credential.
 */
export function canAutoVerifyIdentity(): boolean {
  return isSandboxEnvironment();
}
```


#### `app/api/kyc/create-session/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { getAuthUser, auditLog } from '@/lib/auth';
import { getSql } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import {
  canAutoVerifyIdentity,
  assertKycProviderConfigured,
  ConfigurationError,
} from '@/lib/environment';

/**
 * Start identity verification.
 *
 * Fail-closed contract: auto-verification is gated solely on an explicitly
 * declared sandbox environment (`MANNA_ENV=sandbox`). It never consults whether
 * a credential happens to be present, so a production deployment with a missing
 * or malformed STRIPE_SECRET_KEY produces a controlled 503 and the user stays
 * unverified — it can never degrade into automatic approval.
 */
export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();

    // Prevent duplicate sessions for already-verified users
    const rows = await sql`SELECT kyc_status FROM users WHERE id = ${user.userId}`;
    if (rows[0]?.kyc_status === 'verified') {
      return NextResponse.json({ error: 'Identity already verified' }, { status: 400 });
    }

    // Explicitly declared sandbox only. No credential is inspected here.
    if (canAutoVerifyIdentity()) {
      await sql`
        UPDATE users
        SET kyc_status = 'verified', kyc_provider = 'sandbox', kyc_session_id = NULL
        WHERE id = ${user.userId}
      `;
      await auditLog(user.userId, 'kyc_sandbox_verified', { mode: 'sandbox' });
      return NextResponse.json({ sandbox: true, verified: true });
    }

    // Production path. Any configuration problem below must abort the request
    // with the user left unverified.
    assertKycProviderConfigured();

    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      throw new ConfigurationError('kyc', 'NEXT_PUBLIC_APP_URL is not configured.');
    }

    const stripe = getStripe();
    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { user_id: String(user.userId) },
      options: {
        document: {
          require_matching_selfie: true,
        },
      },
      return_url: `${appUrl}/profile?kyc=complete`,
    });

    // Store session ID and mark as pending — webhook is the source of truth for status
    await sql`
      UPDATE users
      SET kyc_session_id = ${session.id},
          kyc_provider   = 'stripe',
          kyc_status     = 'pending'
      WHERE id = ${user.userId}
    `;

    await auditLog(user.userId, 'kyc_session_created', { sessionId: session.id });

    // Only return the hosted URL and session ID — never expose the raw session object
    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    // A configuration problem is reported as "unavailable", never as success.
    // The user's kyc_status is untouched on this path.
    if (err instanceof ConfigurationError) {
      console.error(`KYC configuration error [${err.capability}]:`, err.message);
      return NextResponse.json(
        { error: 'Identity verification is temporarily unavailable. Please try again later.' },
        { status: 503 },
      );
    }

    // Provider failure (Stripe unreachable, rejected the request, invalid key at
    // the API boundary, ...) also leaves the user unverified.
    console.error('KYC create-session error:', err);
    return NextResponse.json({ error: 'Failed to create verification session' }, { status: 500 });
  }
}
```


### 4.2 Provider selection — the go-live gate


#### `lib/providers/TransferProviderFactory.ts`

```typescript
// TransferProviderFactory — central provider selection logic.
// Routes all provider selection through a single factory.
// No provider selection logic should exist anywhere else in the application.
//
// Factory Rules:
// - US + sandbox → SandboxUSProvider
// - CA + sandbox → SandboxCAProvider
// - US + live → PlaidTransferProvider (when enabled via env var)
// - CA + live → CanadianEFTProvider (when enabled via env var)

import { SandboxUSProvider } from './SandboxUSProvider';
import { SandboxCAProvider } from './SandboxCAProvider';
import { PlaidTransferProvider } from './PlaidTransferProvider';
import { CanadianEFTProvider } from './CanadianEFTProvider';
import type { TransferProvider } from './TransferProvider';

export type UserRegion = 'US' | 'CA';
export type ExecutionMode = 'sandbox' | 'live';

export function getTransferProvider(region: UserRegion, mode: ExecutionMode = 'sandbox'): TransferProvider {
  // US region
  if (region === 'US') {
    if (mode === 'live') {
      // Check if live Plaid is enabled
      if (process.env.PLAID_TRANSFER_LIVE === 'true') {
        return new PlaidTransferProvider();
      }
      // Fall back to sandbox if live is not enabled
      return new SandboxUSProvider();
    }
    return new SandboxUSProvider();
  }

  // CA region
  if (mode === 'live') {
    // Check if live Canadian EFT is enabled
    if (process.env.CA_EFT_LIVE === 'true') {
      return new CanadianEFTProvider();
    }
    // Fall back to sandbox if live is not enabled
    return new SandboxCAProvider();
  }
  return new SandboxCAProvider();
}

// Convert country code to provider region
export function regionFromCountry(country: string): UserRegion {
  return country === 'US' ? 'US' : 'CA';
}

/**
 * Resolve the execution mode for a region from environment flags.
 * Returns 'live' ONLY when that region's live flag is explicitly 'true'
 * (US: PLAID_TRANSFER_LIVE, CA: CA_EFT_LIVE). Defaults to 'sandbox' otherwise,
 * so nothing goes live until the flag is deliberately set alongside live
 * credentials. This is the single source of truth for go-live gating.
 */
export function resolveExecutionMode(region: UserRegion): ExecutionMode {
  if (region === 'US' && process.env.PLAID_TRANSFER_LIVE === 'true') return 'live';
  if (region === 'CA' && process.env.CA_EFT_LIVE === 'true') return 'live';
  return 'sandbox';
}

/** Narrow an untrusted string (e.g. a DB column) to a valid ExecutionMode. */
export function toExecutionMode(value: string | null | undefined): ExecutionMode {
  return value === 'live' ? 'live' : 'sandbox';
}

// Convenience method for routes that only need sandbox
export function getSandboxProvider(region: UserRegion): TransferProvider {
  return getTransferProvider(region, 'sandbox');
}

// Convenience method that uses country directly
export function getProviderByCountry(country: string, mode: ExecutionMode = 'sandbox'): TransferProvider {
  return getTransferProvider(regionFromCountry(country), mode);
}
```


#### `lib/providers/TransferProvider.ts`

```typescript
// TransferProvider interface — every banking provider must implement these methods.
// Sandbox providers implement all methods but make no real API calls.
// Live providers implement all methods and call real payment rail APIs.
// No provider may update balances directly — all balance changes happen via settlement webhooks.

export type TransferType = 'add_money' | 'cash_out';
/**
 * Transfer lifecycle states.
 *
 * `submitting` is the one state that distinguishes "the provider may have
 * accepted this transfer, but we do not yet know" from `failed`, which means the
 * provider definitely rejected it. Confusing those two is how money gets sent
 * twice or written off incorrectly, so the distinction is encoded in the type.
 *
 * A row is left in `submitting` when the provider authorization has been
 * persisted but the outcome of transferCreate is unknown — a timeout, a crash,
 * or a failure to persist the provider reference. Rows in this state are the
 * reconciliation set; see PlaidTransferProvider.reconcileTransfer.
 */
export type TransferStatus =
  | 'draft'
  | 'reviewed'
  | 'ready'
  | 'submitting'
  | 'processing'
  | 'settled'
  | 'failed'
  | 'returned'
  | 'cancelled'
  | 'blocked';
export type ExecutionMode = 'sandbox' | 'live';
export type ProviderRegion = 'US' | 'CA';
export type ProviderName = 'sandbox_us' | 'sandbox_ca' | 'plaid_transfer' | 'canadian_eft';

export interface TransferIntent {
  id: number;
  user_id: number;
  type: TransferType;
  amount: number;
  currency: string;
  status: TransferStatus;
  provider_region: ProviderRegion;
  provider_name: ProviderName;
  execution_mode: ExecutionMode;
  provider_reference_id: string | null;
  failure_reason: string | null;
  bank_account_id: number | null;
  consent_confirmed_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface BankAccountSummary {
  id: number;
  institution_name: string;
  account_name: string;
  account_mask: string | null;
  currency: string;
}

export interface ReviewDetails {
  amount: number;
  currency: string;
  type: TransferType;
  bank_account: BankAccountSummary;
  provider_name: ProviderName;
  provider_region: ProviderRegion;
  execution_mode: ExecutionMode;
  settlement_estimate: string;
  consent_language: string;
}

export interface CreateIntentResult {
  intent_id: number;
  status: TransferStatus;
  provider_name: ProviderName;
  provider_region: ProviderRegion;
  execution_mode: ExecutionMode;
}

export interface ReviewResult {
  intent_id: number;
  status: TransferStatus;
  review: ReviewDetails;
}

export interface ConfirmResult {
  intent_id: number;
  status: TransferStatus;
  message: string;
  // Present when confirmation also settles (sandbox mode): the user's updated
  // platform balance in the transfer currency after settlement.
  new_balance?: number;
}

export interface CancelResult {
  intent_id: number;
  status: TransferStatus;
  message: string;
}

export interface TransferStatusResult {
  intent_id: number;
  status: TransferStatus;
  provider_reference_id: string | null;
  failure_reason: string | null;
  updated_at: string;
}

export interface WebhookResult {
  processed: boolean;
  event_type?: string;
  message?: string;
}

// The interface every provider must implement.
// Sandbox providers implement all methods but make no real API calls.
// Live providers implement all methods and call the real payment rail.
// CRITICAL: No provider may update balances. All balance changes happen via settlement webhooks only.
export interface TransferProvider {
  readonly providerName: ProviderName;
  readonly providerRegion: ProviderRegion;
  readonly executionMode: ExecutionMode;

  // Step 1: Create a draft intent — no external call, no balance change.
  createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult>;

  // Step 2: Return review details so the user can confirm before committing.
  // No external call, no balance change.
  reviewTransfer(intentId: number, userId: number): Promise<ReviewResult>;

  // Step 3: User confirmed consent. Mark intent ready.
  // No external call, no balance change. Records consent_confirmed_at.
  confirmTransfer(intentId: number, userId: number): Promise<ConfirmResult>;

  // Step 4 (live only): Execute the real transfer.
  // Sandbox providers throw if this is called to prevent accidental live calls.
  // Live providers submit to payment rail and set status='processing'.
  executeTransfer(intentId: number, userId: number): Promise<never>;

  // Cancel a transfer in draft or ready state (not processing or later).
  // No external call, no balance change.
  cancelTransfer(intentId: number, userId: number): Promise<CancelResult>;

  // Get current transfer status from database (or provider if live).
  // No balance changes. Read-only.
  getTransferStatus(intentId: number, userId: number): Promise<TransferStatusResult>;

  // Webhook handler — called by POST /api/webhooks/<provider>.
  // Sandbox providers are no-ops; live providers update status based on provider response.
  // Balance updates happen ONLY after successful settlement via separate webhook handler.
  handleWebhookEvent(rawPayload: unknown): Promise<WebhookResult>;
}
```


### 4.3 Plaid live provider — idempotency, crash safety, reconciliation


#### `lib/providers/PlaidTransferProvider.ts`

```typescript
// Plaid Transfer provider — US live ACH debit/credit.
// Implements the full TransferProvider interface using Plaid's Transfer API.
//
// Flow:
//   createIntent   → stores draft in transfer_intents (no Plaid call)
//   reviewTransfer → returns review details + consent language (no Plaid call)
//   confirmTransfer→ records consent_confirmed_at, sets status='ready' (no Plaid call)
//   executeTransfer→ calls Plaid transferAuthorizationCreate + transferCreate,
//                    stores provider_reference_id, sets status='processing'
//   cancelTransfer → calls Plaid transferCancel (if still pending), sets status='cancelled'
//   getTransferStatus → queries DB (source of truth)
//   handleWebhookEvent → no-op; TRANSFER.STATUS_UPDATE handled in webhook route
//
// CRITICAL: This provider NEVER updates balances.
// All balance changes happen only after settlement via SettlementOrchestrator/Executor.

import { plaidClient, requireEncryptedBankToken } from '@/lib/plaid';
import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import {
  TransferType as PlaidTransferType,
  TransferNetwork,
  ACHClass,
} from 'plaid';
import type {
  TransferProvider,
  TransferType,
  CreateIntentResult,
  ReviewResult,
  ConfirmResult,
  CancelResult,
  TransferStatus,
  TransferStatusResult,
  WebhookResult,
} from './TransferProvider';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch the Plaid account_id for a given bank_account row.
 * The account_id is stored in bank_accounts.plaid_account_id (added in migration).
 * Falls back to fetching from Plaid authGet if the column is null (legacy rows).
 */
async function getPlaidAccountId(
  bankAccountId: number,
  accessToken: string
): Promise<string> {
  const sql = getSql();
  const rows = await sql`
    SELECT plaid_account_id, account_mask FROM bank_accounts WHERE id = ${bankAccountId}
  `;
  if (!rows[0]) throw new Error('Bank account not found');

  const stored = (rows[0] as { plaid_account_id: string | null; account_mask: string | null }).plaid_account_id;
  if (stored) return stored;

  // Legacy row: fetch from Plaid and backfill
  const authResp = await plaidClient.authGet({ access_token: accessToken });
  const accounts = authResp.data.accounts;
  if (!accounts.length) throw new Error('No accounts returned from Plaid authGet');

  const mask = (rows[0] as { account_mask: string | null }).account_mask;
  const matched = mask
    ? accounts.find((a) => a.mask === mask) ?? accounts[0]
    : accounts[0];

  const plaidAccountId = matched.account_id;

  // Backfill for future calls
  await sql`
    UPDATE bank_accounts SET plaid_account_id = ${plaidAccountId}
    WHERE id = ${bankAccountId}
  `;

  return plaidAccountId;
}

function toPlaidTransferType(type: TransferType): PlaidTransferType {
  return type === 'add_money' ? PlaidTransferType.Debit : PlaidTransferType.Credit;
}

function settlementEstimate(type: TransferType): string {
  return type === 'add_money'
    ? 'Funds typically available in 1–3 business days (ACH standard)'
    : 'Deposit typically arrives in 1–3 business days (ACH standard)';
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class PlaidTransferProvider implements TransferProvider {
  readonly providerName = 'plaid_transfer' as const;
  readonly providerRegion = 'US' as const;
  readonly executionMode = 'live' as const;

  async createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult> {
    const sql = getSql();
    const idempotencyKey = `plaid_${userId}_${Date.now()}`;

    const result = await sql`
      INSERT INTO transfer_intents (
        user_id, bank_account_id, type, amount, currency, status,
        provider_region, provider_name, execution_mode, idempotency_key
      ) VALUES (
        ${userId}, ${bankAccountId}, ${type}, ${amount}, ${currency}, 'draft',
        'US', 'plaid_transfer', 'live', ${idempotencyKey}
      )
      RETURNING id
    `;
    const intentId = result[0].id as number;

    await auditLog(userId, 'transfer_intent_created', {
      intent_id: intentId, type, amount, currency,
      provider: 'plaid_transfer', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'draft',
      provider_name: 'plaid_transfer',
      provider_region: 'US',
      execution_mode: 'live',
    };
  }

  async reviewTransfer(intentId: number, userId: number): Promise<ReviewResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT ti.id, ti.type, ti.amount, ti.currency, ti.status, ti.bank_account_id,
             ba.institution_name, ba.account_name, ba.account_mask, ba.currency AS account_currency
      FROM transfer_intents ti
      JOIN bank_accounts ba ON ba.id = ti.bank_account_id
      WHERE ti.id = ${intentId} AND ti.user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const row = rows[0];

    const consentLanguage =
      row.type === 'add_money'
        ? `By confirming, you authorize Manna to initiate an ACH debit from your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. Funds are typically available in 1–3 business days. You may cancel before the transfer is submitted.`
        : `By confirming, you authorize Manna to initiate an ACH credit to your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. Funds are typically available in 1–3 business days.`;

    return {
      intent_id: intentId,
      status: row.status as 'draft',
      review: {
        amount: Number(row.amount),
        currency: row.currency,
        type: row.type,
        bank_account: {
          id: row.bank_account_id,
          institution_name: row.institution_name,
          account_name: row.account_name,
          account_mask: row.account_mask,
          currency: row.account_currency,
        },
        provider_name: 'plaid_transfer',
        provider_region: 'US',
        execution_mode: 'live',
        settlement_estimate: settlementEstimate(row.type),
        consent_language: consentLanguage,
      },
    };
  }

  async confirmTransfer(intentId: number, userId: number): Promise<ConfirmResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    if (rows[0].status !== 'draft') {
      throw new Error(`Cannot confirm intent in status: ${rows[0].status}`);
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'ready', consent_confirmed_at = NOW(), updated_at = NOW()
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    await auditLog(userId, 'transfer_intent_confirmed', {
      intent_id: intentId, provider: 'plaid_transfer', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'ready',
      message: 'ACH transfer confirmed. Ready to execute.',
    };
  }

  /**
   * Stable provider idempotency key for one logical transfer.
   *
   * The canonical identity of a transfer is its transfer_intents.id, which is a
   * durable primary key. Deriving the key from it means the value is identical
   * across HTTP retries, browser retries, server retries, process restarts and
   * reconciliation, without depending on any value generated during execution.
   *
   * The persisted idempotency_key column is preferred when present (it is
   * written at intent creation); the derived form is the fallback for rows
   * created before that column existed. Neither depends on Date.now() at
   * execution time.
   */
  private stableIdempotencyKey(intentId: number, persisted: string | null): string {
    const key = persisted ?? `manna_intent_${intentId}`;
    // Plaid caps the authorization idempotency key at 50 characters. Truncating
    // deterministically keeps the value stable across retries; the intent id is
    // at the end of the derived form, so keep the tail rather than the head.
    return key.length <= 50 ? key : key.slice(key.length - 50);
  }

  /**
   * Execute a live ACH transfer.
   *
   * Ordering is deliberate and is the whole point of this method:
   *
   *   1. Claim the intent inside a transaction (SELECT ... FOR UPDATE) and move
   *      it to `submitting`. Concurrent executions serialise here; the loser
   *      sees a non-`ready` status and does not call the provider.
   *   2. Obtain an authorization and COMMIT it before creating the transfer.
   *      Plaid treats authorization_id as the idempotency identifier for
   *      transferCreate, so this persisted value is what makes a retry return
   *      the same transfer instead of creating a second one.
   *   3. Create the transfer, then persist the provider reference.
   *
   * If step 3 fails in any way — provider timeout, crash, failed write — the row
   * stays in `submitting` with a durable authorization id, which is recoverable
   * by reconcileTransfer(). It is never marked `failed`, because a failure to
   * learn the outcome is not the same as the provider rejecting the transfer.
   */
  async executeTransfer(intentId: number, userId: number): Promise<never> {
    const sql = getSql();

    // ── Step 1: claim the intent ────────────────────────────────────────────
    // FOR UPDATE only holds a lock for the duration of a transaction, so the
    // claim and the state change must happen inside sql.begin(). Doing the
    // SELECT ... FOR UPDATE as a standalone statement (as this method did
    // previously) releases the lock immediately and provides no protection
    // against concurrent execution.
    const claim = await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, type, amount, currency, status, bank_account_id,
               idempotency_key, provider_authorization_id, provider_reference_id
        FROM transfer_intents
        WHERE id = ${intentId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!rows[0]) throw new Error('Transfer intent not found');
      const intent = rows[0];

      // Resuming an interrupted execution is legitimate, and re-executing a
      // transfer already submitted to the provider is an idempotent no-op that
      // returns the known reference. Starting a fresh execution from any other
      // state is not allowed.
      const alreadySubmitted =
        intent.status === 'processing' && intent.provider_reference_id !== null;
      if (intent.status !== 'ready' && intent.status !== 'submitting' && !alreadySubmitted) {
        throw new Error(
          `Cannot execute intent in status: ${intent.status}. Must be 'ready' (or 'submitting' to resume).`,
        );
      }

      const idempotencyKey = this.stableIdempotencyKey(
        intentId,
        (intent.idempotency_key as string | null) ?? null,
      );

      if (!alreadySubmitted) {
        await tx`
          UPDATE transfer_intents
          SET status = 'submitting',
              idempotency_key = ${idempotencyKey},
              updated_at = NOW()
          WHERE id = ${intentId}
        `;
      }

      return {
        type: intent.type as TransferType,
        amount: Number(intent.amount),
        bankAccountId: intent.bank_account_id as number,
        idempotencyKey,
        existingAuthorizationId: (intent.provider_authorization_id as string | null) ?? null,
        existingReferenceId: (intent.provider_reference_id as string | null) ?? null,
      };
    }) as unknown as {
      type: TransferType;
      amount: number;
      bankAccountId: number;
      idempotencyKey: string;
      existingAuthorizationId: string | null;
      existingReferenceId: string | null;
    };

    // Already submitted and recorded — nothing further to do. Returning the
    // known reference keeps a duplicate execute request harmless.
    if (claim.existingReferenceId) {
      throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
        __submitted: true,
        plaid_transfer_id: claim.existingReferenceId,
        intent_id: intentId,
        idempotency_key: claim.idempotencyKey,
        status: 'processing' as const,
      });
    }

    const accessToken = await requireEncryptedBankToken(userId, claim.bankAccountId);
    const plaidAccountId = await getPlaidAccountId(claim.bankAccountId, accessToken);
    const amountStr = claim.amount.toFixed(2);
    const description = claim.type === 'add_money' ? 'Manna Add' : 'Manna Pay';

    // ── Step 2: authorization, persisted before the transfer is created ─────
    let authorizationId = claim.existingAuthorizationId;

    if (!authorizationId) {
      const plaidType = toPlaidTransferType(claim.type);
      // idempotency_key IS supported on this call (and is not deprecated, unlike
      // the one on transferCreate). Retrying with the same key returns the
      // authorization Plaid already created rather than creating a second one,
      // which is what makes a crash between "Plaid approved" and "we persisted
      // the id" recoverable — there is no transferAuthorizationGet to look one
      // up with, so the idempotent retry IS the recovery mechanism.
      const authResp = await plaidClient.transferAuthorizationCreate({
        access_token: accessToken,
        account_id: plaidAccountId,
        type: plaidType,
        network: TransferNetwork.Ach,
        amount: amountStr,
        ach_class: ACHClass.Ppd,
        user: { legal_name: 'Manna User' },
        idempotency_key: claim.idempotencyKey,
      });

      const authorization = authResp.data.authorization;
      if (authorization.decision !== 'approved') {
        const reason =
          authorization.decision_rationale?.description ?? authorization.decision;
        // A declined authorization is a DEFINITE provider rejection: no transfer
        // exists and none can be created from it, so `failed` is correct here.
        await sql`
          UPDATE transfer_intents
          SET status = 'failed', failure_reason = ${reason}, updated_at = NOW()
          WHERE id = ${intentId}
        `;
        await auditLog(userId, 'transfer_authorization_declined', {
          intent_id: intentId, reason, decision: authorization.decision,
        });
        throw new Error(`Plaid transfer authorization declined: ${reason}`);
      }

      authorizationId = authorization.id;

      // Committed BEFORE transferCreate. This is the durable handle that makes
      // the provider-success / local-failure window recoverable.
      await sql`
        UPDATE transfer_intents
        SET provider_authorization_id = ${authorizationId}, updated_at = NOW()
        WHERE id = ${intentId}
      `;

      await auditLog(userId, 'transfer_authorization_persisted', {
        intent_id: intentId,
        authorization_id: authorizationId,
        idempotency_key: claim.idempotencyKey,
      });
    }

    // ── Step 3: create the transfer ─────────────────────────────────────────
    // authorization_id is the idempotency identifier for this call in the
    // installed Plaid SDK (TransferCreateRequest.idempotency_key is deprecated
    // in its favour), so replaying this request with the same persisted
    // authorization returns the same transfer rather than creating another.
    const transferResp = await plaidClient.transferCreate({
      access_token: accessToken,
      account_id: plaidAccountId,
      authorization_id: authorizationId,
      description,
    });

    const plaidTransferId = transferResp.data.transfer.id;

    await sql`
      UPDATE transfer_intents
      SET status = 'processing',
          provider_reference_id = ${plaidTransferId},
          updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_submitted', {
      intent_id: intentId,
      provider: 'plaid_transfer',
      plaid_transfer_id: plaidTransferId,
      authorization_id: authorizationId,
      idempotency_key: claim.idempotencyKey,
      amount: amountStr,
      type: claim.type,
    });

    // Return never — transfer is now async; status updates arrive via TRANSFER.STATUS_UPDATE webhook
    throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
      __submitted: true,
      plaid_transfer_id: plaidTransferId,
      intent_id: intentId,
      idempotency_key: claim.idempotencyKey,
      status: 'processing' as const,
    });
  }

  /**
   * Reconcile an intent whose provider outcome is unknown.
   *
   * Targets rows left in `submitting`: the authorization was persisted but the
   * provider reference never was. Replaying transferCreate with the persisted
   * authorization_id is safe precisely because that value is the provider's
   * idempotency identifier — Plaid returns the transfer it already created
   * rather than creating a second one.
   *
   * An intent with no persisted authorization never reached the provider, so it
   * is returned to `ready` and can be executed normally.
   */
  async reconcileTransfer(
    intentId: number,
    userId: number,
  ): Promise<{ intent_id: number; status: TransferStatus; provider_reference_id: string | null; outcome: string }> {
    const sql = getSql();

    const rows = await sql`
      SELECT id, type, status, bank_account_id,
             provider_authorization_id, provider_reference_id
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const intent = rows[0];

    if (intent.provider_reference_id) {
      return {
        intent_id: intentId,
        status: intent.status as TransferStatus,
        provider_reference_id: intent.provider_reference_id as string,
        outcome: 'already_recorded',
      };
    }

    if (intent.status !== 'submitting') {
      return {
        intent_id: intentId,
        status: intent.status as TransferStatus,
        provider_reference_id: null,
        outcome: 'not_reconcilable',
      };
    }

    const authorizationId = intent.provider_authorization_id as string | null;

    if (!authorizationId) {
      // No authorization was ever persisted, so the provider was never asked to
      // move money. Safe to return the intent to `ready`.
      await sql`
        UPDATE transfer_intents
        SET status = 'ready', updated_at = NOW()
        WHERE id = ${intentId} AND status = 'submitting'
      `;
      await auditLog(userId, 'transfer_reconciled', {
        intent_id: intentId, outcome: 'never_submitted',
      });
      return {
        intent_id: intentId,
        status: 'ready',
        provider_reference_id: null,
        outcome: 'never_submitted',
      };
    }

    const accessToken = await requireEncryptedBankToken(userId, intent.bank_account_id as number);
    const plaidAccountId = await getPlaidAccountId(intent.bank_account_id as number, accessToken);
    const description = intent.type === 'add_money' ? 'Manna Add' : 'Manna Pay';

    // Idempotent replay against the persisted authorization.
    const transferResp = await plaidClient.transferCreate({
      access_token: accessToken,
      account_id: plaidAccountId,
      authorization_id: authorizationId,
      description,
    });

    const plaidTransferId = transferResp.data.transfer.id;

    await sql`
      UPDATE transfer_intents
      SET status = 'processing',
          provider_reference_id = ${plaidTransferId},
          updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_reconciled', {
      intent_id: intentId,
      outcome: 'recovered',
      authorization_id: authorizationId,
      plaid_transfer_id: plaidTransferId,
    });

    return {
      intent_id: intentId,
      status: 'processing',
      provider_reference_id: plaidTransferId,
      outcome: 'recovered',
    };
  }

  async cancelTransfer(intentId: number, userId: number): Promise<CancelResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status, provider_reference_id FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const { status, provider_reference_id } = rows[0];

    if (status !== 'draft' && status !== 'ready' && status !== 'processing') {
      throw new Error(`Cannot cancel transfer in status: ${status}`);
    }

    if (provider_reference_id && status === 'processing') {
      try {
        await plaidClient.transferCancel({
          transfer_id: provider_reference_id as string,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Transfer cannot be cancelled — it may already be posted or settled. Contact support. (${msg})`
        );
      }
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_intent_cancelled', {
      intent_id: intentId,
      provider: 'plaid_transfer',
      previous_status: status,
      plaid_transfer_id: provider_reference_id ?? null,
    });

    return {
      intent_id: intentId,
      status: 'cancelled',
      message: `Transfer cancelled (was ${status}).`,
    };
  }

  async getTransferStatus(intentId: number, userId: number): Promise<TransferStatusResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status, provider_reference_id, failure_reason, updated_at
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const row = rows[0];
    return {
      intent_id: intentId,
      status: row.status,
      provider_reference_id: row.provider_reference_id,
      failure_reason: row.failure_reason,
      updated_at: row.updated_at,
    };
  }

  async handleWebhookEvent(): Promise<WebhookResult> {
    // TRANSFER.STATUS_UPDATE events are handled in app/api/webhooks/plaid/route.ts
    // via the SettlementOrchestrator/Executor pipeline.
    return { processed: false, message: 'PlaidTransferProvider: webhook handled by route handler' };
  }
}
```


### 4.4 Canadian ACSS live provider — idempotency, crash safety, reconciliation


#### `lib/providers/CanadianEFTProvider.ts`

```typescript
// Canadian EFT provider — CA live EFT via Stripe ACSS Debit.
// Implements the full TransferProvider interface using Stripe's ACSS (Pre-Authorized Debit) API.
//
// Flow:
//   createIntent   → stores draft in transfer_intents (no Stripe call)
//   reviewTransfer → returns review details + PAD mandate language (no Stripe call)
//   confirmTransfer→ records consent_confirmed_at, sets status='ready' (no Stripe call)
//   executeTransfer→ creates Stripe PaymentIntent (add_money) or Payout (cash_out),
//                    stores provider_reference_id, sets status='processing'
//   cancelTransfer → cancels Stripe PaymentIntent if still cancellable
//   getTransferStatus → queries DB (source of truth)
//   handleWebhookEvent → no-op; Stripe events handled in app/api/webhooks/stripe/route.ts
//
// CRITICAL: This provider NEVER updates balances.
// All balance changes happen only after settlement via SettlementOrchestrator/Executor.
//
// Stripe ACSS Debit (PAD) notes:
//   - Add Money: PaymentIntent with payment_method_types=['acss_debit']
//   - Cash Out: Stripe Payout to a connected bank account
//   - Mandate verification is handled by Stripe; user must have completed Stripe setup
//   - Settlement: 2–5 business days for ACSS

import { getStripe } from '@/lib/stripe';
import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import type {
  TransferProvider,
  TransferType,
  CreateIntentResult,
  ReviewResult,
  ConfirmResult,
  CancelResult,
  TransferStatus,
  TransferStatusResult,
  WebhookResult,
} from './TransferProvider';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function settlementEstimate(type: TransferType): string {
  return type === 'add_money'
    ? 'Funds typically available in 2–5 business days (ACSS/PAD)'
    : 'Deposit typically arrives in 2–5 business days (ACSS/PAD)';
}

/**
 * Fetch the Stripe customer ID for the user, creating one if it doesn't exist.
 * Stored in users.stripe_customer_id (added in migration).
 */
async function getOrCreateStripeCustomer(userId: number): Promise<string> {
  const sql = getSql();
  const rows = await sql`
    SELECT stripe_customer_id, email, name FROM users WHERE id = ${userId}
  `;
  if (!rows[0]) throw new Error('User not found');

  const user = rows[0] as { stripe_customer_id: string | null; email: string; name: string };
  if (user.stripe_customer_id) return user.stripe_customer_id;

  // Create Stripe customer
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { manna_user_id: String(userId) },
  });

  await sql`
    UPDATE users SET stripe_customer_id = ${customer.id} WHERE id = ${userId}
  `;

  return customer.id;
}

/**
 * Fetch the Stripe bank account / payment method ID for a bank_account row.
 * Stored in bank_accounts.stripe_payment_method_id (added in migration).
 */
async function getStripeBankPaymentMethod(bankAccountId: number): Promise<string | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT stripe_payment_method_id FROM bank_accounts WHERE id = ${bankAccountId}
  `;
  if (!rows[0]) throw new Error('Bank account not found');
  return (rows[0] as { stripe_payment_method_id: string | null }).stripe_payment_method_id;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class CanadianEFTProvider implements TransferProvider {
  readonly providerName = 'canadian_eft' as const;
  readonly providerRegion = 'CA' as const;
  readonly executionMode = 'live' as const;

  async createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult> {
    const sql = getSql();
    const idempotencyKey = `ca_eft_${userId}_${Date.now()}`;

    const result = await sql`
      INSERT INTO transfer_intents (
        user_id, bank_account_id, type, amount, currency, status,
        provider_region, provider_name, execution_mode, idempotency_key
      ) VALUES (
        ${userId}, ${bankAccountId}, ${type}, ${amount}, ${currency}, 'draft',
        'CA', 'canadian_eft', 'live', ${idempotencyKey}
      )
      RETURNING id
    `;
    const intentId = result[0].id as number;

    await auditLog(userId, 'transfer_intent_created', {
      intent_id: intentId, type, amount, currency,
      provider: 'canadian_eft', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'draft',
      provider_name: 'canadian_eft',
      provider_region: 'CA',
      execution_mode: 'live',
    };
  }

  async reviewTransfer(intentId: number, userId: number): Promise<ReviewResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT ti.id, ti.type, ti.amount, ti.currency, ti.status, ti.bank_account_id,
             ba.institution_name, ba.account_name, ba.account_mask, ba.currency AS account_currency
      FROM transfer_intents ti
      JOIN bank_accounts ba ON ba.id = ti.bank_account_id
      WHERE ti.id = ${intentId} AND ti.user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const row = rows[0];

    // PAD (Pre-Authorized Debit) mandate language required by Payments Canada
    const consentLanguage =
      row.type === 'add_money'
        ? `By confirming, you authorize Manna to initiate a Canadian Pre-Authorized Debit (PAD) from your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. This authorization is for a one-time personal PAD. You have certain recourse rights if any debit does not comply with this agreement. Funds are typically available in 2–5 business days.`
        : `By confirming, you authorize Manna to initiate a Canadian EFT credit to your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. Funds are typically available in 2–5 business days.`;

    return {
      intent_id: intentId,
      status: row.status as 'draft',
      review: {
        amount: Number(row.amount),
        currency: row.currency,
        type: row.type,
        bank_account: {
          id: row.bank_account_id,
          institution_name: row.institution_name,
          account_name: row.account_name,
          account_mask: row.account_mask,
          currency: row.account_currency,
        },
        provider_name: 'canadian_eft',
        provider_region: 'CA',
        execution_mode: 'live',
        settlement_estimate: settlementEstimate(row.type),
        consent_language: consentLanguage,
      },
    };
  }

  async confirmTransfer(intentId: number, userId: number): Promise<ConfirmResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    if (rows[0].status !== 'draft') {
      throw new Error(`Cannot confirm intent in status: ${rows[0].status}`);
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'ready', consent_confirmed_at = NOW(), updated_at = NOW()
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    await auditLog(userId, 'transfer_intent_confirmed', {
      intent_id: intentId, provider: 'canadian_eft', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'ready',
      message: 'Canadian EFT transfer confirmed. Ready to execute.',
    };
  }

  /**
   * Stable provider idempotency key for one logical transfer.
   *
   * Identity is transfer_intents.id, a durable primary key, so the value is the
   * same across HTTP retries, process restarts and reconciliation. Nothing
   * generated during execution (Date.now(), a request id, a fresh random value)
   * participates.
   *
   * Stripe idempotency keys are scoped per account, not per endpoint, so the
   * operation is included in the suffix. An intent is either add_money or
   * cash_out and never both, but the suffix keeps the two request shapes from
   * ever colliding on one key — Stripe rejects a reused key whose parameters
   * differ.
   */
  private stableIdempotencyKey(
    intentId: number,
    persisted: string | null,
    operation: 'pi' | 'po',
  ): string {
    const base = persisted ?? `manna_intent_${intentId}`;
    return `${base}:${operation}`;
  }

  /**
   * Execute a live Canadian EFT transfer via Stripe ACSS.
   *
   * Differs from the Plaid path in one important way: ACSS has no separate
   * authorization step. paymentIntents.create({confirm:true}) and payouts.create
   * are each a single money-moving call, so there is no authorization that can
   * be orphaned — but equally there is no pre-call provider handle to persist.
   * The protection is therefore Stripe's request-level idempotency key, derived
   * from the durable intent id and persisted before the call.
   *
   * Ordering:
   *   1. Claim the intent inside a transaction and move it to `submitting`,
   *      persisting the idempotency key. Concurrent executions serialise here.
   *   2. Call Stripe with that key.
   *   3. Persist the provider reference and move to `processing`.
   *
   * A failure after step 2 leaves the row in `submitting` with the key intact.
   * Replaying the call with the same key returns Stripe's original object rather
   * than creating a second one, so the operation is recoverable and is never
   * marked `failed` on an unknown outcome.
   */
  async executeTransfer(intentId: number, userId: number): Promise<never> {
    const sql = getSql();

    // FOR UPDATE only holds a lock inside a transaction. Running it as a
    // standalone statement (as this method previously did) releases the lock
    // immediately and gives no protection against concurrent execution.
    const claim = await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, type, amount, currency, status, bank_account_id,
               idempotency_key, provider_reference_id
        FROM transfer_intents
        WHERE id = ${intentId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!rows[0]) throw new Error('Transfer intent not found');
      const intent = rows[0];

      const alreadySubmitted =
        intent.status === 'processing' && intent.provider_reference_id !== null;
      if (intent.status !== 'ready' && intent.status !== 'submitting' && !alreadySubmitted) {
        throw new Error(
          `Cannot execute intent in status: ${intent.status}. Must be 'ready' (or 'submitting' to resume).`,
        );
      }

      const persisted = (intent.idempotency_key as string | null) ?? null;
      // Persist the base key (without the operation suffix) so the value stored
      // locally is the intent's own identity.
      const baseKey = persisted ?? `manna_intent_${intentId}`;

      if (!alreadySubmitted) {
        await tx`
          UPDATE transfer_intents
          SET status = 'submitting',
              idempotency_key = ${baseKey},
              updated_at = NOW()
          WHERE id = ${intentId}
        `;
      }

      return {
        type: intent.type as TransferType,
        amount: Number(intent.amount),
        bankAccountId: intent.bank_account_id as number,
        baseKey,
        existingReferenceId: (intent.provider_reference_id as string | null) ?? null,
      };
    }) as unknown as {
      type: TransferType;
      amount: number;
      bankAccountId: number;
      baseKey: string;
      existingReferenceId: string | null;
    };

    // Already submitted and recorded — an idempotent no-op.
    if (claim.existingReferenceId) {
      throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
        __submitted: true,
        stripe_reference_id: claim.existingReferenceId,
        intent_id: intentId,
        idempotency_key: claim.baseKey,
        status: 'processing' as const,
      });
    }

    const stripe = getStripe();
    const amountCents = Math.round(claim.amount * 100);
    let stripeReferenceId: string;

    if (claim.type === 'add_money') {
      // Add Money: Stripe PaymentIntent with ACSS Debit
      const customerId = await getOrCreateStripeCustomer(userId);
      const paymentMethodId = await getStripeBankPaymentMethod(claim.bankAccountId);

      if (!paymentMethodId) {
        throw new Error(
          'No Stripe payment method found for this bank account. ' +
          'Please re-link your bank account to enable Canadian EFT transfers.'
        );
      }

      const idempotencyKey = this.stableIdempotencyKey(intentId, claim.baseKey, 'pi');

      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: 'cad',
          customer: customerId,
          payment_method: paymentMethodId,
          payment_method_types: ['acss_debit'],
          confirm: true,
          mandate_data: {
            customer_acceptance: {
              type: 'online',
              online: {
                ip_address: '0.0.0.0', // Server-side confirmation
                user_agent: 'Manna/1.0',
              },
            },
          },
          metadata: {
            manna_intent_id: String(intentId),
            manna_user_id: String(userId),
            transfer_type: 'add_money',
          },
        },
        // Stripe idempotency is a request option, not a body field. Replaying
        // this call with the same key returns the original PaymentIntent.
        { idempotencyKey },
      );

      stripeReferenceId = paymentIntent.id;

    } else {
      // Cash Out: Stripe Payout to connected bank
      // Note: Payouts require a Stripe Connect account or the platform's bank account.
      // For now we create a payout from the platform's Stripe balance.
      // In production this would be a transfer to a connected account.
      const idempotencyKey = this.stableIdempotencyKey(intentId, claim.baseKey, 'po');

      const payout = await stripe.payouts.create(
        {
          amount: amountCents,
          currency: 'cad',
          method: 'standard',
          metadata: {
            manna_intent_id: String(intentId),
            manna_user_id: String(userId),
            transfer_type: 'cash_out',
          },
        },
        { idempotencyKey },
      );

      stripeReferenceId = payout.id;
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'processing',
          provider_reference_id = ${stripeReferenceId},
          updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_submitted', {
      intent_id: intentId,
      provider: 'canadian_eft',
      stripe_reference_id: stripeReferenceId,
      idempotency_key: claim.baseKey,
      amount: claim.amount,
      type: claim.type,
    });

    // Return never — transfer is now async; status updates arrive via Stripe webhooks
    throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
      __submitted: true,
      stripe_reference_id: stripeReferenceId,
      intent_id: intentId,
      idempotency_key: claim.baseKey,
      status: 'processing' as const,
    });
  }

  /**
   * Reconcile a Canadian intent whose provider outcome is unknown.
   *
   * Two mechanisms, because Stripe's lookup surface is not uniform:
   *
   *   add_money — paymentIntents.search can query the metadata this provider
   *     already writes (manna_intent_id), so the original PaymentIntent can be
   *     found directly. This is authoritative provider state.
   *
   *   cash_out — the SDK exposes payouts.list and payouts.retrieve but NO
   *     payouts.search, so a payout cannot be located by metadata. Recovery
   *     falls back to replaying payouts.create with the same idempotency key,
   *     which returns the original payout rather than creating a second one.
   *     This is sound while the key is live; see the 24-hour caveat below.
   *
   * Stripe idempotency keys expire after 24 hours. Beyond that window a replay
   * would create a NEW payout, so cash-out reconciliation must happen inside it.
   * That limitation is real and is recorded rather than papered over.
   */
  async reconcileTransfer(
    intentId: number,
    userId: number,
  ): Promise<{ intent_id: number; status: TransferStatus; provider_reference_id: string | null; outcome: string }> {
    const sql = getSql();

    const rows = await sql`
      SELECT id, type, status, amount, bank_account_id, idempotency_key, provider_reference_id
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const intent = rows[0];

    if (intent.provider_reference_id) {
      return {
        intent_id: intentId,
        status: intent.status as TransferStatus,
        provider_reference_id: intent.provider_reference_id as string,
        outcome: 'already_recorded',
      };
    }

    if (intent.status !== 'submitting') {
      return {
        intent_id: intentId,
        status: intent.status as TransferStatus,
        provider_reference_id: null,
        outcome: 'not_reconcilable',
      };
    }

    const stripe = getStripe();
    const baseKey = (intent.idempotency_key as string | null) ?? `manna_intent_${intentId}`;

    if (intent.type === 'add_money') {
      // Authoritative provider lookup by the metadata written at submission.
      const found = await stripe.paymentIntents.search({
        query: `metadata['manna_intent_id']:'${intentId}'`,
        limit: 1,
      });

      if (found.data.length === 0) {
        // Nothing exists provider-side: the call never landed. Safe to retry.
        await sql`
          UPDATE transfer_intents
          SET status = 'ready', updated_at = NOW()
          WHERE id = ${intentId} AND status = 'submitting'
        `;
        await auditLog(userId, 'transfer_reconciled', {
          intent_id: intentId, provider: 'canadian_eft', outcome: 'never_submitted',
        });
        return {
          intent_id: intentId,
          status: 'ready',
          provider_reference_id: null,
          outcome: 'never_submitted',
        };
      }

      const reference = found.data[0].id;
      await sql`
        UPDATE transfer_intents
        SET status = 'processing',
            provider_reference_id = ${reference},
            updated_at = NOW()
        WHERE id = ${intentId}
      `;
      await auditLog(userId, 'transfer_reconciled', {
        intent_id: intentId, provider: 'canadian_eft',
        outcome: 'recovered', stripe_reference_id: reference,
      });
      return {
        intent_id: intentId,
        status: 'processing',
        provider_reference_id: reference,
        outcome: 'recovered',
      };
    }

    // cash_out: no payouts.search exists, so replay the create with the same
    // idempotency key. Stripe returns the original payout if one was made.
    const idempotencyKey = this.stableIdempotencyKey(intentId, baseKey, 'po');
    const payout = await stripe.payouts.create(
      {
        amount: Math.round(Number(intent.amount) * 100),
        currency: 'cad',
        method: 'standard',
        metadata: {
          manna_intent_id: String(intentId),
          manna_user_id: String(userId),
          transfer_type: 'cash_out',
        },
      },
      { idempotencyKey },
    );

    await sql`
      UPDATE transfer_intents
      SET status = 'processing',
          provider_reference_id = ${payout.id},
          updated_at = NOW()
      WHERE id = ${intentId}
    `;
    await auditLog(userId, 'transfer_reconciled', {
      intent_id: intentId, provider: 'canadian_eft',
      outcome: 'recovered_by_replay', stripe_reference_id: payout.id,
    });

    return {
      intent_id: intentId,
      status: 'processing',
      provider_reference_id: payout.id,
      outcome: 'recovered_by_replay',
    };
  }

  async cancelTransfer(intentId: number, userId: number): Promise<CancelResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status, provider_reference_id FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const { status, provider_reference_id } = rows[0];

    if (status !== 'draft' && status !== 'ready' && status !== 'processing') {
      throw new Error(`Cannot cancel transfer in status: ${status}`);
    }

    // If a PaymentIntent was created (add_money), attempt to cancel it
    if (provider_reference_id && status === 'processing') {
      const ref = provider_reference_id as string;
      if (ref.startsWith('pi_')) {
        try {
          const stripe = getStripe();
          await stripe.paymentIntents.cancel(ref);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Transfer cannot be cancelled — it may already be processing. Contact support. (${msg})`
          );
        }
      } else if (ref.startsWith('po_')) {
        // Payouts cannot be cancelled via API once created
        throw new Error(
          'Cash-out transfers cannot be cancelled once submitted. Contact support.'
        );
      }
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_intent_cancelled', {
      intent_id: intentId,
      provider: 'canadian_eft',
      previous_status: status,
      stripe_reference_id: provider_reference_id ?? null,
    });

    return {
      intent_id: intentId,
      status: 'cancelled',
      message: `Transfer cancelled (was ${status}).`,
    };
  }

  async getTransferStatus(intentId: number, userId: number): Promise<TransferStatusResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status, provider_reference_id, failure_reason, updated_at
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const row = rows[0];
    return {
      intent_id: intentId,
      status: row.status,
      provider_reference_id: row.provider_reference_id,
      failure_reason: row.failure_reason,
      updated_at: row.updated_at,
    };
  }

  async handleWebhookEvent(): Promise<WebhookResult> {
    // Stripe events (payment_intent.succeeded, payout.paid, etc.) are handled
    // in app/api/webhooks/stripe/route.ts via the SettlementOrchestrator/Executor pipeline.
    return { processed: false, message: 'CanadianEFTProvider: webhook handled by Stripe route handler' };
  }
}
```


### 4.5 Sandbox settlement — the only balance-mutating transfer path


#### `lib/providers/sandbox-settlement.ts`

```typescript
// Shared sandbox settlement logic for SandboxUSProvider and SandboxCAProvider.
//
// In sandbox mode there is no real ACH/EFT rail, but for the platform to be
// usable end-to-end (link bank -> add money -> send) a confirmed sandbox
// transfer must actually move the user's platform balance and leave an
// auditable ledger entry. This helper performs that settlement atomically.
//
// This is the ONLY transfer path permitted to mutate a balance, and only while
// execution_mode = 'sandbox'. When live PlaidTransferProvider / CanadianEFTProvider
// are introduced, balance movement flows through the settlement engine instead
// and this helper is not used.

import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';

export interface SandboxSettlementResult {
  intent_id: number;
  status: 'settled';
  new_balance: number;
  message: string;
}

/**
 * Atomically settle a confirmed sandbox transfer:
 *  - add_money  -> credit the user's platform balance (funds "pulled" from bank)
 *  - cash_out   -> debit the user's platform balance (funds "pushed" to bank)
 * Writes a ledger entry and advances the intent to 'settled'. Idempotent: an
 * intent already in a terminal state is not settled twice.
 */
export async function settleSandboxTransfer(
  intentId: number,
  userId: number,
  providerName: 'sandbox_us' | 'sandbox_ca',
): Promise<SandboxSettlementResult> {
  const sql = getSql();
  const providerReference = `sbx_${providerName}_${intentId}`;

  const newBalance = await sql.begin(async (tx) => {
    // Lock the intent row; re-read type/amount/currency/status inside the tx.
    const intentRows = await tx`
      SELECT type, amount, currency, status
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
      FOR UPDATE
    `;
    if (!intentRows[0]) throw new Error('Transfer intent not found');

    const intent = intentRows[0] as {
      type: string; amount: number; currency: string; status: string;
    };

    // Only a confirmed ('ready') intent may settle. Anything else is a no-op
    // guard against double-settlement or out-of-order calls.
    if (intent.status !== 'ready') {
      throw new Error(`Cannot settle intent in status: ${intent.status}`);
    }

    const amount = Number(intent.amount);
    const currency = intent.currency;
    const isUsd = currency === 'USD';

    let balanceRows;
    if (intent.type === 'add_money') {
      balanceRows = isUsd
        ? await tx`UPDATE users SET balance_usd = balance_usd + ${amount}
                   WHERE id = ${userId} RETURNING balance_usd AS bal`
        : await tx`UPDATE users SET balance_cad = balance_cad + ${amount}
                   WHERE id = ${userId} RETURNING balance_cad AS bal`;
    } else {
      // cash_out — guard against overdraw
      balanceRows = isUsd
        ? await tx`UPDATE users SET balance_usd = balance_usd - ${amount}
                   WHERE id = ${userId} AND balance_usd >= ${amount} RETURNING balance_usd AS bal`
        : await tx`UPDATE users SET balance_cad = balance_cad - ${amount}
                   WHERE id = ${userId} AND balance_cad >= ${amount} RETURNING balance_cad AS bal`;
      if (balanceRows.length === 0) {
        throw new Error('INSUFFICIENT_BALANCE');
      }
    }

    const debit = intent.type === 'cash_out' ? amount : 0;
    const credit = intent.type === 'add_money' ? amount : 0;
    const description = intent.type === 'add_money'
      ? `Added ${amount.toFixed(2)} ${currency} from linked bank (sandbox)`
      : `Cashed out ${amount.toFixed(2)} ${currency} to linked bank (sandbox)`;

    // Ledger entry — UNIQUE(transfer_intent_id, provider_event_id, entry_type)
    // makes this insert idempotent for a given intent.
    await tx`
      INSERT INTO ledger_entries (
        user_id, transfer_intent_id, currency, account_type, entry_type,
        debit, credit, provider, provider_reference, provider_event_id, description
      ) VALUES (
        ${userId}, ${intentId}, ${currency}, 'wallet', ${intent.type},
        ${debit}, ${credit}, ${providerName}, ${providerReference}, ${providerReference}, ${description}
      )
      ON CONFLICT (transfer_intent_id, provider_event_id, entry_type) DO NOTHING
    `;

    await tx`
      UPDATE transfer_intents
      SET status = 'settled', provider_reference_id = ${providerReference}, updated_at = NOW()
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    return Number(balanceRows[0].bal);
  }) as unknown as number;

  await auditLog(userId, 'transfer_settled', {
    intent_id: intentId, provider: providerName, mode: 'sandbox',
    provider_reference: providerReference,
  });

  return {
    intent_id: intentId,
    status: 'settled',
    new_balance: newBalance,
    message: 'Transfer settled (sandbox). Your Manna balance has been updated.',
  };
}
```


### 4.6 P2P money movement — atomic send / request-accept


#### `app/api/transactions/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser, checkVelocityLimit, recordVelocity, auditLog, sanitizeString } from '@/lib/auth';
import { buildFxQuote } from '@/lib/fx';
import { createNotification } from '@/lib/notifications';
import { createLedgerPair, createCrossBorderLedgerPair } from '@/lib/ledger';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();
    const filter = req.nextUrl.searchParams.get('filter') || 'all';
    const filterCondition =
      filter === 'sent' ? sql`AND t.sender_id = ${user.userId}` :
      filter === 'received' ? sql`AND t.receiver_id = ${user.userId}` :
      filter === 'pending' ? sql`AND t.status = 'pending'` :
      sql``;

    const transactions = await sql`
      SELECT t.*,
        s.name as sender_name, s.username as sender_username, s.avatar_color as sender_avatar,
        r.name as receiver_name, r.username as receiver_username, r.avatar_color as receiver_avatar
      FROM transactions t
      JOIN users s ON t.sender_id = s.id
      JOIN users r ON t.receiver_id = r.id
      WHERE (t.sender_id = ${user.userId} OR t.receiver_id = ${user.userId})
        ${filterCondition}
      ORDER BY t.created_at DESC
      LIMIT 50
    `;
    return NextResponse.json(transactions);
  } catch (err) {
    console.error('Transactions GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { receiverUsername, amount, note, type, privacy } = body;

    // Input validation
    if (!receiverUsername || !amount || !type) {
      return NextResponse.json({ error: 'receiverUsername, amount, and type are required' }, { status: 400 });
    }
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0 || numAmount > 10000) {
      return NextResponse.json({ error: 'Amount must be between $0.01 and $10,000' }, { status: 400 });
    }
    if (!['pay', 'request'].includes(type)) {
      return NextResponse.json({ error: 'type must be pay or request' }, { status: 400 });
    }

    const cleanNote = sanitizeString(note || '', 200);
    const txPrivacy = ['public', 'friends', 'private'].includes(privacy) ? privacy : 'public';

    const sql = getSql();

    // Get sender and receiver
    const senderRows = await sql`SELECT * FROM users WHERE id = ${user.userId}`;
    const sender = senderRows[0] as {
      id: number; username: string; balance: number; balance_cad: number; balance_usd: number;
      country: string; kyc_status: string;
    } | undefined;
    if (!sender) return NextResponse.json({ error: 'Sender not found' }, { status: 404 });

    const receiverRows = await sql`SELECT * FROM users WHERE username = ${receiverUsername}`;
    const receiver = receiverRows[0] as {
      id: number; username: string; balance: number; balance_cad: number; balance_usd: number;
      country: string;
    } | undefined;
    if (!receiver) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (receiver.id === user.userId) return NextResponse.json({ error: 'Cannot send to yourself' }, { status: 400 });

    // Determine currencies
    const senderCurrency = sender.country === 'US' ? 'USD' : 'CAD';
    const receiverCurrency = receiver.country === 'US' ? 'USD' : 'CAD';
    const isCrossBorder = senderCurrency !== receiverCurrency;

    if (type === 'pay') {
      // Velocity check
      const velocityCheck = await checkVelocityLimit(user.userId, numAmount, senderCurrency);
      if (!velocityCheck.allowed) {
        return NextResponse.json({ error: velocityCheck.reason }, { status: 429 });
      }

      // Balance check
      const senderBalance = senderCurrency === 'USD'
        ? parseFloat(String(sender.balance_usd))
        : parseFloat(String(sender.balance_cad));

      if (senderBalance < numAmount) {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
      }

      // Build FX quote if cross-border
      let receiverAmount = numAmount;
      let fxRate = 1.0;
      let fxFee = 0;
      let estimatedSettlement: Date | null = null;

      if (isCrossBorder) {
        const quote = await buildFxQuote(numAmount, senderCurrency, receiverCurrency);
        receiverAmount = quote.receiverAmount;
        fxRate = quote.rate;
        fxFee = quote.feeAmount;
        estimatedSettlement = quote.estimatedSettlement;
      }

      // Atomically: debit sender (with balance guard), credit receiver, record transaction.
      // The conditional debit prevents overdraw races; the DB transaction prevents
      // money being lost if any step fails partway through.
      let txId: number;
      try {
        txId = await sql.begin(async (tx) => {
          const debited = senderCurrency === 'USD'
            ? await tx`UPDATE users SET balance_usd = balance_usd - ${numAmount}
                       WHERE id = ${user.userId} AND balance_usd >= ${numAmount} RETURNING id`
            : await tx`UPDATE users SET balance_cad = balance_cad - ${numAmount}
                       WHERE id = ${user.userId} AND balance_cad >= ${numAmount} RETURNING id`;
          if (debited.length === 0) {
            throw new Error('INSUFFICIENT_BALANCE');
          }

          if (receiverCurrency === 'USD') {
            await tx`UPDATE users SET balance_usd = balance_usd + ${receiverAmount} WHERE id = ${receiver.id}`;
          } else {
            await tx`UPDATE users SET balance_cad = balance_cad + ${receiverAmount} WHERE id = ${receiver.id}`;
          }

          const result = await tx`
            INSERT INTO transactions (
              sender_id, receiver_id, amount, currency, note, type, status, privacy,
              sender_currency, receiver_currency, fx_rate, fx_fee,
              sender_amount, receiver_amount, is_cross_border, payment_rail,
              estimated_settlement
            ) VALUES (
              ${user.userId}, ${receiver.id}, ${numAmount}, ${senderCurrency}, ${cleanNote},
              ${type}, 'completed', ${txPrivacy},
              ${senderCurrency}, ${receiverCurrency}, ${fxRate}, ${fxFee},
              ${numAmount}, ${receiverAmount}, ${isCrossBorder},
              ${isCrossBorder ? 'wire' : 'internal'},
              ${estimatedSettlement ? estimatedSettlement.toISOString() : null}
            )
            RETURNING id
          `;
          return result[0].id as number;
        }) as unknown as number;
      } catch (txErr) {
        if (txErr instanceof Error && txErr.message === 'INSUFFICIENT_BALANCE') {
          return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
        }
        throw txErr;
      }

      // Create passive ledger entries for auditability
      try {
        if (isCrossBorder) {
          // Cross-border: atomic creation of sender debit (sender currency) + receiver credit (receiver currency)
          const fxDescription = `@ ${fxRate.toFixed(4)} (fee: ${fxFee} ${senderCurrency})`;

          await createCrossBorderLedgerPair(
            user.userId,
            senderCurrency,
            numAmount,
            receiver.id,
            receiverCurrency,
            receiverAmount,
            txId,
            {
              senderDescription: `Sent ${numAmount} ${senderCurrency} to @${receiver.username}; converted to ${receiverAmount} ${receiverCurrency} ${fxDescription}`,
              receiverDescription: `Received ${receiverAmount} ${receiverCurrency} from @${user.username} (converted from ${numAmount} ${senderCurrency} ${fxDescription})`,
            }
          );
        } else {
          // Same-currency: atomic pair of entries (debit + credit)
          await createLedgerPair(user.userId, receiver.id, senderCurrency, numAmount, txId, {
            entryType: 'payment_sent',
            senderDescription: `Sent ${numAmount} ${senderCurrency} to @${receiver.username}`,
            receiverDescription: `Received ${numAmount} ${senderCurrency} from @${user.username}`,
          });
        }
      } catch (ledgerErr) {
        console.error('Ledger entry creation failed (non-blocking):', ledgerErr);
        // Ledger entries are passive/audit-only; failure should not block the transaction
      }

      await recordVelocity(user.userId, numAmount, senderCurrency);
      await auditLog(user.userId, 'payment_sent', {
        receiverId: receiver.id,
        amount: numAmount,
        currency: senderCurrency,
        isCrossBorder,
      });
      const displayAmount = new Intl.NumberFormat('en-CA', { style: 'currency', currency: senderCurrency }).format(numAmount);
      await createNotification({
        userId: receiver.id,
        type: 'payment_received',
        title: 'You received money',
        message: `@${user.username} sent you ${displayAmount}.`,
        relatedEntityType: 'transaction',
        relatedEntityId: txId,
      });

      return NextResponse.json({ success: true, transactionId: txId, isCrossBorder, receiverAmount, receiverCurrency }, { status: 201 });

    } else {
      // Request money
      const result = await sql`
        INSERT INTO transactions (
          sender_id, receiver_id, amount, currency, note, type, status, privacy,
          sender_currency, receiver_currency, is_cross_border
        ) VALUES (
          ${receiver.id}, ${user.userId}, ${numAmount}, ${receiverCurrency}, ${cleanNote},
          'request', 'pending', ${txPrivacy},
          ${receiverCurrency}, ${senderCurrency}, ${isCrossBorder}
        )
        RETURNING id
      `;

      await auditLog(user.userId, 'payment_requested', {
        fromId: receiver.id,
        amount: numAmount,
        currency: receiverCurrency,
      });

      const reqTxId = result[0].id as number;
      const reqDisplayAmount = new Intl.NumberFormat('en-CA', { style: 'currency', currency: receiverCurrency }).format(numAmount);
      await createNotification({
        userId: receiver.id,
        type: 'payment_request',
        title: 'Money requested',
        message: `@${user.username} is requesting ${reqDisplayAmount} from you.`,
        relatedEntityType: 'transaction',
        relatedEntityId: reqTxId,
      });

      return NextResponse.json({ success: true, transactionId: reqTxId }, { status: 201 });
    }
  } catch (err) {
    console.error('Transaction POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```


### 4.7 Authorization boundary


#### `proxy.ts`

```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth';

/**
 * Edge auth gate.
 *
 * SECURITY BOUNDARY MAP — which mechanism authorizes what, and why.
 *
 *   Customer pages (AUTH_PATHS)
 *     Authorized here, by the `manna-token` JWT. These are the only routes this
 *     middleware authorizes outright.
 *
 *   Admin console (/admin/**)
 *     Two independent layers. This middleware performs a cheap presence check on
 *     the `admin_session` cookie so anonymous traffic is turned away at the edge
 *     without touching the database. The authoritative check is server-side in
 *     app/admin/layout.tsx, which resolves the session against the database and
 *     404s if it is missing, inactive, locked, or unresolvable.
 *     A customer `manna-token` deliberately grants no admin access: admin
 *     identity is a separate credential with a separate cookie.
 *
 *   Admin APIs (/api/admin/**)
 *     NOT authorized here — API routes are excluded from the matcher below.
 *     They are authorized in-route by withAdminAuth (session) plus
 *     requirePermission (role/permission). That is deliberate: permission checks
 *     need per-route granularity and database access that edge middleware
 *     cannot provide. Enforcement lives with the handler, not the router.
 *
 *   Provider webhooks (/api/webhooks/**)
 *     Deliberately NOT subject to user authentication. Their authorization
 *     mechanism is cryptographic signature verification against the provider's
 *     shared secret / JWKS — Stripe via constructEvent, Plaid via JWT
 *     verification. Applying ordinary user auth here would break delivery while
 *     adding no security, since the caller is a provider, not a user.
 *
 *   Auth endpoints (/api/auth/**)
 *     Necessarily unauthenticated; they are how a caller obtains credentials.
 */

const PUBLIC_PATHS = ['/login', '/register'];
const AUTH_PATHS = ['/feed', '/send', '/request', '/history', '/profile', '/friends', '/transfers'];
const ADMIN_PATH = '/admin';

export function proxy(request: NextRequest) {
  const token = request.cookies.get('manna-token')?.value;
  const { pathname } = request.nextUrl;

  // Admin console: gate on the admin credential, never the customer one.
  // Authoritative verification happens server-side in the admin layout.
  if (pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`)) {
    const adminSession = request.cookies.get('admin_session')?.value;
    if (!adminSession) {
      // Match the layout's response: do not disclose that the console exists.
      return NextResponse.rewrite(new URL('/404', request.url), { status: 404 });
    }
    return NextResponse.next();
  }

  const isPublicPath = PUBLIC_PATHS.some(p => pathname.startsWith(p));
  const isAuthPath = AUTH_PATHS.some(p => pathname.startsWith(p));
  const isRootPath = pathname === '/';

  const user = token ? verifyToken(token) : null;

  if (user && isPublicPath) {
    return NextResponse.redirect(new URL('/feed', request.url));
  }

  if (!user && (isAuthPath || isRootPath)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // API routes are intentionally excluded: each API family authorizes itself
  // (admin session + permission, or provider signature). See the boundary map.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
```


#### `lib/rbac/admin-server.ts`

```typescript
import 'server-only';
import { cookies } from 'next/headers';
import { resolveAdminBySessionId } from './admin-middleware';
import { ROLE_PERMISSIONS } from './types';
import type { AdminUser, Permission } from './types';

/**
 * Server-side admin authorization for React Server Components.
 *
 * The admin API routes are protected by withAdminAuth. Pages are not API
 * routes, so they need their own server-side check — otherwise the console
 * shell renders for anyone and protection depends on the client failing to
 * fetch data, which is not a security boundary.
 *
 * Both this and withAdminAuth delegate to resolveAdminBySessionId, so the page
 * guard and the API guard always agree on what a valid admin session is.
 */
export async function getServerAdmin(): Promise<AdminUser | null> {
  const sessionId = (await cookies()).get('admin_session')?.value;
  return resolveAdminBySessionId(sessionId);
}

/**
 * Whether the current server request belongs to an admin holding `permission`.
 * Fails closed for anonymous callers, non-admin callers, and unknown roles.
 */
export async function serverAdminHasPermission(permission: Permission): Promise<boolean> {
  const admin = await getServerAdmin();
  if (!admin) return false;
  return (ROLE_PERMISSIONS[admin.role] ?? []).includes(permission);
}
```


#### `app/admin/layout.tsx`

```tsx
import { notFound } from 'next/navigation';
import { getServerAdmin } from '@/lib/rbac/admin-server';
import { AdminShell } from './components/AdminShell';

/**
 * Server-side authorization gate for the whole Operations Console.
 *
 * Every page under /admin renders through this layout, so an unauthenticated or
 * non-admin caller never receives console markup. Authorization is enforced
 * here on the server rather than by the client hiding UI.
 *
 * Unauthorized callers get 404 rather than 401/redirect: the existence of the
 * console is itself information we have no reason to disclose before
 * authorization. Fails closed — resolveAdminBySessionId returns null on any
 * missing session, inactive/locked account, or infrastructure error.
 *
 * Note this is a gate, not the complete authorization story: individual admin
 * APIs additionally enforce per-permission checks via requirePermission.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getServerAdmin();

  if (!admin) {
    notFound();
  }

  return <AdminShell>{children}</AdminShell>;
}
```


#### `app/api/admin/transfers/[id]/reconcile/route.ts`

```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';
import { PlaidTransferProvider } from '@/lib/providers/PlaidTransferProvider';
import { CanadianEFTProvider } from '@/lib/providers/CanadianEFTProvider';
import { errorMessage } from '@/lib/errors';

/**
 * POST /api/admin/transfers/[id]/reconcile
 *
 * Resolve a transfer whose provider outcome is unknown — an intent left in
 * `submitting` because the provider authorization was persisted but the
 * transfer reference never was.
 *
 * Authorization (both required):
 *   1. A valid admin session          (withAdminAuth)
 *   2. The 'exceptions:manage' permission — SuperAdmin / OperationsAdmin only.
 * Reconciliation replays a provider call against real money movement, so it is
 * held to the same bar as other privileged operational remediation. There is
 * deliberately no unauthenticated path to this operation.
 *
 * Only live-mode intents are reconcilable: sandbox transfers settle
 * synchronously at confirm and never enter `submitting`. Both live providers are
 * supported; each reconciles using its own provider's semantics (Plaid replays
 * against the persisted authorization, Stripe searches by metadata for
 * add_money and replays with the idempotency key for cash_out).
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  try {
    requirePermission('exceptions:manage');

    const intentId = parseInt(req.nextUrl.pathname.split('/').at(-2) ?? '', 10);
    if (isNaN(intentId)) {
      return NextResponse.json({ error: 'Invalid intent ID' }, { status: 400 });
    }

    const sql = getSql();
    const rows = await sql`
      SELECT user_id, execution_mode, provider_name
      FROM transfer_intents
      WHERE id = ${intentId}
    `;
    if (!rows[0]) {
      return NextResponse.json({ error: 'Transfer intent not found' }, { status: 404 });
    }

    const providerName = rows[0].provider_name as string;

    if (rows[0].execution_mode !== 'live') {
      return NextResponse.json(
        { error: 'Only live transfers require reconciliation' },
        { status: 400 },
      );
    }

    // Provider selection is server-side and driven by the persisted row, never
    // by anything the caller supplies.
    const provider =
      providerName === 'plaid_transfer'
        ? new PlaidTransferProvider()
        : providerName === 'canadian_eft'
          ? new CanadianEFTProvider()
          : null;

    if (!provider) {
      return NextResponse.json(
        { error: `Provider ${providerName} does not support reconciliation` },
        { status: 400 },
      );
    }

    const result = await provider.reconcileTransfer(intentId, rows[0].user_id as number);

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Permission denied')) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    // Reconciliation failing leaves the intent exactly as it was — still in
    // `submitting`, still reconcilable. It is never downgraded to `failed`.
    console.error('Transfer reconciliation error:', err);
    return NextResponse.json(
      { error: 'Reconciliation failed', detail: errorMessage(err) },
      { status: 500 },
    );
  }
}

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, handler, {
      action: 'reconcile_transfer',
      resourceType: 'transfer_intent',
    }),
  );
```


### 4.8 Webhooks


#### `app/api/webhooks/stripe/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { auditLog } from '@/lib/auth';
import { recordProviderEvent, markProviderEventProcessed } from '@/lib/provider-events';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  if (!WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  // Read raw body — required for Stripe signature verification
  const rawBody = await req.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 400 });
  }

  const sql = getSql();

  try {
    // Handle KYC events (existing logic)
    if (event.type === 'identity.verification_session.verified') {
      const session = event.data.object as { id: string };

      await sql`
        UPDATE users
        SET kyc_status      = 'verified',
            kyc_verified_at = NOW()
        WHERE kyc_session_id = ${session.id}
      `;

      // Retrieve user for audit log
      const rows = await sql`SELECT id FROM users WHERE kyc_session_id = ${session.id}`;
      if (rows[0]) {
        await auditLog(rows[0].id as number, 'kyc_verified', { sessionId: session.id, provider: 'stripe' });
      }
    }

    if (event.type === 'identity.verification_session.requires_input') {
      const session = event.data.object as {
        id: string;
        last_error?: { code?: string; reason?: string } | null;
      };
      const reason = session.last_error?.reason || session.last_error?.code || 'Unknown';

      await sql`
        UPDATE users
        SET kyc_status            = 'requires_input',
            kyc_rejection_reason  = ${reason}
        WHERE kyc_session_id = ${session.id}
      `;

      const rows = await sql`SELECT id FROM users WHERE kyc_session_id = ${session.id}`;
      if (rows[0]) {
        await auditLog(rows[0].id as number, 'kyc_requires_input', { sessionId: session.id, reason });
      }
    }

    // Handle financial events (Phase B1: record only, no execution)
    if (isFinancialEvent(event.type)) {
      // Record event for future processing (Phase B2)
      // No settlement logic yet, just store the event
      const providerEventId = event.id || `stripe-${event.type}-${Date.now()}`;
      const dataObject = event.data.object as unknown;
      const relatedRef = (dataObject as Record<string, unknown> | null)?.id as string | undefined;

      await recordProviderEvent('stripe', providerEventId, event.type, {
        relatedProviderReference: relatedRef,
        rawPayload: event as unknown as Record<string, unknown>,
      });

      // Phase B2: Will call SettlementProcessor and apply side effects
      // For now, just mark as processed (structure ready)
      await markProviderEventProcessed('stripe', providerEventId);
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    // Acknowledging a failure with 200 tells Stripe the event was handled, so it
    // is never redelivered and the event is lost permanently — for a financial
    // or identity event that is a silent-data-loss failure mode. Return 500 so
    // Stripe retries.
    //
    // Safe to retry:
    //   - the signature was already verified above, so only authentic Stripe
    //     events can reach this path;
    //   - recordProviderEvent is idempotent via
    //     UNIQUE(provider, provider_event_id) and reports duplicates rather
    //     than double-inserting;
    //   - the KYC updates are idempotent, scoped by kyc_session_id.
    //
    // This also matches the Plaid webhook, which already returns 500 here.
    console.error('Stripe webhook handler error:', err);
    return NextResponse.json(
      { error: 'Webhook handler failed; event will be retried' },
      { status: 500 },
    );
  }
}

/**
 * Check if event is a financial event (not KYC).
 * Phase B1: Record for future processing, Phase B2 will execute settlement logic.
 */
function isFinancialEvent(eventType: string): boolean {
  // Add financial event types that Phase B2 will handle
  const financialEventTypes = [
    'charge.updated',
    'charge.succeeded',
    'charge.failed',
    'payout.created',
    'payout.paid',
    'payout.failed',
  ];

  return financialEventTypes.includes(eventType);
}
```


### 4.9 Supporting utilities


#### `lib/db.ts`

```typescript
import postgres from 'postgres';

let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Resolve the TLS mode for a connection string.
 *
 * TLS is required by default. It is relaxed only when the connection string
 * explicitly asks with the standard libpq parameter `?sslmode=disable`, which is
 * how a local or CI PostgreSQL instance without certificates is addressed.
 * Absent, empty, malformed, or unrecognised values all resolve to 'require', so
 * a typo cannot silently drop encryption.
 *
 * Exported for testing: this is a security-relevant default and is asserted in
 * lib/__tests__/security-database.test.ts.
 */
export function resolveSslMode(connectionString: string): 'require' | false {
  try {
    const sslMode = new URL(connectionString).searchParams.get('sslmode');
    return sslMode === 'disable' ? false : 'require';
  } catch {
    return 'require';
  }
}

export function getSql() {
  if (!_sql) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    // Parse URL manually so special characters in the password don't break URL parsing
    const url = new URL(dbUrl);

    const ssl = resolveSslMode(dbUrl);

    _sql = postgres({
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.replace(/^\//, ''),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl,
      max: 5,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false, // Required for Supabase transaction/session pooler
    });
  }
  return _sql;
}

export async function initializeSchema() {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 100.00,
      balance_cad REAL NOT NULL DEFAULT 0,
      balance_usd REAL NOT NULL DEFAULT 0,
      province TEXT,
      country TEXT NOT NULL DEFAULT 'CA',
      avatar_color TEXT NOT NULL DEFAULT '#CC0000',
      kyc_status TEXT NOT NULL DEFAULT 'pending',
      kyc_provider TEXT,
      kyc_session_id TEXT,
      kyc_verified_at TIMESTAMPTZ,
      kyc_rejection_reason TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      friend_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      plaid_item_id TEXT,
      plaid_access_token_enc TEXT,
      institution_name TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'depository',
      account_mask TEXT,
      currency TEXT NOT NULL DEFAULT 'CAD',
      country TEXT NOT NULL DEFAULT 'CA',
      is_primary BOOLEAN NOT NULL DEFAULT false,
      is_verified BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      is_token_encrypted BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(plaid_item_id, account_mask)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      note TEXT,
      type TEXT NOT NULL DEFAULT 'payment',
      status TEXT NOT NULL DEFAULT 'completed',
      privacy TEXT NOT NULL DEFAULT 'public',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      related_entity_type TEXT,
      related_entity_id INTEGER,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS transfer_intents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      bank_account_id INTEGER REFERENCES bank_accounts(id),
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      provider_region TEXT NOT NULL DEFAULT 'CA',
      provider_name TEXT NOT NULL DEFAULT 'sandbox_ca',
      execution_mode TEXT NOT NULL DEFAULT 'sandbox',
      provider_reference_id TEXT,
      -- Plaid returns an authorization before the transfer is created, and that
      -- authorization id doubles as the provider's idempotency identifier
      -- (plaid SDK 42.x: TransferCreateRequest.idempotency_key is deprecated in
      -- its favour). Persisting it BEFORE calling transferCreate is what makes a
      -- provider-success / database-failure window recoverable.
      provider_authorization_id TEXT,
      failure_reason TEXT,
      consent_confirmed_at TIMESTAMPTZ,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      transaction_id INTEGER REFERENCES transactions(id),
      transfer_intent_id INTEGER REFERENCES transfer_intents(id),
      currency TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'wallet',
      entry_type TEXT NOT NULL,
      debit NUMERIC(12,2) NOT NULL DEFAULT 0,
      credit NUMERIC(12,2) NOT NULL DEFAULT 0,
      provider TEXT,
      provider_reference TEXT,
      provider_event_id TEXT,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(transfer_intent_id, provider_event_id, entry_type)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS provider_webhook_events (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      related_provider_reference TEXT,
      raw_payload JSONB,
      processing_status TEXT NOT NULL DEFAULT 'received',
      processing_error TEXT,
      processed_at TIMESTAMPTZ,
      balance_processed_at TIMESTAMPTZ,
      balance_processing_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, provider_event_id)
    )
  `;
}

export default getSql;
```


#### `lib/correlation.ts`

```typescript
/**
 * Correlation ID utilities for request tracing.
 *
 * Correlation IDs enable tracking financial events through their entire lifecycle:
 * API request → settlement orchestration → ledger posting → balance updates → audit logs.
 *
 * A correlation ID is generated once when a request arrives and preserved unchanged
 * through all downstream operations. This enables forensics, auditing, and debugging.
 */

import { randomBytes } from 'crypto';
import type { NextRequest } from 'next/server';

/**
 * Generate a new correlation ID.
 *
 * Format: "corr_" + 32 random hex characters
 * Example: "corr_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
 */
export function generateCorrelationId(): string {
  return `corr_${randomBytes(16).toString('hex')}`;
}

/**
 * Extract correlation ID from HTTP headers or generate new one.
 *
 * Checks for:
 * 1. X-Correlation-ID header (preferred)
 * 2. X-Request-ID header (fallback)
 * 3. traceparent header (W3C standard, extracts trace-id)
 * 4. Generates new if none present
 *
 * @param req - Next.js request object
 * @returns Correlation ID string (always returns a value)
 */
export function extractOrGenerateCorrelationId(req: NextRequest): string {
  const fromHeader = req.headers.get('x-correlation-id');
  if (fromHeader) {
    return sanitizeCorrelationId(fromHeader);
  }

  const fromRequestId = req.headers.get('x-request-id');
  if (fromRequestId) {
    return sanitizeCorrelationId(fromRequestId);
  }

  const fromTraceparent = req.headers.get('traceparent');
  if (fromTraceparent) {
    const parts = fromTraceparent.split('-');
    if (parts.length >= 2) {
      return sanitizeCorrelationId(parts[1]);
    }
  }

  return generateCorrelationId();
}

/**
 * Sanitize a correlation ID into its canonical form.
 *
 * Correlation IDs arrive from untrusted request headers and are then written to
 * the database, emitted in structured logs, and echoed back in responses. SQL
 * parameterisation already prevents injection at the database boundary, but the
 * identifier still needs a well-defined contract of its own so that the same
 * logical request cannot be represented in several different ways, and so no
 * downstream consumer has to defend against surprising content.
 *
 * CONTRACT
 *
 *   Legal characters   ASCII letters, digits, hyphen, underscore: [A-Za-z0-9-_]
 *                      Everything else — quotes, semicolons, whitespace,
 *                      control characters, Unicode — is removed.
 *   Separators         Hyphen and underscore. A run of two or more separator
 *                      characters collapses to a single hyphen. This is what
 *                      prevents an output containing "--", the SQL comment
 *                      introducer, and it also stops "a--b" and "a-b" being two
 *                      spellings of the same id.
 *   Leading / trailing Separators are trimmed from both ends.
 *   Maximum length     255 characters, applied after cleaning; if truncation
 *                      leaves a trailing separator it is trimmed too.
 *   Empty result       Never returned. Input that sanitizes to nothing (empty,
 *                      whitespace-only, entirely illegal characters, null or
 *                      undefined) yields a freshly generated id, because tracing
 *                      requires every request to carry one.
 *   Idempotent         sanitize(sanitize(x)) === sanitize(x) for any x.
 *
 * @param id - Raw correlation ID from a request header
 * @returns Canonical correlation ID, always non-empty
 */
export function sanitizeCorrelationId(id: string): string {
  if (typeof id !== 'string') {
    return generateCorrelationId();
  }

  const sanitized = id
    // 1. Legal character set.
    .replace(/[^a-zA-Z0-9\-_]/g, '')
    // 2. Collapse runs of separators; a single separator is left as written.
    .replace(/[-_]{2,}/g, '-')
    // 3. Trim separators from both ends.
    .replace(/^[-_]+|[-_]+$/g, '')
    // 4. Bound the length.
    .slice(0, 255)
    // 5. Truncation may have exposed a new trailing separator.
    .replace(/[-_]+$/g, '');

  return sanitized || generateCorrelationId();
}

/**
 * Type-safe context carrier for correlation IDs during request processing.
 *
 * Stored in AsyncLocalStorage or passed as context through function calls.
 * Enables middleware to inject correlation ID without changing function signatures.
 */
export interface RequestContext {
  correlationId: string;
  userId?: number;
  adminId?: number;
  sourceIp?: string;
  userAgent?: string;
  timestamp: Date;
}

/**
 * Create request context with correlation ID.
 *
 * Called by middleware before route handling.
 * Context is passed to all downstream functions that need tracing.
 */
export function createRequestContext(
  correlationId: string,
  userId?: number,
  sourceIp?: string,
  userAgent?: string
): RequestContext {
  return {
    correlationId,
    userId,
    sourceIp,
    userAgent,
    timestamp: new Date(),
  };
}

/**
 * Validate correlation ID format.
 *
 * Ensures correlation ID meets expected format for logging and storage.
 * Used to catch invalid correlation IDs early (e.g., from malicious headers).
 */
export function isValidCorrelationId(id: string | null | undefined): boolean {
  if (!id || typeof id !== 'string') return false;
  if (id.length > 255) return false;
  return /^[a-zA-Z0-9\-_]+$/.test(id);
}

/**
 * Serialize correlation ID for logging.
 *
 * Ensures correlation ID is safe for JSON logging and database storage.
 * Idempotent: calling multiple times returns the same result.
 */
export function serializeCorrelationId(id: string): string {
  return sanitizeCorrelationId(id) || generateCorrelationId();
}
```


#### `lib/errors.ts`

```typescript
/**
 * Narrowing helpers for values caught in a `catch` clause.
 *
 * A caught value is `unknown`: TypeScript cannot know what a thrown value is,
 * and annotating it `any` silently disables checking on every property read
 * that follows. These helpers narrow it explicitly instead, so the compiler
 * keeps verifying the code inside error branches.
 */

/** Whether a caught value is an Error instance. */
export function isError(err: unknown): err is Error {
  return err instanceof Error;
}

/**
 * Message of a caught value, for logging and error responses.
 * Non-Error values are stringified rather than dropped.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Whether a caught value represents an RBAC permission denial.
 *
 * requirePermission throws a ForbiddenError whose message names the missing
 * permission; admin routes map that to HTTP 403. Matching on the message is
 * how these routes already behaved — this helper only makes the check type
 * safe, it does not change which errors are treated as denials.
 */
export function isPermissionDenied(err: unknown): err is Error {
  return err instanceof Error && err.message.includes('Permission denied');
}
```


### 4.10 CI pipeline


#### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [master, 'integration/**']
  push:
    branches: [master, 'integration/**']

# Cancel superseded runs on the same ref.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    name: install · typecheck · lint · test · build
    runs-on: ubuntu-latest
    timeout-minutes: 20

    services:
      # The audit suite exercises real repository SQL. Running it against a real
      # PostgreSQL server is deliberate: a hand-written fake would test the fake.
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: manna_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 10

    env:
      # Test database only. No production credential is ever present in CI, and
      # MANNA_ENV is deliberately left unset so the KYC tests exercise the
      # fail-closed production default.
      DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/manna_test?sslmode=disable

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      # Uses the lockfile exactly. This step would have failed before Phase 1,
      # when package.json and package-lock.json were out of sync.
      - name: Install dependencies
        run: npm ci

      - name: Prepare test schema
        run: psql "postgres://postgres:postgres@127.0.0.1:5432/manna_test" -f lib/__tests__/helpers/test-schema.sql
        env:
          PGPASSWORD: postgres

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test

      - name: Build
        run: npm run build

      - name: Assert no live provider flag is enabled
        run: |
          if grep -rEn "(PLAID_TRANSFER_LIVE|CA_EFT_LIVE)\s*[:=]\s*['\"]?true" \
               --include='*.ts' --include='*.tsx' --include='*.json' \
               --include='*.yml' --include='*.yaml' . \
               | grep -v node_modules; then
            echo "::error::A live provider flag appears to be enabled in committed code."
            exit 1
          fi
          echo "No live provider flags enabled."

  audit:
    name: dependency audit
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      # Advisory for now: fails the job only on high/critical advisories so a
      # newly published low-severity advisory cannot block an unrelated fix.
      - name: npm audit (high and above)
        run: npm audit --audit-level=high
```


---

## 5. Test suites proving the safety properties

These are the tests that pin the financial-safety guarantees. They run against a
**real PostgreSQL instance** with the provider SDKs mocked at the network
boundary — a hand-written fake database would only have tested the fake.


### `lib/__tests__/transfer-execution-safety.test.ts`

```typescript
/**
 * Phase 3 — live transfer execution safety.
 *
 * These tests exercise PlaidTransferProvider.executeTransfer and
 * reconcileTransfer against a real database with the Plaid SDK mocked. No live
 * provider flag is set and no real money moves; the mock stands in for the
 * network boundary only.
 *
 * The properties under test:
 *   1. one transfer intent yields one stable provider idempotency identifier,
 *      unchanged across retries, reloads and concurrent execution;
 *   2. a provider success followed by a local failure leaves a recoverable
 *      state, never a false `failed`;
 *   3. replaying the provider call cannot create a second transfer;
 *   4. webhook arrival before, after, or twice around local persistence is safe.
 */

import { getSql } from '../db';

// ── Plaid SDK mock ───────────────────────────────────────────────────────────
// Records every call so tests can assert exactly what was sent to the provider.
interface AuthCall { amount: string }
interface CreateCall { authorization_id: string }

const plaidCalls = {
  authorizations: [] as AuthCall[],
  creates: [] as CreateCall[],
  reset() { this.authorizations = []; this.creates = []; },
};

/** Transfers the fake provider believes exist, keyed by authorization id. */
const providerTransfers = new Map<string, string>();

let authorizationDecision: 'approved' | 'declined' = 'approved';
let transferCreateBehaviour: 'ok' | 'timeout' = 'ok';
let authSeq = 0;
let transferSeq = 0;

vi.mock('@/lib/plaid', () => ({
  plaidClient: {
    transferAuthorizationCreate: async (req: { amount: string }) => {
      plaidCalls.authorizations.push({ amount: req.amount });
      authSeq += 1;
      return {
        data: {
          authorization: {
            id: `auth_${authSeq}`,
            decision: authorizationDecision,
            decision_rationale:
              authorizationDecision === 'declined'
                ? { description: 'Insufficient funds at institution' }
                : null,
          },
        },
      };
    },
    transferCreate: async (req: { authorization_id: string }) => {
      plaidCalls.creates.push({ authorization_id: req.authorization_id });

      if (transferCreateBehaviour === 'timeout') {
        throw new Error('ETIMEDOUT: provider did not respond');
      }

      // This is the behaviour that matters: Plaid treats authorization_id as the
      // idempotency identifier, so replaying a call with the same authorization
      // returns the transfer that already exists rather than creating another.
      const existing = providerTransfers.get(req.authorization_id);
      if (existing) {
        return { data: { transfer: { id: existing } } };
      }
      transferSeq += 1;
      const transferId = `plaid_transfer_${transferSeq}`;
      providerTransfers.set(req.authorization_id, transferId);
      return { data: { transfer: { id: transferId } } };
    },
  },
  requireEncryptedBankToken: async () => 'access-token-test',
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  return { ...actual, auditLog: async () => {} };
});

const { PlaidTransferProvider } = await import('../providers/PlaidTransferProvider');

const USER_ID = 9001;
const BANK_ACCOUNT_ID = 9001;

const sql = getSql();
const provider = new PlaidTransferProvider();

/** Create a `ready` live intent and return its id. */
async function createReadyIntent(idempotencyKey?: string | null): Promise<number> {
  const rows = await sql`
    INSERT INTO transfer_intents (
      user_id, bank_account_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, idempotency_key
    ) VALUES (
      ${USER_ID}, ${BANK_ACCOUNT_ID}, 'add_money', 25.00, 'USD', 'ready',
      'US', 'plaid_transfer', 'live', ${idempotencyKey ?? null}
    )
    RETURNING id
  `;
  return rows[0].id as number;
}

async function readIntent(intentId: number) {
  const rows = await sql`
    SELECT status, idempotency_key, provider_authorization_id, provider_reference_id, failure_reason
    FROM transfer_intents WHERE id = ${intentId}
  `;
  return rows[0] as {
    status: string;
    idempotency_key: string | null;
    provider_authorization_id: string | null;
    provider_reference_id: string | null;
    failure_reason: string | null;
  };
}

/**
 * executeTransfer signals success by throwing a tagged error (the method is
 * typed Promise<never> because the transfer continues asynchronously).
 */
async function execute(intentId: number): Promise<{
  submitted: boolean; transferId?: string; idempotencyKey?: string; error?: Error;
}> {
  try {
    await provider.executeTransfer(intentId, USER_ID);
    return { submitted: false };
  } catch (err) {
    const e = err as Error & { __submitted?: boolean; plaid_transfer_id?: string; idempotency_key?: string };
    if (e.__submitted) {
      return { submitted: true, transferId: e.plaid_transfer_id, idempotencyKey: e.idempotency_key };
    }
    return { submitted: false, error: e };
  }
}

beforeEach(async () => {
  plaidCalls.reset();
  providerTransfers.clear();
  authSeq = 0;
  transferSeq = 0;
  authorizationDecision = 'approved';
  transferCreateBehaviour = 'ok';
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

describe('Transfer execution safety', () => {
  describe('normal success', () => {
    it('persists a stable key, sends the authorization to Plaid, and records the reference', async () => {
      const intentId = await createReadyIntent('plaid_9001_persisted');

      const result = await execute(intentId);
      expect(result.submitted).toBe(true);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      expect(intent.idempotency_key).toBe('plaid_9001_persisted');
      expect(intent.provider_authorization_id).toBe('auth_1');
      expect(intent.provider_reference_id).toBe(result.transferId);
      expect(intent.failure_reason).toBeNull();

      // The authorization persisted locally is exactly what was sent to Plaid.
      expect(plaidCalls.creates).toHaveLength(1);
      expect(plaidCalls.creates[0].authorization_id).toBe('auth_1');
    });

    it('derives a stable key from the intent id when none was persisted', async () => {
      const intentId = await createReadyIntent(null);
      await execute(intentId);

      const intent = await readIntent(intentId);
      // Derived from the durable primary key — no Date.now(), no request id.
      expect(intent.idempotency_key).toBe(`manna_intent_${intentId}`);
    });
  });

  describe('duplicate execution', () => {
    it('executing the same intent twice reuses the key and creates no second transfer', async () => {
      const intentId = await createReadyIntent('plaid_dup_key');

      const first = await execute(intentId);
      const second = await execute(intentId);

      expect(first.submitted).toBe(true);
      expect(second.submitted).toBe(true);
      expect(second.transferId).toBe(first.transferId);
      expect(second.idempotencyKey).toBe(first.idempotencyKey);

      // The second execute short-circuits on the recorded reference.
      expect(plaidCalls.creates).toHaveLength(1);
      expect(plaidCalls.authorizations).toHaveLength(1);
      expect(providerTransfers.size).toBe(1);
    });

    it('a reload from the database yields the same key (survives process restart)', async () => {
      const intentId = await createReadyIntent('plaid_restart_key');
      await execute(intentId);
      const afterFirst = await readIntent(intentId);

      // Simulate a fresh process: new provider instance, state read from the DB.
      const freshProvider = new PlaidTransferProvider();
      try {
        await freshProvider.executeTransfer(intentId, USER_ID);
      } catch { /* tagged submitted error */ }

      const afterSecond = await readIntent(intentId);
      expect(afterSecond.idempotency_key).toBe(afterFirst.idempotency_key);
      expect(afterSecond.provider_reference_id).toBe(afterFirst.provider_reference_id);
      expect(providerTransfers.size).toBe(1);
    });
  });

  describe('concurrent execution', () => {
    it('two simultaneous executions produce one key and one provider transfer', async () => {
      const intentId = await createReadyIntent('plaid_concurrent_key');

      const [a, b] = await Promise.all([execute(intentId), execute(intentId)]);

      const intent = await readIntent(intentId);
      expect(intent.idempotency_key).toBe('plaid_concurrent_key');
      expect(intent.status).toBe('processing');

      // Exactly one transfer exists at the provider regardless of interleaving.
      expect(providerTransfers.size).toBe(1);
      // And at most one authorization was ever created.
      expect(plaidCalls.authorizations.length).toBeLessThanOrEqual(1);

      const submitted = [a, b].filter((r) => r.submitted);
      expect(submitted.length).toBeGreaterThanOrEqual(1);
      for (const r of submitted) {
        expect(r.transferId).toBe(intent.provider_reference_id);
      }
    });
  });

  describe('provider timeout — outcome unknown', () => {
    it('does NOT mark the transfer failed and leaves it reconcilable', async () => {
      const intentId = await createReadyIntent('plaid_timeout_key');
      transferCreateBehaviour = 'timeout';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);
      expect(result.error?.message).toContain('ETIMEDOUT');

      const intent = await readIntent(intentId);
      // The critical assertion: unknown is not failure.
      expect(intent.status).toBe('submitting');
      expect(intent.status).not.toBe('failed');
      expect(intent.failure_reason).toBeNull();
      // The durable handle needed for recovery was persisted before the call.
      expect(intent.provider_authorization_id).toBe('auth_1');
    });
  });

  describe('provider failure — outcome known', () => {
    it('a declined authorization is a definite failure', async () => {
      const intentId = await createReadyIntent('plaid_declined_key');
      authorizationDecision = 'declined';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('failed');
      expect(intent.failure_reason).toContain('Insufficient funds');
      // No transfer was ever created, so nothing to reconcile.
      expect(intent.provider_reference_id).toBeNull();
      expect(plaidCalls.creates).toHaveLength(0);
    });
  });

  describe('provider success then database failure', () => {
    /**
     * Simulates: Plaid creates the transfer, then the local write that records
     * the reference never lands (crash, connection loss, deploy). The provider
     * transfer exists; the database does not know its id.
     */
    async function simulateProviderSuccessWithLostWrite(intentId: number) {
      transferCreateBehaviour = 'timeout';
      await execute(intentId);           // persists the authorization, then "fails"
      transferCreateBehaviour = 'ok';
      const intent = await readIntent(intentId);
      // The transfer really does exist provider-side against this authorization.
      providerTransfers.set(intent.provider_authorization_id as string, 'plaid_transfer_orphan');
      return intent;
    }

    it('leaves a recoverable state with no false failure', async () => {
      const intentId = await createReadyIntent('plaid_lostwrite_key');
      const intent = await simulateProviderSuccessWithLostWrite(intentId);

      expect(intent.status).toBe('submitting');
      expect(intent.provider_authorization_id).not.toBeNull();
      expect(intent.provider_reference_id).toBeNull();
    });

    it('reconciliation discovers the existing transfer without creating a duplicate', async () => {
      const intentId = await createReadyIntent('plaid_recover_key');
      await simulateProviderSuccessWithLostWrite(intentId);

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('recovered');
      expect(outcome.provider_reference_id).toBe('plaid_transfer_orphan');

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      expect(intent.provider_reference_id).toBe('plaid_transfer_orphan');

      // Recovery replayed against the same authorization, so the provider still
      // holds exactly one transfer.
      expect(providerTransfers.size).toBe(1);
    });

    it('a retry after the lost write also recovers rather than duplicating', async () => {
      const intentId = await createReadyIntent('plaid_retry_key');
      await simulateProviderSuccessWithLostWrite(intentId);

      // Ordinary re-execution, not reconciliation.
      const retry = await execute(intentId);

      expect(retry.submitted).toBe(true);
      expect(retry.transferId).toBe('plaid_transfer_orphan');
      expect(providerTransfers.size).toBe(1);
      // No second authorization was created — the persisted one was reused.
      expect(plaidCalls.authorizations).toHaveLength(1);
    });

    it('reconciling an intent that never reached the provider returns it to ready', async () => {
      const intentId = await createReadyIntent('plaid_neversent_key');
      // `submitting` with no authorization: the provider was never asked.
      await sql`
        UPDATE transfer_intents SET status = 'submitting' WHERE id = ${intentId}
      `;

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('never_submitted');
      expect((await readIntent(intentId)).status).toBe('ready');
      expect(plaidCalls.creates).toHaveLength(0);
    });

    it('reconciling an already-recorded transfer is a no-op', async () => {
      const intentId = await createReadyIntent('plaid_noop_key');
      await execute(intentId);

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);
      expect(outcome.outcome).toBe('already_recorded');
      expect(providerTransfers.size).toBe(1);
    });
  });

  describe('webhook race', () => {
    /**
     * The Plaid webhook locates an intent by provider_reference_id. These tests
     * cover both orderings around the local write, plus a duplicate delivery.
     */
    async function webhookLookup(transferId: string) {
      const rows = await sql`
        SELECT id, status FROM transfer_intents WHERE provider_reference_id = ${transferId}
      `;
      return rows[0] ?? null;
    }

    it('webhook arriving BEFORE local persistence finds nothing, and reconciliation repairs it', async () => {
      const intentId = await createReadyIntent('plaid_webhook_early_key');
      await simulateEarlyWebhookWindow(intentId);

      // At this moment the provider has the transfer but we have no reference,
      // so a webhook cannot match — the intent must remain recoverable.
      expect(await webhookLookup('plaid_transfer_orphan')).toBeNull();
      expect((await readIntent(intentId)).status).toBe('submitting');

      await provider.reconcileTransfer(intentId, USER_ID);

      // After reconciliation the same webhook resolves correctly.
      const matched = await webhookLookup('plaid_transfer_orphan');
      expect(matched).not.toBeNull();
      expect(matched.id).toBe(intentId);
    });

    it('webhook arriving AFTER local persistence resolves immediately', async () => {
      const intentId = await createReadyIntent('plaid_webhook_late_key');
      const result = await execute(intentId);

      const matched = await webhookLookup(result.transferId as string);
      expect(matched).not.toBeNull();
      expect(matched.id).toBe(intentId);
      expect(matched.status).toBe('processing');
    });

    it('a duplicate webhook resolves to the same single intent', async () => {
      const intentId = await createReadyIntent('plaid_webhook_dup_key');
      const result = await execute(intentId);

      const transferId = result.transferId;
      expect(transferId).toBeDefined();
      if (!transferId) return;

      const first = await webhookLookup(transferId);
      const second = await webhookLookup(transferId);

      expect(first.id).toBe(intentId);
      expect(second.id).toBe(intentId);

      // provider_reference_id is uniquely indexed, so a transfer id can never
      // fan out to two intents and be settled twice.
      const all = await sql`
        SELECT COUNT(*)::int AS n FROM transfer_intents
        WHERE provider_reference_id = ${transferId}
      `;
      expect(all[0].n).toBe(1);
    });

    async function simulateEarlyWebhookWindow(intentId: number) {
      transferCreateBehaviour = 'timeout';
      await execute(intentId);
      transferCreateBehaviour = 'ok';
      const intent = await readIntent(intentId);
      providerTransfers.set(intent.provider_authorization_id as string, 'plaid_transfer_orphan');
    }
  });

  describe('database guarantees', () => {
    it('the same provider reference cannot be attached to two intents', async () => {
      const a = await createReadyIntent('plaid_unique_a');
      const b = await createReadyIntent('plaid_unique_b');

      await sql`UPDATE transfer_intents SET provider_reference_id = 'shared_ref' WHERE id = ${a}`;
      await expect(
        sql`UPDATE transfer_intents SET provider_reference_id = 'shared_ref' WHERE id = ${b}`,
      ).rejects.toThrow();
    });

    it('the same idempotency key cannot be reused by two intents', async () => {
      await createReadyIntent('plaid_shared_idem');
      await expect(createReadyIntent('plaid_shared_idem')).rejects.toThrow();
    });
  });
});
```


### `lib/__tests__/canadian-eft-safety.test.ts`

```typescript
/**
 * Phase 3 — Canadian ACSS (Stripe) transfer execution safety.
 *
 * ACSS semantics are NOT the same as Plaid's, and these tests are written to the
 * real differences rather than to an assumed symmetry:
 *
 *   - There is no separate authorization step. paymentIntents.create({confirm})
 *     and payouts.create are each a single money-moving call, so there is no
 *     authorization that can be orphaned — and no pre-call provider handle to
 *     persist. Protection is Stripe's request-level idempotency key.
 *   - Stripe idempotency is a request OPTION (second argument), not a body field.
 *   - paymentIntents.search exists, so add_money can be reconciled by an
 *     authoritative provider lookup on metadata. payouts has NO search, so
 *     cash_out can only be recovered by an idempotent replay.
 *
 * The Stripe SDK is mocked; no live flag is set and no real money moves.
 */

import { getSql } from '../db';

interface StripeCall { idempotencyKey?: string }

const stripeCalls = {
  paymentIntents: [] as StripeCall[],
  payouts: [] as StripeCall[],
  reset() { this.paymentIntents = []; this.payouts = []; },
};

/** Objects the fake Stripe account holds, keyed by idempotency key. */
const stripeObjects = new Map<string, string>();
/** PaymentIntents indexed by manna_intent_id metadata, for the search path. */
const byIntentMetadata = new Map<string, string>();

let behaviour: 'ok' | 'timeout' | 'card_error' = 'ok';
let piSeq = 0;
let poSeq = 0;

vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    customers: { create: async () => ({ id: 'cus_test' }) },
    paymentIntents: {
      create: async (
        params: { metadata: { manna_intent_id: string } },
        opts?: { idempotencyKey?: string },
      ) => {
        stripeCalls.paymentIntents.push({ idempotencyKey: opts?.idempotencyKey });
        if (behaviour === 'timeout') throw new Error('ETIMEDOUT: stripe did not respond');
        if (behaviour === 'card_error') {
          throw Object.assign(new Error('Your bank account could not be debited'), {
            type: 'StripeCardError',
          });
        }
        const key = opts?.idempotencyKey ?? '';
        // Stripe replays the original response for a repeated idempotency key.
        const existing = stripeObjects.get(key);
        if (existing) return { id: existing };
        piSeq += 1;
        const id = `pi_${piSeq}`;
        stripeObjects.set(key, id);
        byIntentMetadata.set(params.metadata.manna_intent_id, id);
        return { id };
      },
      search: async ({ query }: { query: string }) => {
        const match = /manna_intent_id'\]\s*:\s*'(\d+)'/.exec(query);
        const intentId = match?.[1];
        const found = intentId ? byIntentMetadata.get(intentId) : undefined;
        return { data: found ? [{ id: found }] : [] };
      },
    },
    payouts: {
      create: async (
        _params: unknown,
        opts?: { idempotencyKey?: string },
      ) => {
        stripeCalls.payouts.push({ idempotencyKey: opts?.idempotencyKey });
        if (behaviour === 'timeout') throw new Error('ETIMEDOUT: stripe did not respond');
        const key = opts?.idempotencyKey ?? '';
        const existing = stripeObjects.get(key);
        if (existing) return { id: existing };
        poSeq += 1;
        const id = `po_${poSeq}`;
        stripeObjects.set(key, id);
        return { id };
      },
    },
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  return { ...actual, auditLog: async () => {} };
});

const { CanadianEFTProvider } = await import('../providers/CanadianEFTProvider');

const USER_ID = 9002;
const BANK_ACCOUNT_ID = 9002;

const sql = getSql();
const provider = new CanadianEFTProvider();

async function createReadyIntent(
  type: 'add_money' | 'cash_out' = 'add_money',
  idempotencyKey: string | null = null,
): Promise<number> {
  const rows = await sql`
    INSERT INTO transfer_intents (
      user_id, bank_account_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, idempotency_key
    ) VALUES (
      ${USER_ID}, ${BANK_ACCOUNT_ID}, ${type}, 40.00, 'CAD', 'ready',
      'CA', 'canadian_eft', 'live', ${idempotencyKey}
    )
    RETURNING id
  `;
  return rows[0].id as number;
}

async function readIntent(intentId: number) {
  const rows = await sql`
    SELECT status, idempotency_key, provider_reference_id, failure_reason
    FROM transfer_intents WHERE id = ${intentId}
  `;
  return rows[0] as {
    status: string;
    idempotency_key: string | null;
    provider_reference_id: string | null;
    failure_reason: string | null;
  };
}

async function execute(intentId: number): Promise<{
  submitted: boolean; referenceId?: string; idempotencyKey?: string; error?: Error;
}> {
  try {
    await provider.executeTransfer(intentId, USER_ID);
    return { submitted: false };
  } catch (err) {
    const e = err as Error & {
      __submitted?: boolean; stripe_reference_id?: string; idempotency_key?: string;
    };
    if (e.__submitted) {
      return { submitted: true, referenceId: e.stripe_reference_id, idempotencyKey: e.idempotency_key };
    }
    return { submitted: false, error: e };
  }
}

beforeAll(async () => {
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
    VALUES (${USER_ID}, 'CA Test User', 'catest9002', 'ca9002@example.test',
            'not-a-real-hash', 'CA', 'verified')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO bank_accounts (id, user_id, institution_name, account_name,
                               stripe_payment_method_id, currency, country,
                               is_token_encrypted, is_verified)
    VALUES (${BANK_ACCOUNT_ID}, ${USER_ID}, 'Test CA Bank', 'Chequing',
            'pm_test_acss', 'CAD', 'CA', true, true)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    UPDATE users SET stripe_customer_id = 'cus_test' WHERE id = ${USER_ID}
  `;
});

beforeEach(async () => {
  stripeCalls.reset();
  stripeObjects.clear();
  byIntentMetadata.clear();
  behaviour = 'ok';
  piSeq = 0;
  poSeq = 0;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

describe('Canadian ACSS transfer safety', () => {
  describe('normal submission', () => {
    it('persists a stable key, sends it as a Stripe request option, and records the reference', async () => {
      const intentId = await createReadyIntent('add_money');

      const result = await execute(intentId);
      expect(result.submitted).toBe(true);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      expect(intent.provider_reference_id).toBe(result.referenceId);
      expect(intent.failure_reason).toBeNull();
      // Derived from the durable intent id — not Date.now(), not a request id.
      expect(intent.idempotency_key).toBe(`manna_intent_${intentId}`);

      // Sent as a request option with the operation suffix.
      expect(stripeCalls.paymentIntents).toHaveLength(1);
      expect(stripeCalls.paymentIntents[0].idempotencyKey).toBe(`manna_intent_${intentId}:pi`);
    });

    it('uses a distinct key suffix for payouts so the two request shapes cannot collide', async () => {
      const intentId = await createReadyIntent('cash_out');
      await execute(intentId);

      expect(stripeCalls.payouts).toHaveLength(1);
      expect(stripeCalls.payouts[0].idempotencyKey).toBe(`manna_intent_${intentId}:po`);
    });
  });

  describe('duplicate submission', () => {
    it('executing twice reuses the key and creates no second Stripe object', async () => {
      const intentId = await createReadyIntent('add_money');

      const first = await execute(intentId);
      const second = await execute(intentId);

      expect(first.submitted).toBe(true);
      expect(second.submitted).toBe(true);
      expect(second.referenceId).toBe(first.referenceId);
      expect(stripeCalls.paymentIntents).toHaveLength(1);
      expect(stripeObjects.size).toBe(1);
    });

    it('a reload from the database yields the same key (survives process restart)', async () => {
      const intentId = await createReadyIntent('add_money');
      await execute(intentId);
      const first = await readIntent(intentId);

      const freshProvider = new CanadianEFTProvider();
      try { await freshProvider.executeTransfer(intentId, USER_ID); } catch { /* tagged */ }

      const second = await readIntent(intentId);
      expect(second.idempotency_key).toBe(first.idempotency_key);
      expect(second.provider_reference_id).toBe(first.provider_reference_id);
      expect(stripeObjects.size).toBe(1);
    });
  });

  describe('concurrent submission', () => {
    it('two simultaneous executions produce one Stripe object', async () => {
      const intentId = await createReadyIntent('add_money');

      await Promise.all([execute(intentId), execute(intentId)]);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      // The transactional claim serialises the two callers.
      expect(stripeObjects.size).toBe(1);
      expect(stripeCalls.paymentIntents.length).toBeLessThanOrEqual(1);
    });
  });

  describe('provider timeout — outcome unknown', () => {
    it('does NOT mark the transfer failed and leaves it reconcilable', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'timeout';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);
      expect(result.error?.message).toContain('ETIMEDOUT');

      const intent = await readIntent(intentId);
      // Unknown is not failure.
      expect(intent.status).toBe('submitting');
      expect(intent.status).not.toBe('failed');
      expect(intent.failure_reason).toBeNull();
      // The key needed for an idempotent replay is persisted.
      expect(intent.idempotency_key).toBe(`manna_intent_${intentId}`);
    });
  });

  describe('provider failure — outcome known', () => {
    it('a rejected debit surfaces the error and leaves the intent recoverable, not falsely settled', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'card_error';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);
      expect(result.error?.message).toContain('could not be debited');

      const intent = await readIntent(intentId);
      expect(intent.provider_reference_id).toBeNull();
      expect(intent.status).not.toBe('processing');
      expect(intent.status).not.toBe('settled');
    });
  });

  describe('provider success then database failure', () => {
    /** Stripe created the object; the local write recording it never landed. */
    async function simulateLostWrite(intentId: number, type: 'add_money' | 'cash_out') {
      behaviour = 'timeout';
      await execute(intentId);              // persists the key, then "fails"
      behaviour = 'ok';
      const suffix = type === 'add_money' ? 'pi' : 'po';
      const key = `manna_intent_${intentId}:${suffix}`;
      const id = type === 'add_money' ? 'pi_orphan' : 'po_orphan';
      stripeObjects.set(key, id);
      if (type === 'add_money') byIntentMetadata.set(String(intentId), id);
      return id;
    }

    it('leaves a recoverable state with no false failure', async () => {
      const intentId = await createReadyIntent('add_money');
      await simulateLostWrite(intentId, 'add_money');

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('submitting');
      expect(intent.provider_reference_id).toBeNull();
      expect(intent.failure_reason).toBeNull();
    });

    it('add_money reconciles by authoritative provider lookup on metadata', async () => {
      const intentId = await createReadyIntent('add_money');
      const orphan = await simulateLostWrite(intentId, 'add_money');

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('recovered');
      expect(outcome.provider_reference_id).toBe(orphan);
      expect((await readIntent(intentId)).status).toBe('processing');
      expect(stripeObjects.size).toBe(1);
    });

    it('cash_out reconciles by idempotent replay (payouts has no search API)', async () => {
      const intentId = await createReadyIntent('cash_out');
      const orphan = await simulateLostWrite(intentId, 'cash_out');

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('recovered_by_replay');
      expect(outcome.provider_reference_id).toBe(orphan);
      // The replay returned the original payout rather than creating a second.
      expect(stripeObjects.size).toBe(1);
    });

    it('an ordinary retry after the lost write also recovers rather than duplicating', async () => {
      const intentId = await createReadyIntent('add_money');
      const orphan = await simulateLostWrite(intentId, 'add_money');

      const retry = await execute(intentId);

      expect(retry.submitted).toBe(true);
      expect(retry.referenceId).toBe(orphan);
      expect(stripeObjects.size).toBe(1);
    });

    it('reconciling an add_money intent that never reached Stripe returns it to ready', async () => {
      const intentId = await createReadyIntent('add_money');
      await sql`UPDATE transfer_intents SET status = 'submitting' WHERE id = ${intentId}`;

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('never_submitted');
      expect((await readIntent(intentId)).status).toBe('ready');
    });

    it('reconciling an already-recorded transfer is a no-op', async () => {
      const intentId = await createReadyIntent('add_money');
      await execute(intentId);

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);
      expect(outcome.outcome).toBe('already_recorded');
      expect(stripeObjects.size).toBe(1);
    });
  });

  describe('webhook race', () => {
    async function webhookLookup(reference: string) {
      const rows = await sql`
        SELECT id, status FROM transfer_intents WHERE provider_reference_id = ${reference}
      `;
      return rows[0] ?? null;
    }

    it('webhook BEFORE local persistence finds nothing; reconciliation repairs it', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'timeout';
      await execute(intentId);
      behaviour = 'ok';
      stripeObjects.set(`manna_intent_${intentId}:pi`, 'pi_orphan');
      byIntentMetadata.set(String(intentId), 'pi_orphan');

      // No reference persisted yet, so the event cannot match and must not
      // drive a state transition.
      expect(await webhookLookup('pi_orphan')).toBeNull();
      expect((await readIntent(intentId)).status).toBe('submitting');

      await provider.reconcileTransfer(intentId, USER_ID);

      const matched = await webhookLookup('pi_orphan');
      expect(matched).not.toBeNull();
      expect(matched.id).toBe(intentId);
    });

    it('webhook AFTER local persistence resolves immediately', async () => {
      const intentId = await createReadyIntent('add_money');
      const result = await execute(intentId);

      const matched = await webhookLookup(result.referenceId as string);
      expect(matched.id).toBe(intentId);
      expect(matched.status).toBe('processing');
    });

    it('a duplicate webhook resolves to the same single intent', async () => {
      const intentId = await createReadyIntent('add_money');
      const result = await execute(intentId);
      const reference = result.referenceId;
      expect(reference).toBeDefined();
      if (!reference) return;

      expect((await webhookLookup(reference)).id).toBe(intentId);
      expect((await webhookLookup(reference)).id).toBe(intentId);

      const count = await sql`
        SELECT COUNT(*)::int AS n FROM transfer_intents
        WHERE provider_reference_id = ${reference}
      `;
      expect(count[0].n).toBe(1);
    });

    it('an event arriving after reconciliation converges to the same state', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'timeout';
      await execute(intentId);
      behaviour = 'ok';
      stripeObjects.set(`manna_intent_${intentId}:pi`, 'pi_orphan');
      byIntentMetadata.set(String(intentId), 'pi_orphan');

      await provider.reconcileTransfer(intentId, USER_ID);
      const afterReconcile = await readIntent(intentId);

      // A late event resolves to the same intent and the same reference.
      const matched = await webhookLookup('pi_orphan');
      expect(matched.id).toBe(intentId);
      expect(afterReconcile.provider_reference_id).toBe('pi_orphan');
      expect(afterReconcile.status).toBe('processing');
    });
  });

  describe('cross-provider reference isolation', () => {
    it('one external reference cannot be attached to two intents', async () => {
      const a = await createReadyIntent('add_money');
      const b = await createReadyIntent('add_money');

      await sql`UPDATE transfer_intents SET provider_reference_id = 'pi_shared' WHERE id = ${a}`;
      await expect(
        sql`UPDATE transfer_intents SET provider_reference_id = 'pi_shared' WHERE id = ${b}`,
      ).rejects.toThrow();
    });
  });
});
```


### `lib/__tests__/security-kyc.test.ts`

```typescript
/**
 * KYC fail-closed security regression tests.
 *
 * These exist to prove one property:
 *
 *   No production configuration failure can result in automatic identity
 *   approval.
 *
 * The decision point is lib/environment.ts. Auto-verification is permitted only
 * by canAutoVerifyIdentity(), which consults the declared environment and never
 * a credential. These tests pin that behaviour against regression.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getDeploymentEnvironment,
  isSandboxEnvironment,
  isProductionEnvironment,
  canAutoVerifyIdentity,
  assertKycProviderConfigured,
  ConfigurationError,
} from '../environment';

const REPO_ROOT = join(__dirname, '..', '..');

/** Env keys these tests manipulate; restored after each case. */
const MANAGED_KEYS = ['MANNA_ENV', 'VERCEL_ENV', 'STRIPE_SECRET_KEY'] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of MANAGED_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  // NODE_ENV is readonly in @types/node, so it is managed through vitest's env
  // stubs rather than direct assignment.
  vi.unstubAllEnvs();
  for (const key of MANAGED_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('KYC fail-closed security', () => {
  describe('environment resolution', () => {
    it('defaults to production when no environment is declared', () => {
      expect(getDeploymentEnvironment()).toBe('production');
      expect(isProductionEnvironment()).toBe(true);
      expect(isSandboxEnvironment()).toBe(false);
    });

    it('resolves sandbox only for an exact MANNA_ENV=sandbox opt-in', () => {
      process.env.MANNA_ENV = 'sandbox';
      expect(getDeploymentEnvironment()).toBe('sandbox');
      expect(canAutoVerifyIdentity()).toBe(true);
    });

    it('tolerates surrounding whitespace and casing on the opt-in', () => {
      process.env.MANNA_ENV = '  SandBox ';
      expect(getDeploymentEnvironment()).toBe('sandbox');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['development', 'development'],
      ['dev', 'dev'],
      ['test', 'test'],
      ['staging', 'staging'],
      ['typo', 'sandbx'],
      ['prefix match', 'sandbox-ish'],
      ['suffix match', 'not-sandbox'],
      ['boolean-ish', 'true'],
      ['production', 'production'],
    ])('treats MANNA_ENV=%s as production (never sandbox)', (_label, value) => {
      process.env.MANNA_ENV = value;
      expect(getDeploymentEnvironment()).toBe('production');
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('never allows a Vercel production deployment to be downgraded to sandbox', () => {
      process.env.VERCEL_ENV = 'production';
      process.env.MANNA_ENV = 'sandbox';
      expect(getDeploymentEnvironment()).toBe('production');
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('does not treat NODE_ENV as an environment signal', () => {
      vi.stubEnv('NODE_ENV', 'development');
      // NODE_ENV=development must NOT imply sandbox.
      expect(getDeploymentEnvironment()).toBe('production');
      expect(canAutoVerifyIdentity()).toBe(false);
    });
  });

  describe('credentials are never an environment signal', () => {
    it('production + missing STRIPE_SECRET_KEY does not become sandbox', () => {
      // The exact historical fail-open: absent credential implying sandbox.
      expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('production + test-mode key does not become sandbox', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('production + live key does not enable auto-verification either', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('sandbox opt-in does not require any credential', () => {
      process.env.MANNA_ENV = 'sandbox';
      expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
      expect(() => assertKycProviderConfigured()).not.toThrow();
      expect(canAutoVerifyIdentity()).toBe(true);
    });
  });

  describe('production provider configuration assertions', () => {
    it('production + valid live configuration passes', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
      expect(() => assertKycProviderConfigured()).not.toThrow();
    });

    it('production + valid test-mode configuration passes the shape check', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
      expect(() => assertKycProviderConfigured()).not.toThrow();
    });

    it('production + missing secret throws ConfigurationError', () => {
      expect(() => assertKycProviderConfigured()).toThrow(ConfigurationError);
    });

    it('production + empty secret throws ConfigurationError', () => {
      process.env.STRIPE_SECRET_KEY = '   ';
      expect(() => assertKycProviderConfigured()).toThrow(ConfigurationError);
    });

    it.each([
      ['garbage', 'not-a-key'],
      ['publishable key', 'pk_live_abc123'],
      ['truncated prefix', 'sk_live_'],
      ['wrong mode', 'sk_prod_abc123'],
      ['leading junk', 'xsk_live_abc123'],
    ])('production + invalid secret (%s) throws ConfigurationError', (_label, value) => {
      process.env.STRIPE_SECRET_KEY = value;
      expect(() => assertKycProviderConfigured()).toThrow(ConfigurationError);
    });

    it('reports the failing capability so callers can fail closed deliberately', () => {
      try {
        assertKycProviderConfigured();
        throw new Error('expected assertKycProviderConfigured to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigurationError);
        expect((err as ConfigurationError).capability).toBe('kyc');
      }
    });
  });

  describe('route-level fail-closed wiring', () => {
    const routeSource = readFileSync(
      join(REPO_ROOT, 'app/api/kyc/create-session/route.ts'),
      'utf8',
    );

    it('gates auto-verification on canAutoVerifyIdentity, not on a credential', () => {
      expect(routeSource).toContain('canAutoVerifyIdentity()');
      // The historical fail-open helper must not come back.
      expect(routeSource).not.toContain('isStripeLive');
      expect(routeSource).not.toContain('sk_live_');
    });

    it('asserts provider configuration before taking the production path', () => {
      expect(routeSource).toContain('assertKycProviderConfigured()');
    });

    it('translates a configuration error into a failure, never an approval', () => {
      const handler = routeSource.slice(routeSource.indexOf('catch (err)'));
      expect(handler).toContain('ConfigurationError');
      expect(handler).toContain('503');
      // No status mutation may occur while handling a failure. Checked against
      // SQL verbs rather than the column name so prose comments do not match.
      expect(handler).not.toMatch(/UPDATE\s+users/i);
      expect(handler).not.toMatch(/SET\s+kyc_status/i);
    });

    it('performs auto-verification exactly once, inside the sandbox branch', () => {
      const autoVerifyStatements = routeSource.match(/kyc_status = 'verified'/g) ?? [];
      expect(autoVerifyStatements).toHaveLength(1);

      const gateIndex = routeSource.indexOf('canAutoVerifyIdentity()');
      const verifyIndex = routeSource.indexOf("kyc_status = 'verified'");
      expect(gateIndex).toBeGreaterThan(-1);
      expect(verifyIndex).toBeGreaterThan(gateIndex);
    });
  });

  describe('inventory of every path that can set a user verified', () => {
    it('only the sandbox-gated route and the signature-verified webhook set verified', () => {
      // Any new write of kyc_status='verified' must be reviewed and added here
      // deliberately. This test exists to make such a change impossible to land
      // silently.
      const kycRoute = readFileSync(
        join(REPO_ROOT, 'app/api/kyc/create-session/route.ts'),
        'utf8',
      );
      const webhook = readFileSync(
        join(REPO_ROOT, 'app/api/webhooks/stripe/route.ts'),
        'utf8',
      );

      // Path 1: sandbox-gated auto-verification.
      expect(kycRoute).toContain('canAutoVerifyIdentity()');

      // Path 2: Stripe Identity webhook — signature must be verified before any
      // status write, and the write must be scoped to the provider's session id.
      const sigIndex = webhook.indexOf('constructEvent');
      const verifiedWriteIndex = webhook.indexOf("kyc_status      = 'verified'");
      expect(sigIndex).toBeGreaterThan(-1);
      expect(verifiedWriteIndex).toBeGreaterThan(sigIndex);
      expect(webhook).toContain('WHERE kyc_session_id =');
    });
  });
});
```


---

## 6. Open blockers

Categorised honestly. The execute endpoint being disabled does **not** downgrade
a duplicate-transfer or financial-integrity risk.

### CRITICAL
None outstanding in code.

### HIGH — must be resolved before live money

1. **Idempotency-key expiry windows.** Stripe keys expire after 24 hours,
   Plaid's after 48. A replay beyond the window can create a **second provider
   operation** (a duplicate debit). Cash-out is most exposed because replay is
   its *only* recovery mechanism. Needs an age guard.
2. **ACSS cash-out has no provider lookup.** `payouts.search` does not exist in
   the Stripe SDK, so recovery depends entirely on idempotent replay — strictly
   weaker than add-money's authoritative metadata lookup.
3. **Cash-out payouts are not per-user.** `payouts.create` draws from the
   platform's Stripe balance with **no destination account**; the code's own
   comment flags this. It is unfinished money movement.
4. **No execute endpoint**, so neither live path is reachable end-to-end.
5. **Customer balances are not backed by real funds.** No FBO/custodial account
   exists. Sandbox settlement credits balances with nothing behind them.

### MEDIUM
6. **Admin login and bootstrap do not exist.** `createSession` has no callers,
   so no admin can authenticate; the Operations Console is inert. This also
   blocks admin-gating `/api/migrate`, which currently accepts any authenticated
   user.
7. **Canadian Stripe settlement is a no-op.** The webhook records financial
   events and marks them processed behind a literal `// Phase B2` placeholder,
   so a CA live transfer would execute but never settle.
8. Reconciliation is manual (no scheduled sweep); intentional, as the repository
   has no background-job infrastructure.

### LOW
9. 33 `no-unused-vars` lint warnings (non-blocking; lint exits 0).
10. `/api/feed` serves `privacy='public'` rows to anonymous callers. No private
    data leaks, but whether "public" should mean public to the open internet is
    a product decision.

### Owner/infrastructure actions — NOT verified as done
- **CI must be configured as a required status check.** The pipeline is green
  but branch protection is a repository setting.
- **`MANNA_ENV=sandbox` must be set on every non-production deployment.**
  Without it those deployments correctly refuse to auto-verify identity, and the
  sandbox money loop stops at the KYC stage.

### Legal prerequisites (from the go-live runbook)
Money transmitter licensing or a sponsor-bank/BaaS partner (US), FINTRAC MSB
registration (Canada), a written AML/KYC compliance program, Plaid Transfer
product approval, and Stripe live ACSS approval. **Operating live without these
is illegal.**

---

## 7. Suggested next steps

1. **Merge the branches.** Nothing is deployed; `master` predates all of this.
   Suggested order: `integration/release-0.95` → `master`, then
   `phase3/transfer-safety`.
2. **Build admin login + bootstrap.** Small, and it unblocks the entire
   Operations Console plus admin-gating `/api/migrate`.
3. **Close HIGH items 1–3** (idempotency-key age guard, ACSS cash-out recovery,
   per-user payout destination) before building the execute endpoint.
4. **Complete Canadian Stripe settlement** (the `// Phase B2` no-op).
5. **Only then** consider the execute endpoint, behind the go-live runbook.

---

## 8. Branch map

| Branch | Contents |
|---|---|
| `master` | Production. Has ACSS + live providers; none of the Phase 1–3 work |
| `integration/release-0.95` | Phase 1 + Phase 2 baseline |
| `phase3/transfer-safety` | **This document's source.** Phase 3 on top of the above |
| `go-live-prep` | Env-gated live routing + runbook (folded into integration) |
| `kyc-sandbox-verify` | KYC-only branch (redundant — duplicate patch-id) |
| `backup/pre-0.95/*` | Recovery points captured before Phase 1 |

*Documents not inlined here for size: `OPERATIONS_MANUAL.md` (~19,000 words,
operational playbook for non-engineers) and the three full phase reports. All are
in the repository and in the ZIP archive.*

---

*End of bundle.*
