# MANNA Technical Strategy 2026–2027

**Document Version:** 1.0  
**Last Updated:** June 28, 2026  
**Classification:** Technical Strategy — Confidential  
**Audience:** Executive Leadership, Principal Engineers, Board Members, Banking Partners, Regulatory Advisors

---

## Executive Summary

Manna is positioned at a critical inflection point. We have validated the core peer-to-peer payment product in a controlled sandbox environment with dual-currency wallets, cross-border FX integration, and event-driven settlement. We have proven the technical feasibility of our architecture. We now face the defining engineering challenge of the next 18 months: transforming Manna from a validated prototype into a production-grade payments platform capable of safely handling real money, meeting regulatory requirements, and scaling to millions of transactions.

This document articulates Manna's comprehensive technical strategy for 2026–2027. It covers:

- **Financial Architecture:** Dual-currency wallets, atomic balance updates, immutable audit ledgers, and real-time reconciliation mechanisms that eliminate financial correctness risk.
- **Settlement Architecture:** Event-driven, idempotent webhook processing that guarantees exactly-once balance mutations even in the face of network failures and retries.
- **Provider Strategy:** A modular abstraction layer that decouples business logic from payment provider implementations, enabling sandbox validation, live testing, and graceful provider transitions.
- **Security & Compliance:** Defense-in-depth controls including encryption-at-rest, token vaulting, rate limiting, velocity controls, KYC gating, and AML monitoring frameworks.
- **Operations & Observability:** Comprehensive logging, structured metrics, real-time alerting, and admin tooling that enables safe operations without direct database access.
- **Regulatory Roadmap:** A phased path to MSB licensing, AML/KYC compliance, and jurisdiction-specific reporting that meets FINTRAC, FinCEN, and state regulator expectations.
- **Production Readiness:** A 12-week, 5-phase execution plan (C1–C5) that sequences work by risk profile and business dependency to reach production-safe status.
- **Engineering Organization:** Hiring, team structure, and governance frameworks to support 18 months of intense systems engineering work.

**Current State (June 2026):**
- ✅ Core peer-to-peer payment flow (intent → review → confirm)
- ✅ Dual-currency wallets (CAD, USD) with seed balances
- ✅ Sandbox provider integrations (US ACH, Canadian EFT simulation)
- ✅ Cross-border FX integration (Wise API with rate caching)
- ✅ Basic KYC (Stripe Verification integration, pending live configuration)
- ✅ Social features (friends graph, transaction feed)
- ✅ Settlement event architecture (Phase B3.1–B3.2b foundation complete)
- ⏳ Balance reconciliation (schema ready, implementation pending Phase C1)
- ⏳ Admin dashboard (specification ready, implementation pending Phase C2)
- ⏳ Live provider integrations (architecturally ready, Plaid/EFT pending Phase C4)
- ⏳ Regulatory compliance (assessment complete, MSB licensing pending Phase C1)

**Key Metrics:**
- Code coverage: No automated test suite (critical gap, Phase C1 priority)
- Error rate (sandbox): < 0.1% (good)
- P99 API latency: ~350ms (acceptable for sandbox)
- Uptime: 99.8% (acceptable, but no SLA commitments)
- Financial data integrity: 100% (validated through code review, production validation pending)

**Strategic Goals for 2026–2027:**

1. **Achieve Production Safety (Q3 2026, Weeks 1–6, Phase C1–C2)**
   - Complete regulatory assessment and MSB licensing roadmap
   - Implement balance reconciliation with zero financial discrepancies
   - Deploy operations console enabling safe incident handling
   - All manual balance corrections auditable and reversible

2. **Reach Operational Excellence (Q3–Q4 2026, Weeks 7–12, Phase C3–C4)**
   - Structured logging and centralized log aggregation (30-day retention)
   - Real-time metrics dashboards and alerting (SEV-1/2/3 escalation)
   - Live Plaid Transfer API integration with canary rollout (5% → 100%)
   - Canadian EFT provider integration with parity testing
   - MSB licenses obtained; AML/KYC monitoring active

3. **Enable Live Money Movement (Q4 2026, Weeks 13–14, Phase C5)**
   - Production go/no-go checklist completed
   - Gradual user onboarding: internal team → trusted testers → general public
   - Velocity limits enforced: $500/day for new users
   - On-call rotation 24/7 with < 15-min response time

4. **Sustain Long-Term Growth (2027)**
   - Scale to 10M+ transactions/month with P99 latency < 500ms
   - Expand to additional jurisdictions (UK, EU pending regulatory analysis)
   - Build tiered velocity system based on user history and KYC tier
   - Achieve zero compliance violations and < 0.5% error rate in steady state

---

## Part 1: Vision & Mission

### 1.1 Company Vision

Manna enables seamless cross-border money movement between peers, removing friction that exists in the current remittance and payment infrastructure. We are building the trust layer for global payments — a place where your money is safe, settlement is guaranteed, and regulators are confident in our controls.

### 1.2 Engineering Mission

Manna's engineering mission is to deliver a payments platform that is simultaneously:

- **Financially Correct:** Every balance change is auditable, reproducible, and reconcilable to the ledger. No balance discrepancies, no orphaned transactions, no unauthorized mutations.
- **Operationally Transparent:** Every action is logged, every failure is alertable, every incident is traceable. Operations teams work from dashboards, not databases.
- **Architecturally Modular:** Payment providers, settlement flows, and compliance rules are pluggable abstractions. We can swap Plaid for another ACH provider, add Canadian EFT, or change KYC vendors without touching business logic.
- **Regulatory Aligned:** We anticipate MSB licensing requirements, AML/KYC expectations, and sector-specific reporting needs. Compliance is not an afterthought; it is engineered into the settlement flow.
- **Resilient at Scale:** We handle network failures, provider latencies, webhook timeouts, and partial failures gracefully. Users trust Manna with their money precisely because we have eliminated ambiguous states.

### 1.3 Why This Strategy Matters

Payments platforms fail not because their core idea is wrong, but because they cut corners on financial correctness, compliance, and operational visibility. Failures in this space can result in:

- **Direct financial loss:** A bug in balance logic that lets users withdraw more than they have can drain the entire float.
- **Regulatory shutdown:** Operating without MSB licenses or failing AML audits can result in cease-and-desist orders.
- **Trust collapse:** A single incident where users' money is inaccessible or unreconcilable destroys trust permanently.

Our strategy is calibrated to eliminate these categories of failure. We invest in reconciliation, auditability, and operational tooling because these are not nice-to-have features — they are existential requirements for a payments company.

---

## Part 2: Strategic Principles

### 2.1 Principle 1: Financial Correctness Above All

Every balance change is immutable and auditable. We do not update balances in-place; we record ledger entries and derive balances from the ledger. We reconcile daily. We track every FX conversion. We have dual-layer idempotency to prevent the same webhook from debiting a user twice.

**Implementation:**
- `users.balance_usd` and `users.balance_cad` are derived from `ledger_entries` via `getLedgerBalance()`
- Every balance mutation creates immutable `ledger_entries` (debit/credit pairs)
- Every FX conversion is logged with rate, timestamp, and source (`lib/fx.ts`)
- Daily reconciliation sums all `ledger_entries` and compares to current balances (C1.2)
- Provider webhook events use UNIQUE(provider, provider_event_id) to prevent duplicate intake
- Settlement executor uses `balance_processed_at` timestamp to prevent duplicate execution

**Why:** Payments are a zero-sum game. A data corruption bug that lets one user gain $100 means another user loses $100 somewhere. There is no "close enough" — we need exact balance correctness.

### 2.2 Principle 2: Event-Driven Settlement with Idempotency

Settlement is not synchronous request-reply. It is driven by asynchronous webhook events from providers (Plaid, Wise, payment processors). We assume webhooks may arrive out of order, be retried, or timeout. We design for exactly-once semantics.

**Implementation:**
- Provider webhooks → `provider_webhook_events` table (deduplication layer)
- Settlement processor queries intents and plans state transitions (no side effects)
- Settlement executor applies transitions atomically via SQL:
  - Phase B3.1: Status transitions (draft → ready → processing → settled/failed/returned)
  - Phase B3.2a: Ledger entries (immutable audit trail)
  - Phase B3.2b: Balance updates (atomic SQL arithmetic to prevent race conditions)
  - Phase B3.3: Notifications & velocity updates (idempotent on intent_id)
- Replayable: If executor crashes mid-execution, retry is safe because balance_processed_at tracks completion

**Why:** Network failures are not rare edge cases — they are normal. We design for them. Idempotency means users can be confident in their balance even if they see a "something went wrong" error message, because the system will automatically retry and converge to the correct state.

### 2.3 Principle 3: Modular Provider Abstraction

All payment provider integrations (Plaid, Wise, Canadian EFT) are pluggable implementations of a common `TransferProvider` interface. Business logic never directly calls a provider; it always routes through `TransferProviderFactory`.

**Implementation:**
- `TransferProvider` interface defines 7 required methods: `createTransferIntent()`, `validateIntent()`, `executeTransfer()`, `getTransferStatus()`, `cancelTransfer()`, `reverseTransfer()`, `parseWebhookEvent()`
- `TransferProviderFactory` selects provider based on (user.country, execution_mode, feature_flags)
- Sandbox providers (SandboxUSProvider, SandboxCAProvider) fully implement the interface but throw on `executeTransfer()` (intentional blocker)
- Live providers (PlaidTransferProvider, CanadianEFTProvider) are prepared as placeholders, swappable without touching business logic
- Providers are stateless — all state is in transfer_intents, provider_webhook_events tables

**Why:** Payment providers change, get acquired, or go out of service. Modularity ensures we can swap providers with low risk. It also forces us to articulate provider boundaries clearly, preventing business logic from leaking into provider-specific code.

### 2.4 Principle 4: Operations Without Database Access

Operations and support teams never log into the production database. All operational actions (balance corrections, transfer manual settlement, user lookups, velocity overrides) are available via an admin API and dashboard.

**Implementation:**
- Phase C2 builds admin dashboard with user lookup, transfer search, balance correction UI
- All admin actions require approval workflow and audit logging
- Admin API endpoints rate-limited and IP-restricted
- All changes are immutable and reversible (balance correction creates offset ledger entries)
- Night-of-the-week runbooks for common incident scenarios (stuck transfer, failed KYC, balance discrepancy)

**Why:** Database access is a critical security boundary. Operators with DB access can silently corrupt data or exfiltrate PII. Dashboard-based operations are auditable, logged, and reversible. They also scale — you can hire 10 support agents without giving them DB access.

### 2.5 Principle 5: Regulatory Compliance as Architecture

AML/KYC, velocity limits, transaction monitoring, and suspicious activity reporting are not tacked-on features — they are woven into the settlement flow.

**Implementation:**
- KYC tier determines max daily velocity (new users: $500/day, tier 2: $5k/day, tier 3: unlimited)
- All transfers require KYC status check at intent-creation time
- Sanctions screening integrated into settlement executor (Phase C4)
- Transaction monitoring flags transfers matching suspicious patterns (Phase C4)
- All transactions over $10k CAD/$10k USD logged for CTR reporting (Phase C4)
- Suspicious Activity Report (SAR) workflow automated (Phase C4)

**Why:** Compliance failures close companies. Countries like Canada (FINTRAC) and the US (FinCEN) expect money services businesses to implement controls proactively. Building compliance into the architecture means we can demonstrate safe operations to regulators, not retrofit compliance after launch.

### 2.6 Principle 6: Observability First

If something breaks, we know within minutes and have context to fix it. Every request has a correlation ID. Every error is logged with stack trace and user context. Every transaction milestone is metered.

**Implementation:**
- Structured JSON logging from all API routes (Phase C3.1)
- Correlation ID propagation across requests and settlement flows
- Log aggregation (Datadog, LogRocket) with 30-day retention
- Prometheus metrics: request rate, latency percentiles, error rate by endpoint
- Grafana dashboards for ops team (real-time request rate, error rate, latency)
- SEV-1/2/3 alerting rules with PagerDuty escalation

**Why:** In a payments system, silence is dangerous. You cannot fix what you cannot observe. Good observability also helps with debugging — when a user reports their balance is wrong, we can instantly query logs to trace every action that affected it.

---

## Part 3: Strategic Principles (continued)

### 2.7 Principle 7: Security in Depth

We use defense-in-depth: encryption at rest, encryption in transit, token vaulting, rate limiting, input validation, and principle-of-least-privilege.

**Implementation:**
- Plaid access tokens encrypted AES-256-GCM before storage in `bank_accounts.plaid_access_token_enc`
- TLS 1.3 for all HTTP connections
- JWT tokens with 24-hour expiry and 12-hour inactivity timeout
- Rate limiting: 100 req/min per user, 10 transfers/hour per endpoint, 5 login attempts/hour per IP
- Admin API: IP whitelist + MFA for sensitive operations
- All database queries use parameterized postgres.js syntax (no string interpolation)
- Regular security reviews (monthly) and third-party audit (Phase C4)

**Why:** Payments systems are high-value targets for fraud. A single unencrypted token or SQL injection vulnerability can compromise all user bank accounts. Security must be built in, not audited in later.

### 2.8 Principle 8: Data Retention & Privacy

We retain data only as long as legally necessary. We comply with PIPEDA (Canada) and SOC 2 principles. We segment PII from transaction data where possible.

**Implementation:**
- User PII (name, email, address): retained for 3 years post-account-deletion (regulatory hold)
- Transaction ledgers: retained indefinitely (immutable audit trail)
- Login audit logs: retained 90 days
- Failed transaction attempts: retained 30 days
- Debug logs: retained 7 days (low-value, high-volume)
- All personal data is encrypted at rest (database-level encryption via Supabase)
- Users can request data export (PIPEDA Subject Access Request)
- Deletion requests delete PII but retain transaction records (referenced by ledger)

**Why:** PIPEDA is the law in Canada. Compliance is not optional. Proper data retention also reduces our exposure — storing PII for 10 years instead of 3 means 7 additional years of compromise risk if we are breached.

---

## Part 4: Technical Architecture Overview

### 4.1 System Context Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Manna Platform                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐      │
│  │   Client    │   │  Next.js 16  │   │  Middleware      │      │
│  │  (React 19) │──▶│  API Routes  │──▶│  (JWT Auth)      │      │
│  │  (Web/iOS)  │   │  (Serverless)│   │  (proxy.ts)      │      │
│  └─────────────┘   └──────────────┘   └──────────────────┘      │
│                           │                                       │
│                ┌──────────┼──────────┐                            │
│                │          │          │                            │
│        ┌───────▼───┐  ┌────▼───┐  ┌─▼──────────┐                │
│        │ Supabase  │  │  Plaid │  │   Wise     │                │
│        │PostgreSQL │  │  API   │  │    API     │                │
│        │           │  │ (Link) │  │  (FX Rate) │                │
│        └───────────┘  └────────┘  └────────────┘                │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Settlement Engine (Webhook → Settlement → Ledger → Balance)││
│  │  ├─ Provider Webhook Event Intake (deduplication)           ││
│  │  ├─ Settlement Orchestrator (plan state transitions)        ││
│  │  ├─ Settlement Executor (B3.1 status, B3.2a ledger, B3.2b) ││
│  │  └─ Notifications & Velocity (B3.3)                         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Compliance & Operations Layer                              ││
│  │  ├─ KYC Integration (Stripe Verification)                  ││
│  │  ├─ Velocity Enforcement (daily/monthly limits)            ││
│  │  ├─ AML Monitoring (transaction patterns, screening)       ││
│  │  ├─ Audit Logging (all actions immutable)                  ││
│  │  └─ Admin Dashboard (user lookup, transfer mgmt, metrics) ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Frontend** | React 19 with Next.js 16 Server Components | Modern, fast rendering, server-side data fetching |
| **Backend** | Next.js API Routes (serverless) | Unified codebase, scales to zero, Vercel auto-deploy |
| **Database** | Supabase PostgreSQL + postgres.js | ACID compliance, full-text search, no ORM overhead |
| **Authentication** | JWT (signed with HS256, stored in httpOnly cookie) | Stateless, works across Vercel edge/serverless boundaries |
| **Bank Linking** | Plaid API (Link component + Transfer API) | Instant account verification, secure token exchange |
| **FX Rates** | Wise API | Mid-market rates, low margin, real-time updates |
| **KYC/Verification** | Stripe Verification (document + liveness) | High accept rate, regulatory credibility, SOC 2 certified |
| **Payments** | Plaid Transfer API (US), TBD (Canada) | Embedded in provider abstraction, tested in sandbox |
| **Deployment** | Vercel (Hobby/Pro plan) | Git push auto-deploy, global CDN, free SSL |
| **Observability** | TBD (Datadog / LogRocket / self-hosted ELK) | Centralized logging, structured metrics, real-time alerting |
| **Incident Mgmt** | PagerDuty or Opsgenie | On-call rotation, escalation, incident creation automation |

### 4.3 Deployment Architecture

**Production Deployment (Vercel):**
```
master branch push
        │
        ▼
Vercel CI/CD (npm run build)
        │
        ├─ TypeScript compilation & type checking
        ├─ Next.js SSG/ISR generation
        ├─ Linting & basic security checks
        │
        ▼
Vercel Production Deployment
        │
        ├─ Edge Middleware (proxy.ts JWT validation)
        ├─ Serverless Functions (/app/api/*)
        ├─ Static assets (CDN)
        │
        ▼
Global CDN (Frankfurt, NYC, Tokyo, etc.)
        │
        ├─ TLS 1.3 termination
        ├─ DDoS protection
        ├─ Log aggregation
        │
        ▼
Production Database (Supabase PostgreSQL)
        │
        ├─ Transaction pooler for connection efficiency
        ├─ Backups (hourly, 30-day retention)
        ├─ Read replicas (optional scaling)
```

**Non-Production Environments:**

1. **Preview Deployments (Per Pull Request)**
   - Isolated Supabase branch database per preview
   - Used for B3.2b validation (Phase C1)
   - Zero risk to production
   - Auto-teardown after PR merge

2. **Staging Environment**
   - Long-lived staging database (separate from production)
   - Used for live provider testing before production switch
   - Full data privacy/encryption parity with production

3. **Local Development**
   - Local PostgreSQL or Docker Supabase container
   - Sandbox provider mode by default
   - Full schema with seed test data

### 4.4 Request Flow (Example: Send Money)

```
User clicks "Send $50 CAD to alice"
        │
        ▼
POST /api/transfers/intent (React form)
        │
        ├─ Middleware: Validate JWT, extract user_id
        ├─ Route: Call getAuthUser() → validate sender balance
        ├─ Route: Call TransferProviderFactory.getProvider(user.country) → SandboxUSProvider
        ├─ Route: Validate recipient exists, KYC status, daily velocity
        ├─ Route: Call provider.createTransferIntent() → returns intent with provider_reference_id
        ├─ Route: INSERT transfer_intents (status='draft', ...) → returns transfer_id
        │
        ▼
GET /api/transfers/{id}/review (React details page)
        │
        ├─ Route: SELECT transfer_intents WHERE id
        ├─ Route: Call provider.validateIntent() → checks balance, limits
        ├─ Route: Call lib/fx.ts buildFxQuote() → if cross-border, fetch mid-market rate from Wise
        │
        ▼
POST /api/transfers/{id}/confirm (User reviews & signs consent)
        │
        ├─ Route: Validate JWT signature on consent form
        ├─ Route: UPDATE transfer_intents SET consent_confirmed_at = NOW(), status = 'ready'
        ├─ Route: auditLog("transfer_ready", intent_id, user_id) → INSERT audit_logs
        │
        ▼
[Wait for provider webhook: settlement event arrives at Webhook handler]
        │
        ▼
POST /api/webhooks/plaid (Provider webhook, e.g., transfer settled)
        │
        ├─ Middleware: Verify webhook signature (provider-specific)
        ├─ Route: Call recordProviderEvent() → dedup on UNIQUE(provider, provider_event_id)
        ├─ Route: SELECT transfer_intents WHERE provider_reference_id
        ├─ Route: Call SettlementOrchestrator.planSettlement() → no side effects, just plans state change
        ├─ Route: Call SettlementExecutor.executeSettlement() → applies all phases:
        │   ├─ B3.1: UPDATE transfer_intents SET status = 'settled'
        │   ├─ B3.2a: INSERT ledger_entries (debit from sender, credit to recipient)
        │   ├─ B3.2b: UPDATE users SET balance_cad = balance_cad - 50 (for sender)
        │   ├─ B3.2b: UPDATE users SET balance_cad = balance_cad + 50 (for recipient)
        │   ├─ B3.3: Create in-app notifications
        │   ├─ B3.3: UPDATE velocity_checks (record against daily limit)
        │
        ▼
[Balance updates complete, ledger immutable, notifications sent]
        │
        ▼
User sees notification: "Your transfer to alice for $50 CAD has been settled"
```

---

## Part 5: Dual-Currency Financial Architecture

### 5.1 Wallet Model

Each user has a dual-currency wallet:

```
users table:
├─ id (UUID)
├─ email
├─ country ('CA' or 'US')
├─ balance_cad (NUMERIC(12, 2), default 100.00 for CA users)
├─ balance_usd (NUMERIC(12, 2), default 100.00 for US users)
├─ kyc_status ('pending', 'verified', 'rejected')
├─ created_at
└─ ...
```

**Invariants:**
- `balance_cad ≥ 0` (no negative balances)
- `balance_usd ≥ 0` (no negative balances)
- `balance_cad + balance_usd (converted to base currency) = sum(ledger_entries)`
- `balance_X` is updated only via immutable `ledger_entries` entries
- `balance_X` is never updated directly in application code; it is always derived

### 5.2 Ledger-Driven Balance Model

Balances are derived from the immutable ledger, not stored independently:

```
ledger_entries table:
├─ id
├─ user_id (who is affected)
├─ amount (NUMERIC(12, 2), always positive)
├─ currency ('CAD' or 'USD')
├─ entry_type ('debit' or 'credit')
├─ transaction_id (reference, nullable)
├─ transfer_intent_id (reference, nullable)
├─ description
├─ created_at (immutable, set once)
└─ ...

Function: getLedgerBalance(user_id, currency) →
  SELECT SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END)
  FROM ledger_entries
  WHERE user_id = $1 AND currency = $2
  // Result is the true balance, immutable, auditable
```

**Why this design?**
- **Auditability:** Every balance change is recorded with reason, timestamp, and context
- **Reproducibility:** Balance can be recomputed at any point in time by replaying ledger entries
- **Forensics:** If a balance discrepancy is found, the ledger reveals exactly what happened
- **Compliance:** Regulators can audit every transaction source and destination

### 5.3 Multi-Step Balance Update with Atomicity

When a transfer settles, balances are updated atomically via SQL arithmetic:

```typescript
// Not this (vulnerable to race conditions):
const balance = await getBalance(senderId);
await updateBalance(senderId, balance - amount);

// This (atomic, race-safe):
const result = await sql`
  UPDATE users
  SET balance_cad = balance_cad - ${amount}
  WHERE id = ${senderId} AND balance_cad >= ${amount}
  RETURNING balance_cad
`;

if (!result[0]) {
  throw new Error('Insufficient balance or user not found');
}
```

**Atomicity guarantees:**
- Read and write are a single SQL statement (no race condition window)
- Balance correctness is preserved even if 1000 concurrent transfers execute
- No lost updates, no double-spends

### 5.4 Dual-Entry Ledger Bookkeeping

Every send creates a debit-credit pair:

```
Transfer: Alice (CA) sends $100 CAD to Bob (CA)
        │
        ├─ Ledger entry 1: User=Alice, Amount=$100, Currency=CAD, Type=Debit, Reason="Transfer to Bob"
        ├─ Ledger entry 2: User=Bob, Amount=$100, Currency=CAD, Type=Credit, Reason="Transfer from Alice"
        │
        └─ Invariant: Sum(all debits) = Sum(all credits) per currency per settlement
```

**Benefits:**
- Every transfer is balanced (no money created/destroyed)
- Sender and recipient are both visible in audit trail
- Double-entry bookkeeping is the gold standard in accounting

### 5.5 Cross-Border FX Handling

When Alice (CA) sends to Bob (US), FX conversion happens at settlement:

```
Transfer: Alice (CA) sends equivalent of $100 CAD to Bob (US)

Step 1: Get FX quote from Wise API
  POST https://api.wise.com/v1/quotes
  { fromAmount: 100, fromCurrency: 'CAD', toCurrency: 'USD' }
  → Response: { id: 'quote123', rate: 0.73, toAmount: 73.00, expiresAt: ... }

Step 2: Record FX rate in ledger (immutable audit trail)
  INSERT ledger_entries (
    user_id=alice_id,
    amount=$100,
    currency='CAD',
    entry_type='debit',
    description='Cross-border transfer to Bob (USD); rate=0.73, toAmount=$73.00'
  )

Step 3: Credit Bob with USD equivalent
  INSERT ledger_entries (
    user_id=bob_id,
    amount=$73,
    currency='USD',
    entry_type='credit',
    description='Cross-border transfer from Alice (CAD); rate=0.73, fromAmount=$100'
  )

Step 4: Update balances atomically
  UPDATE users SET balance_cad = balance_cad - 100 WHERE id = alice_id
  UPDATE users SET balance_usd = balance_usd + 73 WHERE id = bob_id
```

**FX Audit Trail:**
- Every FX conversion logs: source currency, destination currency, rate, timestamp, quote_id
- Enables dispute resolution (if user claims rate was unfair, we can verify)
- Detects rate drift (if average daily rate deviates from market, we investigate)

### 5.6 Balance Reconciliation (Daily)

Phase C1.2 implements automated daily reconciliation:

```
Daily reconciliation process (runs 02:00 UTC):

Step 1: For each user, sum ledger entries
  SELECT user_id, 'CAD' as currency, 
         SUM(CASE WHEN entry_type='credit' THEN amount ELSE -amount END) as computed_balance
  FROM ledger_entries
  WHERE currency = 'CAD'
  GROUP BY user_id

Step 2: Compare to current balance
  SELECT id as user_id, balance_cad as stored_balance
  FROM users

Step 3: Report discrepancies
  IF computed_balance != stored_balance:
    INSERT reconciliation_discrepancies (
      user_id, currency, expected, actual, discrepancy_amount, detected_at
    )
    ALERT ops_team via PagerDuty (SEV-1 if discrepancy > $0)

Step 4: If discrepancy < $0.01 (floating point rounding), auto-correct
  UPDATE users SET balance_cad = computed_balance WHERE user_id = discrepant_user
  INSERT audit_logs (action='auto_reconciliation', ...)
```

**Expected outcome:**
- Zero discrepancies in normal operation (ledger-driven model guarantees this)
- If any discrepancy is found, immediately alert + investigate
- Monthly audit: comparison to external bank statements (cash in/out)

---

## Part 6: Event-Driven Settlement Architecture

### 6.1 Settlement State Machine

Every transfer passes through a well-defined state machine:

```
Draft State:
├─ No balance change yet
├─ Can be cancelled
├─ Awaiting user review and consent
│
Review State:
├─ Same as draft, but pending consent signature
│
Ready State:
├─ User has signed consent form
├─ Waiting for provider to execute (Plaid, EFT, etc.)
├─ Cannot be cancelled (user committed)
│
Processing State:
├─ Provider is processing (ACH in flight, EFT submitted, etc.)
├─ Balances tentative (not final)
├─ Can fail or return
│
Settled State:
├─ ✅ FINAL: Balance changes are permanent
├─ Ledger entries created
├─ Notifications sent
├─ Immutable thereafter
│
Failed State:
├─ ✅ FINAL: Provider rejected the transfer (insufficient funds, bad account, etc.)
├─ Balance reverted (no ledger entries created)
├─ User can retry
│
Returned State:
├─ ✅ FINAL: Provider settled but user initiated chargeback/return
├─ Balance reversed (reverse of settled ledger entries created)
├─ Full audit trail preserved
```

### 6.2 Settlement Phases (B3.1–B3.3)

Settlement is decomposed into three independent phases, each idempotent:

**Phase B3.1: Status Transitions**
```typescript
// Update transfer_intents status: ready → processing → settled/failed/returned
// Triggered by: Provider webhook event
// Idempotency: Check current status, only transition if valid state machine path exists
// Side effects: Only updates transfer_intents.status, no balance mutations
```

**Phase B3.2a: Ledger Entry Creation**
```typescript
// CREATE immutable ledger_entries (debit/credit pairs)
// Triggered by: After B3.1 status transition completes
// Idempotency: UNIQUE(transfer_intent_id, ledger_type) prevents duplicate entries
// Side effects: Only INSERT into ledger_entries, no balance mutations
```

**Phase B3.2b: Balance Updates**
```typescript
// UPDATE users.balance_X atomically
// Triggered by: After B3.2a ledger entries created
// Idempotency: Check balance_processed_at timestamp before updating
// Side effects: Only UPDATE users balance columns
```

**Phase B3.3: Notifications & Velocity**
```typescript
// Send in-app notifications, update velocity_checks
// Triggered by: After B3.2b balance update succeeds
// Idempotency: Check intent_id in notifications table, skip if already sent
// Side effects: INSERT notifications, UPDATE velocity_checks
```

**Why separate phases?**
- **Observability:** Each phase can fail independently, enabling targeted debugging
- **Auditability:** Can see exactly which phase succeeded/failed for each transfer
- **Resilience:** If B3.2b fails but B3.2a succeeded, we can manually correct balance without re-creating ledger
- **Compliance:** Auditors can verify each phase independently

### 6.3 Idempotent Webhook Processing

Provider webhooks are replayable:

```
Webhook arrives: "ACH transfer T123 settled"
        │
        ├─ Step 1: Parse webhook → extract (provider, event_id, timestamp, status)
        │
        ├─ Step 2: Deduplication layer
        │   SELECT COUNT(*) FROM provider_webhook_events
        │   WHERE provider='plaid' AND provider_event_id='evt_123'
        │   → If count > 0: Already processed, return 200 (idempotent)
        │   → If count = 0: Continue
        │
        ├─ Step 3: Record event (for audit trail)
        │   INSERT provider_webhook_events (
        │     provider='plaid',
        │     provider_event_id='evt_123',
        │     event_payload=$payload,
        │     received_at=NOW()
        │   )
        │
        ├─ Step 4: Look up transfer intent
        │   SELECT transfer_intents WHERE provider_reference_id = T123
        │
        ├─ Step 5: Plan settlement (no side effects)
        │   SettlementOrchestrator.planSettlement(intent) → SettlementPlan
        │
        ├─ Step 6: Execute settlement (atomic, idempotent)
        │   SettlementExecutor.executeSettlement(plan) → SettlementOutcome
        │
        └─ Step 7: Return 200 (success or idempotent replay, both OK)

On retry (webhook times out, Vercel restarts):
        │
        ├─ Webhook re-arrives with same provider_event_id
        │
        ├─ Step 2: Deduplication check → already in provider_webhook_events
        │
        ├─ Step 5–6: Orchestrator/Executor check balance_processed_at, find it already set
        │
        └─ Return 200 (no double-debit, balance correct)
```

### 6.4 Error Handling & Dead-Letter Queue (Phase C1.3)

If settlement fails, error is logged and transfer is retryable:

```
Webhook processing fails:
  E.g., provider_webhook_events INSERT fails due to DB connection
        │
        ├─ Catch block logs error with full context (user_id, intent_id, error message)
        │
        ├─ Insert into dead_letter_queue (separate table)
        │   INSERT dead_letter_queue (
        │     webhook_payload=$payload,
        │     error_message=$err,
        │     failed_at=NOW()
        │   )
        │
        └─ Return 202 Accepted (webhook caller should retry)

Ops team monitoring:
  → Alert fires: "Dead letter queue has > 10 events for > 5 min"
  → Ops investigates root cause (DB down? API throttled?)
  → Once fixed, ops manually triggers reprocessing
  → Dead letter queue automatically reprocesses all pending webhooks
```

### 6.5 Provider Transitions (Phase C4)

When switching from sandbox to live provider:

```
Current (Sandbox):
  All transfers route to SandboxUSProvider / SandboxCAProvider
  executeTransfer() is blocked intentionally (throws)
  No real money moves

Week 7 (Phase C4.1, Plaid):
  Begin canary rollout:
    5% of US transfers → PlaidTransferProvider (live ACH)
    95% of US transfers → SandboxUSProvider (sandbox mode)
  Monitor error rate, settlement time, webhook success rate
  
Week 7–9:
  Gradually increase: 5% → 10% → 25% → 50% → 100%
  If any issue detected, halt rollout, investigate, fix, resume
  
Week 10:
  100% of US transfers now use PlaidTransferProvider
  Full live ACH integration
  Canadian EFT follows same pattern (weeks 8–10)

Post-launch (Week 11):
  Monitor live transfers 24/7
  On-call team handles any failures
  Daily reconciliation with banks
```

**Why canary?**
- Real providers behave differently than sandboxes (latency, error rates, webhook timing)
- Canary catches issues at small scale (5% of volume) before they affect all users
- Automatic rollback if error rate exceeds threshold
- User-facing impact is minimized

---

## Part 7: Provider Strategy & Integration

### 7.1 Provider Abstraction Layer

All payment providers implement the `TransferProvider` interface:

```typescript
interface TransferProvider {
  // Create a new transfer intent, get unique provider reference ID
  createTransferIntent(input: TransferIntentInput): Promise<{
    provider_reference_id: string;
    status: 'draft' | 'ready';
    estimatedFee?: number;
  }>;

  // Validate intent before execution (check balance, limits, recipient validity)
  validateIntent(intent: TransferIntent): Promise<ValidationResult>;

  // Execute the actual transfer (debit from one account, credit to another)
  executeTransfer(intent: TransferIntent): Promise<ExecutionResult>;

  // Get current status from provider (is transfer settled? failed? pending?)
  getTransferStatus(provider_reference_id: string): Promise<TransferStatus>;

  // Cancel a transfer (only if not yet settled)
  cancelTransfer(provider_reference_id: string): Promise<void>;

  // Reverse a transfer (only if already settled; used for chargebacks)
  reverseTransfer(provider_reference_id: string, amount: number): Promise<void>;

  // Parse an incoming webhook event from provider
  parseWebhookEvent(payload: unknown): Promise<WebhookEvent>;
}
```

### 7.2 Provider Selection (Factory Pattern)

`TransferProviderFactory` selects the provider based on user context:

```typescript
function getProvider(
  userCountry: 'CA' | 'US',
  executionMode: 'sandbox' | 'live',
  featureFlags?: Record<string, boolean>
): TransferProvider {
  // Feature flag logic: allows gradual rollout of new providers
  if (featureFlags?.['use_plaid_transfer'] && userCountry === 'US') {
    return new PlaidTransferProvider(); // 5% canary initially
  }

  if (userCountry === 'US') {
    return new SandboxUSProvider(); // Default to sandbox
  }

  if (userCountry === 'CA') {
    return new SandboxCAProvider(); // Default to sandbox
  }

  throw new Error(`Unsupported country: ${userCountry}`);
}
```

**Benefits:**
- Business logic never knows which provider is being used
- Providers are stateless (all state in database)
- Swapping providers requires only one-line change in factory
- Feature flags enable canary rollout without code deploy

### 7.3 US Provider Strategy: Plaid Transfer API

**Current (Q2 2026):**
- Plaid Transfer API not yet integrated (awaiting product availability)
- All US transfers in sandbox mode (no real ACH)

**Phase C4.1 (Week 7–9, Q3 2026):**
```
PlaidTransferProvider implementation:
├─ createTransferIntent():
│  └─ Calls plaid.transfers.create() → returns transfer_id
│
├─ validateIntent():
│  └─ Calls plaid.transfers.validate() → checks processor rules
│
├─ executeTransfer():
│  └─ Calls plaid.transfers.execute() → submits ACH to processor
│
├─ getTransferStatus():
│  └─ Calls plaid.transfers.get() → queries settlement status
│
├─ parseWebhookEvent():
│  └─ Maps plaid.transfer.settled → settlement event
│     Maps plaid.transfer.failed → failure event
│     Maps plaid.transfer.returned → return event
│
└─ WebHook events: settled, failed, returned (3 terminal states)
```

**Webhook Integration:**
- Plaid sends webhooks to `/api/webhooks/plaid`
- Each webhook triggers settlement executor
- Balance updates only on settled event
- Failed/returned events handled separately

**Canary Deployment (Phase C4.1):**
```
Week 7: 5% of US transfers to PlaidTransferProvider
  → Monitor: error rate, avg settlement time, webhook reliability
  → Target: < 0.5% error rate, < 2 business days settlement
  
Week 8: 25% of US transfers
  
Week 9: 100% of US transfers
```

### 7.4 Canadian Provider Strategy: EFT Integration

**Current (Q2 2026):**
- No live Canadian EFT provider integrated
- All CA transfers in sandbox mode

**Phase C4.2 (Week 8–10, Q3 2026):**
```
Candidate providers (TBD based on due diligence):
├─ Payments Canada EFT (direct access, high cost)
├─ Wealthsimple for Business (API, moderate cost)
├─ Stripe (via ACH via CAD-USD conversion, complexity)
└─ Custom EFT processor (build vs. buy decision pending)

Evaluation criteria:
├─ Settlement time (same-day EFT preferred)
├─ Cost per transaction (< 1%)
├─ Webhook reliability (99.9%+ uptime)
├─ Regulatory alignment (licensed in Canada)
├─ SDK availability (need TypeScript/Node support)
├─ Integration effort (weeks vs. months)
└─ Compliance support (KYC/AML reporting)
```

**Decision: Q2–Q3 2026**
- RFP sent to 3–4 providers by July 2026
- Selection and contracting by August 2026
- Integration and testing by September 2026
- Canary rollout 5% → 100% by September 2026

### 7.5 FX Provider Strategy: Wise

**Current:**
- Wise API integrated for real-time FX quotes
- Used in cross-border transfers to calculate conversion amounts
- Rate expires after 30 min, user must execute within window

**Future (Phase C4 integration):**
- Extend Wise to handle actual fund movement (EUR, GBP, etc.)
- Connect Wise account to receive INR, PHP, etc. inbound transfers
- Wise webhook for arrival confirmation

**Regulatory note:**
- Wise is not a full payment processor (no USD/CAD direct debit)
- Wise is supplementary: used for FX rates and optional non-CAD/USD corridors
- Primary payment flow remains Plaid (US) + EFT (CA)

---

## Part 8: Security Model

### 8.1 Authentication & Authorization

**JWT-Based Stateless Authentication:**

```typescript
// On login: user credentials verified → JWT issued
POST /api/auth/login
  { email, password }
  → validate password hash
  → issue JWT: sign({ user_id, email, country }, JWT_SECRET, { expiresIn: '24h' })
  → set cookie: Set-Cookie: manna-token=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400

// On every request: middleware validates JWT
middleware (proxy.ts):
  → extract cookie: manna-token
  → verify JWT signature: verify(jwt, JWT_SECRET)
  → extract user_id, check expiry
  → attach user context to request
  → if invalid: redirect to /login (401 Unauthorized)

// Special case: Sensitive operations (balance correction, manual settlement)
  → require JWT + proof of MFA (2FA code from authenticator app)
  → store MFA secret in users table (encrypted)
```

**Authorization Rules:**
```
POST /api/transfers/*/confirm → only intent owner can confirm
GET /api/transfers/* → owner or peer can view details
POST /api/admin/users/*/balance-correct → admin + MFA required
GET /api/admin/audit-logs → admin + IP whitelist + MFA
```

### 8.2 Data Encryption

**Encryption at Rest:**

```
Supabase PostgreSQL (default encryption):
  All data encrypted with AES-256-GCM at database level
  Managed by Supabase (AWS KMS keys)

Sensitive fields (application-level encryption):
  users.mfa_secret → AES-256-GCM encrypted with ENCRYPTION_KEY env var
  bank_accounts.plaid_access_token_enc → AES-256-GCM encrypted
  password_reset_tokens.token_hash → SHA-256 hashed (one-way)
  password hashes → bcrypt (12 rounds, one-way)
```

**Encryption in Transit:**

```
All HTTP → HTTPS (TLS 1.3 required)
All API responses include: X-Content-Type-Options: nosniff, X-Frame-Options: DENY
All cookies marked: HttpOnly, Secure, SameSite=Strict
HSTS header: Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### 8.3 Rate Limiting

**Tiered rate limiting (Phase C1.4):**

```
Per-user limits:
  ├─ 100 requests / minute (general API)
  ├─ 10 transfers / hour (transfer creation)
  ├─ 5 payment confirmations / hour
  └─ Applied via Redis key: rate:user:{user_id}:{endpoint}

Per-IP limits:
  ├─ 5 login attempts / hour (brute force protection)
  ├─ 20 register attempts / hour
  └─ Applied via Redis key: rate:ip:{ip_address}:{endpoint}

Per-endpoint limits:
  ├─ FX quote: 100 requests / minute (prevent quote scraping)
  ├─ Plaid link token: 50 / hour per user
  └─ Fallback: 5000 requests / hour per IP (global)

Implementation:
  Before route handler: check Redis key, increment counter, set expiry
  If counter > limit: return 429 Too Many Requests
  Client should retry after Retry-After header
```

### 8.4 Velocity Controls

**Velocity limits (enforced at confirmation time):**

```
New users (KYC tier: unverified):
  ├─ Daily limit: $500 (CAD or USD equivalent)
  ├─ Monthly limit: $5,000
  └─ Per-transaction limit: $100

Verified users (KYC passed):
  ├─ Daily limit: $5,000
  ├─ Monthly limit: $50,000
  └─ Per-transaction limit: $10,000

High-value users (legacy merchants, plus verification):
  ├─ Daily limit: Unlimited
  ├─ Monthly limit: Unlimited
  └─ Per-transaction limit: Unlimited

Implementation:
  SELECT SUM(amount) FROM velocity_checks
  WHERE user_id = $1 AND DATE(created_at) = TODAY()
  If sum + new_transfer > daily_limit: reject with 402 payment_required
```

### 8.5 Admin API Security

**Admin endpoints restricted (Phase C1.4):**

```
All admin endpoints: /api/admin/*
├─ Require valid JWT from admin user
├─ Require MFA token (second factor)
├─ Require IP whitelist match (e.g., office IPs only)
├─ Rate limited: 100 requests / hour per admin
├─ All actions audit-logged with admin user_id

Example:
  POST /api/admin/users/{id}/balance-correct
  Headers: Authorization: Bearer <jwt>, X-MFA-Token: <totp_code>
  Request: { reason: 'Refund for failed transfer T123', amount: 50, currency: 'CAD' }
  Response: { success: true, balance_before: 150, balance_after: 200, ledger_entry_id: '...' }
  Audit log: { admin_id, action: 'balance_correct', user_id, amount, reason, timestamp }
```

### 8.6 SQL Injection Prevention

**All queries use parameterized postgres.js syntax:**

```typescript
// ✅ Safe: Parameterized
const user = await sql`SELECT * FROM users WHERE id = ${userId}`;

// ✅ Safe: Column name escaped
const column = 'balance_cad';
await sql`UPDATE users SET ${sql(column)} = ${sql(column)} + ${amount}`;

// ❌ Dangerous: Never do this (unsafe string interpolation)
const user = await sql.unsafe(`SELECT * FROM users WHERE email = '${email}'`);
```

### 8.7 Secrets Management

**Environment variables (Vercel):**

```
DATABASE_URL           → Supabase connection string (pooler endpoint)
JWT_SECRET             → Long random string (256 bits minimum)
PLAID_CLIENT_ID        → From Plaid dashboard
PLAID_SECRET           → From Plaid dashboard (not exposed to frontend)
WISE_API_KEY           → From Wise developer settings
PLAID_TOKEN_ENCRYPTION_KEY → 64-char hex (AES-256 key for token encryption)
STRIPE_SECRET_KEY      → From Stripe dashboard (sk_live_...)
STRIPE_WEBHOOK_SECRET  → From Stripe webhook settings (whsec_...)
```

**Rotation (Phase C1.4):**
- Every 90 days: rotate JWT_SECRET
  - Issue new secret in Vercel
  - Keep old secret valid for 7 days (for token grace period)
  - After 7 days, deactivate old secret
- Every 180 days: rotate PLAID_CLIENT_ID (if Vercel rotation available)
- Every 180 days: rotate API keys (Wise, Stripe)

---

## Part 9: Compliance & Regulatory Roadmap

### 9.1 Regulatory Landscape

Manna operates as a **Money Services Business (MSB)** under:

**Canada:**
- FINTRAC regulations (Financial Transactions and Reports Analysis Centre)
- PIPEDA (Personal Information Protection and Electronic Documents Act)
- Provincial money transmitter licenses (some provinces require separate licenses)

**United States:**
- FinCEN regulations (Financial Crimes Enforcement Network)
- State money transmitter licenses (each state has requirements)
- OFAC compliance (Office of Foreign Assets Control sanctions)

**Cross-Border:**
- FATF recommendations (Financial Action Task Force)
- Mutual Legal Assistance Treaty (MLAT) obligations

### 9.2 Phase C1.1: Regulatory Assessment (Weeks 1–2)

**Deliverables by end of Week 2:**

```
MSB Licensing Analysis:
├─ Identification of all required licenses (US: 51 states, Canada: Federal + 3 provinces)
├─ Timeline to obtain each license (typical: 2–6 months)
├─ Cost estimate per jurisdiction ($10k–$50k per state)
├─ Documentation requirements (business plan, AML policy, financial statements)
└─ Risk-based approach: Phase 1 = US + Canadian federal only, Phase 2 = other states

Regulatory Risk Assessment:
├─ Known gaps vs. FINTRAC requirements (current state: no monitoring)
├─ Known gaps vs. FinCEN requirements (current state: basic KYC only)
├─ Known gaps vs. sanctions screening (current state: not implemented)
├─ Known gaps vs. transaction reporting (current state: not implemented)
├─ Estimated remediation effort: 400+ hours over 3 months

Compliance Roadmap with Timelines:
├─ Q3 2026: MSB licensing applications filed (legal team)
├─ Q4 2026: First jurisdiction licenses received (expected: Canada federal)
├─ Q1 2027: US state licenses (5–10 states initially)
├─ Q2 2027: Expanded jurisdiction coverage

Terms of Service & Privacy Policy (PIPEDA-Compliant):
├─ User data collection (email, name, address, phone, ID document)
├─ Data retention policy (3 years post-account-deletion for regulatory hold)
├─ User rights (access, deletion, portability)
├─ Dispute resolution process (arbitration vs. litigation)
├─ Liability limitations (no coverage for user mistakes)
└─ Regulatory disclosures (we may share info with authorities)

AML/KYC Policy Documentation:
├─ Risk-based KYC approach (verify identity, beneficial owner, source of funds)
├─ Customer Due Diligence (CDD) procedures
├─ Enhanced Due Diligence (EDD) for high-risk users
├─ Ongoing transaction monitoring procedures
├─ Suspicious Activity Report (SAR) escalation procedures
└─ Compliance officer designation and contact info

Incident Response & Notification Procedures:
├─ Definition of reportable incidents (data breach, regulatory violation, fraud)
├─ Internal escalation process (ops → compliance officer → legal)
├─ Regulatory notification timeline (FINTRAC: within 90 days of discovery)
├─ Customer notification process (affected users within 30 days)
└─ Documentation and audit trail

FINTRAC/FinCEN Reporting Framework:
├─ CTR (Currency Transaction Report) for transfers > $10k CAD / $10k USD
├─ SAR (Suspicious Activity Report) for suspicious patterns
├─ Record-keeping obligations (3 years minimum)
├─ Reporting deadlines and formats
├─ Integration with settlement system (automated flagging)
```

**Legal team responsibility:** 95% of this phase is legal/regulatory analysis. Engineering supports with:
- Database schema to track KYC tier, sanctions screening status, transaction flags
- Admin UI for manual SAR initiation
- Reporting APIs for regulatory submissions

### 9.3 Phase C1.2–C1.4: Compliance Engineering (Weeks 1–6)

**KYC Integration (Current):**
```
Current state:
├─ Stripe Verification integrated
├─ Document + liveness check required to send transfers > $1,000
├─ KYC status: 'pending', 'verified', 'rejected'
├─ Pending: API not live in Vercel (needs STRIPE_WEBHOOK_SECRET configured)

Phase C1 work:
├─ Live configuration in Vercel (Q3 2026)
├─ Webhook handler for KYC completion
├─ Automatic velocity limit tier assignment
├─ Manual KYC review UI (admin can override)
```

**Sanctions Screening (Phase C4):**
```
Required by Q4 2026:

Integration options:
├─ OFAC SDN (Specially Designated Nationals) list check
├─ Third-party vendor: Refinitiv, Accuity, World-Check
├─ Cost: $5k–$50k/month depending on volume

Workflow:
├─ At KYC verification: screen customer name against OFAC
├─ At transfer confirmation: screen recipient name + IBAN/account
├─ On match: auto-reject transfer, notify user, alert compliance officer
├─ On soft match: manual review queue
```

**Transaction Monitoring (Phase C4):**
```
Automated monitoring for suspicious patterns:

Rules:
├─ Multiple transfers > $5k in single day (structuring)
├─ Transfer to/from high-risk jurisdictions (FATF gray list)
├─ Round-amount transfers (e.g., $1000 + $1000 + $1000 in sequence)
├─ Rapid cash-out after cash-in (money laundering patterns)
├─ Account created then large transfer within 24 hours

Actions:
├─ Flag for manual review (compliance officer)
├─ Auto-reject if match high-confidence rules
├─ Auto-create SAR if suspicious activity confirmed
├─ Escalate to FINTRAC/FinCEN if required
```

**CTR & SAR Reporting (Phase C4):**
```
Automated reporting generation:

CTR (Currency Transaction Report):
├─ Triggered: Any single transfer > $10k CAD or $10k USD
├─ Submitted to: FINTRAC (Canada), FinCEN (US)
├─ Timeline: Within 15 days of transaction
├─ Fields: Sender, recipient, amount, currency, date, channel

SAR (Suspicious Activity Report):
├─ Triggered: Transaction flagged as suspicious by rules or manual override
├─ Submitted to: FINTRAC (Canada), FinCEN (US)
├─ Timeline: Within 90 days of detection
├─ Fields: Detailed description of suspicious activity, user history, rationale

Implementation:
├─ Background job: daily batch generation of CTRs
├─ Background job: weekly review of SAR queue, batch submission
├─ Immutable storage: all submitted reports in audit_logs for compliance audit
```

### 9.4 User Impact: Compliance in Practice

**Scenario 1: New User Registers (Unverified)**
```
User registers with email, password, country
├─ Seed balance: $100 CAD or USD
├─ Status: unverified
├─ Velocity: $500/day limit

User wants to send $2,000 to friend:
├─ System requires KYC verification
├─ User uploads ID (driver's license, passport)
├─ Liveness check: user takes selfie, system confirms live match to ID
├─ Stripe Verification API validates → KYC status = 'verified'
├─ Velocity limit updated: $5,000/day
├─ Transfer proceeds
```

**Scenario 2: Transfer > $10k (CTR Required)**
```
Verified user sends $15,000 CAD to friend
├─ Transfer settles normally (ledger entries, balance updated)
├─ Background job detects amount > $10k
├─ CTR auto-generated with user details
├─ CTR submitted to FINTRAC
├─ No user-facing impact (automatic)
├─ Audit log shows: "CTR generated for transfer_intent_id=T123"
```

**Scenario 3: Suspicious Activity Detected (SAR)**
```
User: creates account, sends $5k immediately, then tries to send $5k to different recipient next day
├─ Transaction monitoring rule triggers: "Account created + rapid large transfer"
├─ Transfer flagged as suspicious
├─ Compliance officer reviews in dashboard:
│  ├─ Sees user profile, KYC status, transfer history
│  ├─ Decides: manual review vs. auto-reject
│  ├─ If suspicious: initiates SAR workflow
│  └─ If legitimate: clears flag, transfer proceeds
├─ If SAR filed: submitted to FINTRAC within 90 days
```

---

## Part 10: Operations & Observability

### 10.1 Phase C2: Operations Console (Weeks 3–4)

The operations console is a web-based dashboard enabling support and compliance teams to work without database access.

**C2.1: User Management Console**

```
GET /api/admin/users?search=email_or_phone_or_id
│
├─ User detail view:
│  ├─ Identity: email, phone, country, KYC status, KYC tier
│  ├─ Balances: balance_cad, balance_usd, lifetime volume
│  ├─ Limits: daily velocity limit, lifetime KYC tier
│  ├─ Transactions: paginated list of last 50 transfers (sender/receiver)
│  ├─ Audit log: all actions affecting this user (balance corrections, KYC approvals, etc.)
│  └─ Actions available:
│     ├─ Approve/reject KYC (with notes)
│     ├─ Correct balance (requires approval, creates audit trail)
│     ├─ Override velocity limit (temporary or permanent)
│     ├─ Freeze account (prevent transfers)
│     └─ Export user data (PIPEDA request)
```

**C2.2: Transfer Operations Console**

```
GET /api/admin/transfers?status=processing&date_range=...
│
├─ Transfer search:
│  ├─ By transfer ID
│  ├─ By sender/recipient email
│  ├─ By status (draft, ready, processing, settled, failed, returned)
│  ├─ By date range
│  └─ By amount range
│
├─ Transfer detail view:
│  ├─ Intent: sender, recipient, amount, currency, created_at
│  ├─ Provider: provider_name, provider_region, provider_reference_id
│  ├─ Status: current status, transitions timestamp
│  ├─ Ledger entries: immutable debit/credit pairs created
│  ├─ Audit log: B3.1/B3.2a/B3.2b execution status
│  ├─ Webhooks: all provider_webhook_events for this transfer
│  └─ Actions available:
│     ├─ Manual settlement (draft/ready → settled, requires approval)
│     ├─ Manual cancellation (draft/ready only)
│     ├─ Manual refund (settled → reversed, creates offset ledger entries)
│     ├─ Force completion (processing → settled, requires approval + justification)
│     └─ View webhook history
```

**C2.3: Velocity Management Console**

```
GET /api/admin/velocity?user_id=...
│
├─ User velocity status:
│  ├─ Daily limit: $500 (tier 0), $5k (tier 1), unlimited (tier 2)
│  ├─ Today's volume: $XXX / limit
│  ├─ This month's volume: $XXX
│  └─ Actions:
│     ├─ Temporarily override (e.g., increase to $10k for next 24 hours)
│     ├─ Permanently upgrade tier (require compliance approval)
│     └─ Reset counter (for legitimate cases, with audit trail)
```

### 10.2 Phase C3: Monitoring & Alerting (Weeks 5–6)

**C3.1: Structured Logging**

```
All API routes emit structured JSON logs:

Example request:
  POST /api/transfers/T123/confirm
  User: alice@example.com, Country: CA

Log output:
{
  "timestamp": "2026-06-28T14:32:10Z",
  "level": "info",
  "request_id": "req_78f9a2b1c4d5",
  "service": "manna-api",
  "environment": "production",
  "user_id": "user_alice_ca_123",
  "user_country": "CA",
  "action": "transfer_confirm",
  "transfer_id": "T123",
  "amount": 100,
  "currency": "CAD",
  "recipient_id": "user_bob_ca_456",
  "kyc_status": "verified",
  "velocity_check": "passed",
  "consent_signature": "valid",
  "latency_ms": 245,
  "status": "success",
  "message": "Transfer T123 confirmed; waiting for provider settlement"
}

Log aggregation (Datadog / LogRocket):
├─ All logs shipped to centralized system
├─ Searchable by: timestamp, user_id, request_id, action, status
├─ Retention: 30 days for full logs, 90 days for audit logs only
├─ Cost: ~$500–$2000/month depending on volume
```

**C3.2: Metrics Collection (Prometheus)**

```
Instrumented metrics:

Request metrics:
├─ http_requests_total (counter)
│  └─ Labels: method, endpoint, status, user_country
├─ http_request_duration_seconds (histogram)
│  └─ Labels: method, endpoint
│  └─ Buckets: [0.01, 0.05, 0.1, 0.5, 1.0, 2.0, 5.0]
├─ http_request_size_bytes (histogram)
├─ http_response_size_bytes (histogram)

Financial metrics:
├─ transfers_created_total (counter)
│  └─ Labels: country, currency
├─ transfers_settled_total (counter)
├─ transfers_failed_total (counter)
├─ transfers_returned_total (counter)
├─ transfer_settlement_duration_hours (histogram)
├─ transfer_amount_total (gauge)
│  └─ Per currency, tracks total value settled
├─ revenue_usd (gauge) ← sum of all transfers converted to USD
├─ kyc_verification_rate (gauge) ← (verified users) / (total users)

Database metrics:
├─ db_query_duration_seconds (histogram)
│  └─ Labels: query_type (select, insert, update, delete)
├─ db_connection_pool_active (gauge)
├─ db_connection_pool_idle (gauge)

API error metrics:
├─ api_errors_total (counter)
│  └─ Labels: endpoint, error_type
├─ api_timeout_errors_total (counter)
├─ api_validation_errors_total (counter)
```

**C3.3: Alerting Rules (PagerDuty)**

```
SEV-1 (Page ops immediately):
├─ API error rate > 5% for 5 minutes
├─ Database unavailable for 2 minutes
├─ Transfer settlement failed 3+ times in a row (likely provider issue)
├─ Unauthorized access attempts: 5+ in 10 minutes
├─ Payment processor authentication failed
├─ Webhook queue backlog > 1000 events

SEV-2 (Page within 15 minutes):
├─ Error rate > 1% for 10 minutes
├─ P99 latency > 2 seconds for 10 minutes
├─ CPU usage > 80% for 5 minutes
├─ Failed transfer queue growing (> 100 transfers pending manual review)
├─ Balance reconciliation discrepancy detected
├─ Log storage quota > 80% full

SEV-3 (Daily digest):
├─ Unused dependencies detected
├─ Log storage quota > 90% full
├─ Upcoming certificate expiry (< 30 days)

Escalation:
├─ On-call engineer: page immediately
├─ If not acknowledged after 15 min: auto-escalate to manager
├─ If not resolved after 30 min: auto-escalate to VP Eng
├─ Incident ticket: auto-created in Jira/GitHub Issues
├─ Slack: auto-post to #incidents channel with context (recent errors, metrics, logs)
```

---

## Part 11: Incident Management & Disaster Recovery

### 11.1 Incident Response Procedures

**Phase C2 (Weeks 3–4): Runbook Documentation**

```
Runbook 1: Resolve Stuck Transfer (in Processing > 7 days)

Symptom:
  User reports transfer initiated 10 days ago, still shows "processing"
  Status remains stuck in transfer_intents.status = 'processing'
  No settled/failed/returned event from provider

Steps:
  1. Identify transfer: /api/admin/transfers/{id}
  2. Verify no recent provider webhooks: check provider_webhook_events for this transfer_id
  3. Check provider status: manually query Plaid API for transfer status (if Plaid provider)
  4. Decision tree:
     - If provider says "settled": trigger settlement executor with provider webhook (manual replay)
     - If provider says "failed": mark as failed in admin dashboard, refund balance
     - If provider says "processing": wait additional 24 hours, check tomorrow
     - If provider has no record: likely lost in transmission, cancellation required
  5. If cancellation needed:
     - Verify balance hasn't been debited (check ledger_entries)
     - Call provider.cancelTransfer(provider_reference_id)
     - Update transfer_intents.status = 'cancelled'
     - Send user notification: "Transfer cancelled; balance refunded"
  6. Document in audit_logs: what action was taken, why, by whom

Runbook 2: Handle Failed KYC Verification

Symptom:
  User's KYC verification is stuck in 'pending' state for > 3 days
  No Stripe webhook received (likely network issue or invalid submission)

Steps:
  1. Identify user: /api/admin/users?search=email
  2. Check KYC status: stripe_kyc_status = 'pending', stripe_verification_id = 'v_123'
  3. Manually query Stripe Verification API: what is status of v_123?
  4. Decision tree:
     - If Stripe says "verified": manually approve in admin UI (triggers KYC status update)
     - If Stripe says "rejected" (doc blurry, etc.): notify user to retry, provide guidance
     - If Stripe says "processing": wait 24 hours (typical: 1 hour)
  5. If manual approval: create audit log entry, notify user, update velocity tier

Runbook 3: Balance Discrepancy Detected (Daily Reconciliation)

Symptom:
  Daily reconciliation job detects user's balance != sum(ledger_entries)
  Example: balance_cad = 550, but ledger sum = 500 (discrepancy of +$50)

Steps:
  1. Verify discrepancy: manually query ledger sum and compare to balance
  2. Identify root cause:
     - Recent balance correction? (check audit_logs for manual corrections)
     - Duplicate ledger entry? (check for duplicate transfer_intent_ids in ledger)
     - Failed balance update mid-execution? (check settlement_executor logs for B3.2b failures)
  3. If duplicate ledger entry:
     - Find the duplicate entry_id
     - Create reversal ledger entry (opposite debit/credit)
     - This restores correct balance without modifying original entry
  4. If failed balance update:
     - Manually re-run settlement executor for that transfer
     - Check that balance_processed_at is now set in provider_webhook_events
  5. After fix: verify reconciliation passes
  6. Investigate root cause and file incident ticket
```

### 11.2 Disaster Recovery Plan

**Backup & Recovery Strategy:**

```
Database backups (Supabase):
├─ Frequency: hourly automated backups
├─ Retention: 30 days (per Supabase default)
├─ Recovery time objective (RTO): 4 hours
├─ Recovery point objective (RPO): 1 hour
├─ Testing: monthly recovery drill to staging environment

Immutable audit trail:
├─ All financial actions recorded in ledger_entries, audit_logs
├─ Transfer_intents history (no deletes, only status changes)
├─ Provider_webhook_events immutable (cannot modify or delete)
└─ Benefit: even if database is corrupted, audit trail can be rebuilt

Disaster scenarios:

Scenario A: Database corruption (e.g., bit flip causes balance corruption)
├─ Detection: daily reconciliation finds widespread discrepancies
├─ Action 1: restore from most recent hourly backup (max 1 hour of data loss)
├─ Action 2: rebuild balances from ledger_entries (immutable source of truth)
├─ Action 3: manual verification of last hour of transfers
├─ Expected downtime: 2–4 hours

Scenario B: Accidental data deletion (e.g., ops runs wrong SQL delete)
├─ Detection: monitoring alerts for unexpected transaction volume drop
├─ Action: restore from backup pre-deletion
├─ Expected downtime: 1–2 hours

Scenario C: Provider outage (Plaid down, cannot process transfers)
├─ Expected impact: can accept new intents, but cannot settle
├─ Mitigation: queue transfers, retry when provider recovers
├─ Manual override: ops can force settlement if provider API returns after recovery
├─ Expected downtime: 1–24 hours (depends on provider recovery)

Scenario D: Vercel/CDN outage
├─ Expected impact: API endpoints unavailable, UI unreachable
├─ Mitigation: auto-failover to other regions (Vercel global CDN)
├─ Rollback: can promote previous production deployment
├─ Expected downtime: 5–15 minutes

Scenario E: Regulatory incident (unauthorized access, data breach)
├─ Immediate action: incident response team activates
├─ Legal notification: contact legal team + insurance
├─ Customer notification: affected users notified within 30 days per PIPEDA
├─ Regulatory notification: FINTRAC notified within 90 days if required
├─ Post-incident: security audit, fix root cause, file incident report
```

### 11.3 Testing & Drills

**Incident response drills (quarterly):**

```
Q3 2026 Drill 1: Stuck Transfer Scenario
├─ Simulated transfer in "processing" state for > 7 days
├─ Ops team follows runbook
├─ Expected resolution: < 30 minutes
├─ Post-drill: measure, improve runbook

Q4 2026 Drill 2: Database Restoration
├─ Restore staging database from production backup
├─ Verify balance correctness
├─ Expected time: < 4 hours
├─ Validate no data loss

Q1 2027 Drill 3: Provider Outage
├─ Simulate Plaid API returning errors
├─ Verify queue, retry, and manual override mechanisms work
├─ Expected impact: no lost transfers, queued until provider recovers
```

---

## Part 12: Scaling & Performance Strategy

### 12.1 Current Performance Baseline (Q2 2026)

```
Load: Sandbox environment (< 50 concurrent users)
├─ P50 API latency: ~150ms
├─ P95 API latency: ~350ms
├─ P99 API latency: ~600ms
├─ Error rate: < 0.1%
├─ Transfer settlement time: < 1 second (sandbox provider)
├─ Daily transaction volume: ~10–50 transfers

Database:
├─ Connection pool: 10 active connections
├─ Query time (avg): ~50ms
├─ Database size: ~200 MB (test data)
```

### 12.2 Production Performance Targets (2026–2027)

```
Phase C5 Launch (Q4 2026):
├─ P50 API latency: < 200ms
├─ P95 API latency: < 500ms
├─ P99 API latency: < 1 second
├─ Error rate: < 0.5%
├─ Transfer settlement time: 1–3 business days (provider-dependent)
├─ Concurrent users: 100–1,000
├─ Daily transaction volume: 100–1,000 transfers

2027 Scaling Target:
├─ Daily transaction volume: 10,000–100,000 transfers
├─ P99 API latency: < 500ms (maintained)
├─ Error rate: < 0.5% (maintained)
├─ Concurrent users: 10,000+
├─ Database size: 10–50 GB
```

### 12.3 Scaling Strategies

**Horizontal Scaling (API Routes):**

```
Current (Vercel Hobby):
├─ Serverless functions auto-scale (0–100+ concurrent)
├─ No changes needed for typical load (< 1,000 req/min)

At higher scale (> 10,000 req/min):
├─ Evaluate: reserved concurrency (minimize cold start impact)
├─ Evaluate: origin shielding (CDN cache optimization)
└─ Fallback: migrate to Vercel Pro or dedicated infrastructure
```

**Vertical Scaling (Database):**

```
Current (Supabase Postgres on shared infrastructure):
├─ Sufficient for MVP (< 100 concurrent users)

At 1,000+ concurrent users:
├─ Upgrade to dedicated Postgres instance
├─ Increase max connections: 100 → 200
├─ Enable read replicas (optional): for analytics queries

At 10,000+ concurrent users:
├─ Evaluate: connection pooling service (PgBouncer)
├─ Evaluate: database sharding (partition ledger_entries by date)
├─ Monitor: slow query log, optimize indexes
```

**Caching Strategy:**

```
Redis cache (optional, Phase C3):
├─ Cache FX rates: 30-min TTL (already done via Wise)
├─ Cache user KYC status: 1-hour TTL
├─ Cache leaderboard data: 1-hour TTL
├─ Rate limiting: Redis for atomic counters (mandatory Phase C1.4)

Query optimization:
├─ Index on (user_id, created_at) for velocity lookups
├─ Index on (transfer_intent_id) for webhook routing
├─ Index on (provider, provider_event_id) for deduplication
├─ Partial indexes on processing transfers for efficient queue scans
```

**Monitoring Scaling (Phase C3):**

```
Metrics to track:
├─ Request latency percentiles (p50, p95, p99)
├─ Database query latency (slow query log)
├─ Connection pool utilization
├─ Memory usage per serverless function
├─ Cache hit ratio (if Redis enabled)
├─ API error rate trend

Alert thresholds:
├─ If P99 latency > 1s for 10 min: investigate & optimize
├─ If connection pool > 80%: scale up
├─ If slow queries > 1s: add index or refactor
```

---

## Part 13: Engineering Team & Hiring Roadmap

### 13.1 Current Team Structure (Q2 2026)

```
Engineering (1 person):
├─ Full-stack developer
└─ Responsible for: API routes, React components, database design, provider integrations

Support/Operations (0.5 person):
├─ Part-time (shared with other duties)
└─ Handles: user support, basic troubleshooting

Legal/Compliance (0.5 person):
├─ External consultant, part-time
└─ Responsible for: regulatory assessment, MSB licensing strategy
```

### 13.2 Hiring Plan for 2026–2027

**Phase C1–C2 (Q3 2026): 4 new hires**

```
Role 1: Senior Backend Engineer (1 FTE)
├─ Experience: 5+ years payments, fintech, or distributed systems
├─ Responsibilities: Settlement architecture, provider integrations, database design
├─ Start date: July 2026
├─ Critical for: Phase C1 balance reconciliation, Phase C4 live provider integration

Role 2: DevOps / Infrastructure Engineer (1 FTE)
├─ Experience: 3+ years AWS, Vercel, PostgreSQL, monitoring tools
├─ Responsibilities: Deployment automation, logging setup, alerting, disaster recovery testing
├─ Start date: August 2026
├─ Critical for: Phase C3 observability, production readiness

Role 3: QA / Test Engineer (0.5 FTE)
├─ Experience: 2+ years payments/fintech testing, automation, edge case identification
├─ Responsibilities: End-to-end test scenarios, provider integration testing, regulatory compliance testing
├─ Start date: September 2026
├─ Critical for: Phase C4 provider testing, Phase C5 go-live validation

Role 4: Compliance / AML Analyst (1 FTE)
├─ Experience: 3+ years AML/KYC, payments, or financial services compliance
├─ Responsibilities: AML rule development, transaction monitoring, SAR/CTR workflows
├─ Start date: August 2026
├─ Critical for: Phase C1.1 regulatory assessment, Phase C4 compliance audit
```

**Phase C3–C4 (Q4 2026): 2 additional hires**

```
Role 5: Junior Backend Engineer (1 FTE)
├─ Experience: 1–2 years, strong fundamentals, fintech interest
├─ Responsibilities: Helper role, admin dashboard development, operational tooling
├─ Start date: October 2026

Role 6: Product Manager / Operations Manager (1 FTE)
├─ Experience: 2+ years payments product, or operations
├─ Responsibilities: Feature prioritization, vendor management, customer communications
├─ Start date: November 2026
```

**Phase C5 (Q4 2026): 1–2 additional hires**

```
Role 7: On-Call Operations Engineer (1 FTE)
├─ Experience: 2+ years production operations, incident response
├─ Responsibilities: 24/7 on-call rotation, incident response, runbook execution
├─ Start date: December 2026

Role 8: Customer Success / Support Lead (0.5 FTE)
├─ Experience: 1+ years fintech customer support, regulatory customer interactions
├─ Responsibilities: Support team scaling, compliance customer interactions, escalations
├─ Start date: December 2026
```

**Total 2026–2027 Engineering Headcount:**
```
Q2 2026: 1 engineer
Q3 2026: 3 engineers (+ 1 compliance analyst)
Q4 2026: 5 engineers (+ 1 compliance analyst, 1 ops manager)
Q1 2027: 6–7 engineers (+ 1 compliance analyst, 1 ops manager)
```

### 13.3 Engineering Culture & Practices

**Code Review Standards:**
- All code changes require peer review before merge
- Focus: correctness, security, auditability
- Financial code (settlement, ledger) requires 2 approvals
- Admin/compliance code requires compliance analyst review

**Incident Post-Mortems:**
- Blameless: focus on process/system improvements, not individual blame
- Written report: root cause, contributing factors, action items
- Public: shared with team (some details redacted for security)
- Timely: within 48 hours of major incident

**Technical Debt Management:**
- Tracked in registry (see Part 14)
- Prioritized by risk and effort
- 10% of sprint capacity allocated to technical debt paydown
- Never deprioritized for full sprint (always some allocation)

**Documentation:**
- Architecture decisions recorded in ARCHITECTURE.md
- Runbooks for all manual operational procedures
- Weekly engineering sync (30 min): status, blockers, decisions
- Monthly CTO office hours (town hall): company updates, Q&A

---

## Part 14: Technical Debt Register

### 14.1 Existing Technical Debt

**High Priority (Must fix before Phase C5):**

| Item | Description | Impact | Effort | Deadline |
|------|-------------|--------|--------|----------|
| **No automated test suite** | Zero test coverage, manual testing only | Risk: regressions, missed edge cases | 120 hours | July 2026 |
| **No database transaction tests** | Settlement executor not tested in isolation | Risk: financial bugs | 40 hours | August 2026 |
| **Admin dashboard missing** | Operations requires database access | Risk: unsecure, non-auditable ops | 100 hours | September 2026 |
| **Plaid Transfer API unimplemented** | US transfers are sandbox only | Risk: cannot launch live | 80 hours | September 2026 |
| **Canadian provider TBD** | No Canadian provider selected | Risk: cannot serve CA users live | 60 hours | September 2026 |
| **Logging not structured** | Ad-hoc console.log throughout | Risk: unsearchable logs, ops blind | 40 hours | August 2026 |

**Medium Priority (Should fix in 2027):**

| Item | Description | Impact | Effort | Deadline |
|------|-------------|--------|--------|----------|
| **No metrics/observability** | Cannot see system health in real-time | Risk: slow incident response | 60 hours | October 2026 |
| **Rate limiting via Redis missing** | Vulnerable to brute force/DoS | Risk: availability, security | 20 hours | September 2026 |
| **KYC live integration incomplete** | Stripe verification not live | Risk: weak AML enforcement | 10 hours | August 2026 |
| **Provider abstraction incomplete** | PlaidTransferProvider is placeholder | Risk: provider swaps are complex | 40 hours | September 2026 |
| **Velocity limits not enforced** | Users can exceed limits | Risk: regulatory non-compliance | 15 hours | August 2026 |

**Low Priority (Can defer to 2027):**

| Item | Description | Impact | Effort | Deadline |
|------|-------------|--------|--------|----------|
| **Legacy balance column** | `balance` column from before dual-currency migration | Risk: code clarity | 5 hours | Q1 2027 |
| **Plaid token encryption parameterization** | Tokens encrypted but key distribution could be improved | Risk: key compromise | 8 hours | Q1 2027 |
| **Activity feed filter chips non-functional** | UI has filters but they don't work | Risk: feature incompleteness | 10 hours | Q1 2027 |
| **API response pagination missing** | Large result sets not paginated | Risk: slow API responses | 20 hours | Q2 2027 |
| **No GraphQL layer** | REST API only, GraphQL may help mobile clients | Risk: over-fetching | 40 hours | Post-2027 |

### 14.2 Debt Paydown Plan

```
Q3 2026 (Weeks 1–12):
├─ Week 1–2: Automated test framework setup (100 hours)
├─ Week 3–4: Database transaction tests (40 hours)
├─ Week 5–6: Settlement executor unit tests (30 hours)
├─ Week 7–8: Provider integration tests (30 hours)
├─ Week 9–10: Admin dashboard tests (20 hours)
├─ Week 11–12: E2E tests for critical paths (20 hours)
└─ Total: ~240 hours

Q4 2026 (Weeks 13–26):
├─ Ongoing: Structured logging implementation (40 hours)
├─ Ongoing: Observability/metrics (60 hours)
├─ Ongoing: Reduce technical debt per-sprint (10% capacity)
└─ Total: ~100 hours

2027 (Ongoing):
├─ 10% sprint capacity allocated to tech debt
├─ Prioritize by business impact
└─ Target: zero blocking tech debt, minimal medium-priority debt
```

---

## Part 15: 12-Month Engineering Roadmap (Q3 2026–Q2 2027)

### 15.1 Phase-by-Phase Execution

```
Q3 2026 — Validation & Hardening (Phase C1, Weeks 1–6)

Week 1–2:
├─ [Legal] MSB licensing assessment (blocking)
├─ [Backend] Balance reconciliation service (daily batch)
├─ [Backend] FX rate audit logging
├─ [Backend] Transfer timeout detection
├─ [DevOps] Observability infrastructure (logging, metrics groundwork)

Week 3–4:
├─ [Backend] Rate limiting (per-user, per-IP, per-endpoint)
├─ [Backend] Session timeout enforcement (24-hour JWT expiry)
├─ [Compliance] AML/KYC policy documentation
├─ [QA] Test scenarios for B3.2b settlement validation

Week 5–6:
├─ [Backend] Dead-letter queue for failed webhooks
├─ [Backend] Manual settlement override (admin endpoint)
├─ [Backend] Balance correction tool (with audit trail)
├─ [Legal] Regulatory risk assessment complete
├─ [Legal] Terms of service & privacy policy drafted
└─ **C1 Complete:** Regulatory assessed, balance reconciliation live, recovery mechanisms in place

Q3 2026 — Operations Console (Phase C2, Weeks 7–12)

Week 7–9:
├─ [Backend] User management API endpoints
├─ [Frontend] User lookup, detail, balance correction UI
├─ [Backend] Transfer search & detail APIs
├─ [Frontend] Transfer operations dashboard

Week 10–12:
├─ [Backend] Velocity management APIs
├─ [Frontend] Velocity override UI
├─ [Backend] Audit log queryable API
├─ [Documentation] Runbooks (stuck transfer, failed KYC, balance discrepancy, incident response)
├─ [Compliance] Operations team training
└─ **C2 Complete:** Admin dashboard deployed, ops team can work without DB access

Q4 2026 — Monitoring & Alerting (Phase C3, Weeks 13–18)

Week 13–14:
├─ [DevOps] Structured logging implementation (JSON format, correlation IDs)
├─ [DevOps] Log aggregation setup (Datadog / LogRocket)
├─ [Backend] Audit trail querying API

Week 15–16:
├─ [DevOps] Prometheus metrics instrumentation
├─ [DevOps] Grafana dashboard creation
├─ [Backend] Business metrics emission (transfers, revenue, KYC rate)

Week 17–18:
├─ [DevOps] PagerDuty / Opsgenie alerting rules
├─ [DevOps] Alert testing & escalation procedures
├─ [Ops] On-call rotation setup
└─ **C3 Complete:** Logging aggregated, metrics visible, alerting live

Q4 2026 — Live Provider Integration (Phase C4, Weeks 19–26)

Week 19–20:
├─ [Backend] Plaid Transfer API sandbox setup
├─ [Backend] PlaidTransferProvider implementation
├─ [QA] Provider sandbox validation (8 scenarios)
├─ [Compliance] Sanctions screening integration (OFAC)

Week 21–22:
├─ [Backend] Canadian EFT provider selection (RFP process)
├─ [Backend] Canadian provider SDK evaluation
├─ [QA] Provider testing & error scenario coverage

Week 23–24:
├─ [Backend] Plaid canary deployment (5% → 100% gradual rollout)
├─ [Backend] Canadian provider canary rollout
├─ [QA] Load testing with real provider APIs
├─ [Compliance] MSB licenses obtained (legal team)

Week 25–26:
├─ [Compliance] AML monitoring rules deployed
├─ [Compliance] Transaction monitoring active
├─ [Compliance] Compliance audit (third-party)
└─ **C4 Complete:** Live providers integrated, licenses obtained, AML active

Q4 2026 — Production Pilot (Phase C5, Weeks 27–28)

Week 27:
├─ [All] Go/no-go checklist (all C1–C4 criteria met)
├─ [Ops] Rollback procedure testing
├─ [Ops] Incident response playbook review
├─ [Backend] Internal team testing ($100 transfers, limited scope)

Week 28:
├─ [Backend] Gradual user onboarding begins
├─ Week 1: Internal team (10 users, $100 max)
├─ Week 2: Trusted testers (50 users, $1,000 max)
├─ [Ops] 24/7 on-call rotation activated
├─ [Ops] Daily reconciliation review
└─ **C5 Complete:** Real money transfers enabled for all users

Q1–Q2 2027 — Sustain & Scale

Week 29–39:
├─ Monitor live transactions 24/7
├─ Scale operations (customer support, ops team)
├─ Optimize based on live performance
├─ Expand to additional jurisdictions (planning)
├─ Velocity tier system (based on user history)
└─ Address any production issues, incidents
```

### 15.2 Milestone Summary

```
July 15, 2026 (Day 1):
├─ MSB licensing assessment complete
├─ C1 engineering work begins
├─ Team grows: Senior Backend + DevOps + QA + Compliance hires

September 15, 2026 (Day 60):
├─ Phase C1 complete: Regulatory path clear, balance reconciliation live
├─ Phase C2 work begins: Admin dashboard sprint

October 15, 2026 (Day 90):
├─ Phase C2 complete: Operations console deployed
├─ Phase C3 work begins: Monitoring & alerting

November 15, 2026 (Day 120):
├─ Phase C3 complete: Structured logging, metrics, alerting live
├─ Phase C4 work begins: Live provider integration

December 15, 2026 (Day 150):
├─ Phase C4 partial: Plaid Transfer API integrated & canary rollout 50%
├─ Canadian provider integration underway

January 15, 2027 (Day 180):
├─ Phase C4 complete: Both providers live at 100%, MSB licenses obtained
├─ Phase C5 work begins: Production pilot

February 15, 2027 (Day 210):
├─ Phase C5 complete: Real money transfers enabled
├─ Internal team: $100 transfers, live
├─ Trusted testers: $1,000 transfers, live

March 15, 2027 (Day 240):
├─ Public launch: $500/day limits for new users
├─ On-call team handling < 15-min incidents
├─ Daily reconciliation zero discrepancies
```

---

## Part 16: 24-Month Vision (2026–2027 Beyond)

### 16.1 Expansion Roadmap

**2026 (Foundation):**
- US + Canada launch complete
- Real money transfers live
- ~10,000 monthly active users
- ~$1M monthly transfer volume

**2027 (Expansion):**
- Expansion to UK, Mexico (regulatory analysis Q1)
- New provider integrations (UK: Faster Payments, Mexico: SPEI)
- Mobile app launch (native iOS/Android)
- Merchant API (for e-commerce integrations)
- Cryptocurrency on-ramp/off-ramp (pending regulatory clarity)

**2028+ (Vision):**
- Global coverage (20+ countries)
- $100M+ annual transaction volume
- B2B2C partnerships (embedded payments in other apps)
- Series B funding for international expansion

### 16.2 Feature Expansion

```
2027 Q1–Q2:
├─ Tiered velocity (increase daily limit based on age of account, KYC tier)
├─ Request money (formal request workflow, expiry)
├─ Group payments (split a transfer among multiple friends)
├─ Scheduled transfers (automatic recurring transfers)
├─ Savings buckets (separate balance pools within wallet)

2027 Q3–Q4:
├─ API webhooks for third-party integrations
├─ OAuth2 for partner apps
├─ Business accounts (different KYC/compliance rules)
├─ CSV export of transaction history
├─ Advanced search (transaction history filtering)

2028 Q1+:
├─ Lending products (borrow against balance)
├─ Crypto integration (buy/sell stablecoins)
├─ Investment products (stocks, ETFs)
├─ White-label offering (other companies brand Manna)
```

### 16.3 Business Metrics Targets

```
2026 (End):
├─ Users: 10,000 (sign-ups)
├─ Verified users: 3,000 (KYC completed)
├─ Monthly active users: 5,000
├─ Monthly transaction volume: $1M
├─ Average transaction size: $200
├─ Conversion rate (signup → first transfer): 30%

2027 (End):
├─ Users: 100,000
├─ Verified users: 50,000
├─ Monthly active users: 40,000
├─ Monthly transaction volume: $50M
├─ Average transaction size: $250
├─ Conversion rate: 40%

2028 (Target):
├─ Users: 500,000+
├─ Verified users: 300,000+
├─ Monthly active users: 200,000+
├─ Monthly transaction volume: $500M+
├─ Average transaction size: $300+
```

---

## Part 17: Production Readiness Framework (C1–C5)

**Executive Summary Table:**

| Phase | Timeline | Effort | Outcome | Go-Live Blocker |
|-------|----------|--------|---------|-----------------|
| **C1: Validation & Hardening** | Weeks 1–6 | 380 hours | Balance reconciliation, MSB path clear, recovery mechanisms | Financial correctness verified |
| **C2: Operations Console** | Weeks 7–12 | 180 hours | Admin dashboard, ops team trained | Operational safety demonstrated |
| **C3: Monitoring & Alerting** | Weeks 13–18 | 160 hours | Structured logging, real-time alerting | System observability confirmed |
| **C4: Live Provider Integration** | Weeks 19–26 | 200+ hours | Live Plaid, Canadian EFT, MSB licenses | Regulatory compliance verified |
| **C5: Production Pilot** | Weeks 27–28 | 40 hours | Real money transfers, gradual onboarding | User operations proven safe |
| **Total** | **28 weeks** | **960+ hours** | **Production-safe platform** | **Zero unmitigated risks** |

**Risk-Based Sequencing:**
- C1 first: Validates financial correctness (highest risk)
- C2 second: Validates operational safety (execution risk)
- C3 third: Validates observability (detection risk)
- C4 fourth: Integrates providers (provider risk)
- C5 fifth: Enables live money (user/regulatory risk)

Each phase has clear exit criteria and blockers. No phase advances until prior phase achieves "complete" status.

---

## Part 18: Engineering Governance & Decision Making

### 18.1 Architecture Review Process

**Architecture Decision Records (ADRs):**

All significant technical decisions are documented in `docs/adr/` directory.

**ADR Template:**
```
# ADR-001: Settlement State Machine Design

## Status: Accepted

## Context:
Transfer settlement must be idempotent despite network failures and retries.

## Decision:
Implement 3-phase settlement (B3.1 status, B3.2a ledger, B3.2b balance) with 
dual idempotency (UNIQUE constraint + balance_processed_at).

## Rationale:
- Prevents duplicate balance mutations
- Preserves auditability (each phase separately observable)
- Enables recovery (phase can be replayed if prior steps succeeded)

## Consequences:
- Added complexity (3 separate transactions instead of 1)
- Increased database load (3 updates per settlement)
- Benefit: Financial correctness guaranteed, zero balance discrepancies

## Alternatives Considered:
- Single atomic transaction: Simple but loses auditability & recovery granularity
- Saga pattern with coordinator: Overkill for this use case

## Related:
- B3.2b_CODE_REVIEW_REPORT.md (implementation details)
- Settlement executor tests (validation)
```

**Decision-Making Process:**

1. **Proposal phase:** Engineer documents proposal (problem, options, recommendation)
2. **Review phase:** Senior engineers comment (CTO breaks ties)
3. **Decision phase:** Clear decision documented in ADR
4. **Implementation phase:** Code review ensures alignment with ADR
5. **Retrospective phase:** Quarterly review of decisions; if outcome differs, update ADR with learnings

### 18.2 Code Review Checklist (Financial Code)

All changes to settlement, ledger, or balance logic require peer review + compliance review:

**Peer Review (Backend Engineer):**
- [ ] Logic is correct (does it match the ADR/design?)
- [ ] Tests pass (unit + integration)
- [ ] Error handling is comprehensive
- [ ] SQL injection prevention (parameterized queries)
- [ ] Race conditions eliminated (atomic operations)
- [ ] Backward compatibility (can old data be read?)
- [ ] Performance (no O(n) queries, proper indexes)
- [ ] Documentation (updated runbooks if operational impact)

**Compliance Review (Compliance Analyst):**
- [ ] AML/KYC impact assessed
- [ ] Audit trail complete (all actions logged)
- [ ] Regulatory impact analyzed
- [ ] Velocity limits respected
- [ ] No silent data modification
- [ ] Reversibility verified (can balance be corrected manually?)

### 18.3 Release Process

**Release cadence:** Weekly (on Wednesdays) or on-demand for hot fixes.

**Release checklist:**

```
1 week before release:
├─ Feature lock: no new features, only bug fixes
├─ Code review: all changes reviewed + approved
├─ Test execution: E2E tests pass on staging
└─ Compliance review: compliance changes reviewed

Day of release:
├─ Pre-release: backup production database
├─ Deploy: `git push origin master` → Vercel auto-deploys
├─ Post-release smoke tests: key flows (send, receive, KYC) work
├─ Rollback ready: previous deployment easy to promote
└─ Announce: #releases Slack channel

4 hours post-release:
├─ Monitor: check error rate, latency, logs
├─ Contact stakeholders: no issues found, release stable
└─ Update status page: all systems operational

24 hours post-release:
├─ Final checks: reconciliation passed, no anomalies
└─ Close release ticket
```

**Rollback process:**

If critical issue found within 24 hours of release:
```
1. Alert ops team + CTO
2. Identify root cause (if obvious)
3. Promote previous working deployment in Vercel
4. Test critical flows on rollback version
5. Announce rollback to users (if user-facing)
6. Post-mortem: what went wrong, how to prevent
7. Implement fix on master branch
8. Re-release when ready
```

### 18.4 On-Call Rotation (Phase C5+)

**On-call engineer responsibilities:**

- Primary responder to SEV-1/2/3 alerts (24/7 during assigned week)
- Resolves issues using runbooks (or escalates if unclear)
- Documents incident in Jira/GitHub Issues
- Participates in post-mortem within 48 hours

**Escalation policy:**

```
SEV-1 (API error > 5%, DB down):
├─ Page on-call engineer (immediate)
├─ If not acknowledged after 5 min: escalate to manager
├─ If not resolved after 30 min: escalate to VP Eng
└─ All hands may be pulled into incident bridge

SEV-2 (Error rate > 1%, P99 latency > 2s):
├─ Page on-call engineer (within 15 min)
├─ If not resolved after 1 hour: escalate to manager
└─ Manager decides if engineer needs help

SEV-3 (Balance reconciliation discrepancy):
├─ No page (next morning)
├─ Manual investigation by ops/compliance
└─ Fix deployed during business hours
```

---

## Part 19: Appendices

### A. Technical Glossary

**Atomic Operation:** Database operation that is indivisible (either fully completes or fully rolls back). No partial execution.

**Idempotent:** Operation that produces same result whether executed once or multiple times. Retries are safe.

**Ledger Entry:** Immutable record of financial action (debit/credit pair). Source of truth for balance.

**MSB:** Money Services Business. Legal classification for companies that transmit money.

**KYC:** Know Your Customer. Verification process to confirm identity and prevent fraud.

**AML:** Anti-Money Laundering. Compliance monitoring to prevent illicit financial activity.

**Velocity Limit:** Maximum amount user can transfer per day/month. Reduces fraud/compliance risk.

**Provider Reference ID:** Unique identifier assigned by payment provider (e.g., Plaid transfer_id) to track transfer at provider.

**Settlement:** When provider confirms transfer succeeded (money moved, balance change is permanent).

**Webhook:** Asynchronous notification from provider to Manna (e.g., "Transfer T123 settled").

**Canary Deployment:** Gradual rollout to small % of users before full deployment.

### B. Security Checklists

**Pre-Production Security Audit:**

- [ ] HTTPS enforced (no HTTP fallback)
- [ ] TLS 1.3 minimum version
- [ ] HSTS header set (> 1 year)
- [ ] XSS prevention (input validation, output escaping)
- [ ] CSRF tokens on state-changing requests
- [ ] Rate limiting deployed (per-user, per-IP, per-endpoint)
- [ ] Admin API: IP whitelist + MFA
- [ ] Database credentials: environment variables only (never in code)
- [ ] API keys: rotated every 180 days
- [ ] JWT secrets: 256-bit minimum
- [ ] Password hashing: bcrypt 12+ rounds
- [ ] Sensitive data: encrypted at rest (AES-256)
- [ ] SQL injection: parameterized queries throughout
- [ ] Dependency vulnerabilities: zero high-severity (npm audit)
- [ ] Third-party security: vendor SOC 2 / ISO 27001 compliance verified

**Post-Launch Monitoring:**

- [ ] Monthly security updates (npm, system packages)
- [ ] Quarterly code security audit (manual review)
- [ ] Quarterly penetration test (third-party)
- [ ] Incident response drills (quarterly)
- [ ] Regulatory compliance audit (annual)

### C. Sample Runbook: Resolve Stuck Transfer

**Incident:** User reports transfer created 8 days ago still in "processing" state.

**Diagnosis (5 min):**

```bash
# Step 1: Find the transfer
curl -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.example.com/api/admin/transfers?search=user_email

# Step 2: Check current status
curl -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.example.com/api/admin/transfers/T123

# Expected response:
{
  "id": "T123",
  "status": "processing",
  "created_at": "2026-06-20T10:00:00Z",
  "provider": "plaid",
  "provider_reference_id": "pltf_T123"
}

# Step 3: Check webhook history
curl -H "Authorization: Bearer $ADMIN_JWT" \
  https://api.example.com/api/admin/transfers/T123/webhooks

# Expected: no settled/failed/returned event found

# Step 4: Check provider status via API
curl -H "Authorization: Bearer $PLAID_API_KEY" \
  https://sandbox.plaid.com/transfers/get?client_id=...&access_token=...&transfer_id=pltf_T123

# Possible responses:
# - "status": "settled" → Provider says settled, but we didn't receive webhook
# - "status": "failed" → Provider says failed, but we didn't receive webhook
# - "status": "processing" → Legitimate hang, check provider status page
# - Error: provider has no record → Lost in transmission
```

**Resolution (10–30 min):**

**Case 1: Provider says settled, but webhook lost**

```
Action:
1. Manually trigger settlement executor with provider webhook replay
2. Check that balance is now updated
3. Send user notification: "Your transfer settled successfully"
4. Create audit log entry: "Manual webhook replay for T123"
5. Investigate: why didn't provider webhook arrive? (Plaid status page? Vercel downtime?)
6. File incident ticket: "Webhook delivery failure on 2026-06-20"
```

**Case 2: Provider says failed**

```
Action:
1. Mark transfer as failed in admin dashboard
2. Reverse any partial balance mutations (if any)
3. Notify user: "Your transfer failed (provider reason); funds returned to wallet"
4. Create audit log entry: "Transfer T123 failed per provider; refund initiated"
5. Investigate: why did transfer fail? Insufficient funds? Bad account? Velocity limit?
6. Offer user option to retry
```

**Case 3: Provider processing (legitimate hang)**

```
Action:
1. Check Plaid status page (https://status.plaid.com/)
2. If Plaid operational: transfer may be legitimately slow (ACH can take 1–3 business days)
3. Notify user: "Your transfer is still processing. ACH typically takes 1–3 business days."
4. Set reminder to check again tomorrow
5. If transfer not settled by day 10: escalate to Plaid support
```

**Case 4: Provider has no record**

```
Action:
1. Transfer lost in transmission (never reached provider)
2. Can safely cancel: no balance change occurred, no provider record
3. UPDATE transfer_intents SET status = 'cancelled' WHERE id = 'T123'
4. Notify user: "Transfer cancelled (lost before reaching bank); no charge"
5. Offer user option to retry immediately
6. File incident ticket: "Lost transfer (provider has no record)"
7. Investigate Vercel logs from transfer time (was API call made to Plaid?)
```

**Post-Resolution:**

- [ ] Confirm balance is correct (matches ledger sum)
- [ ] User has been notified
- [ ] Audit log shows all actions
- [ ] Incident ticket created (for post-mortem)
- [ ] Mark ticket as resolved

### D. Architecture Diagrams

**Data Flow: Transfer Settlement**

```
User clicks "Send $100 CAD"
        │
        ▼
POST /api/transfers/intent
  ├─ Validate: sender balance, recipient exists, KYC status, velocity
  ├─ Call provider.createTransferIntent() → provider_reference_id
  └─ INSERT transfer_intents (status='draft')

        │
        ▼
User reviews & confirms consent

        │
        ▼
POST /api/transfers/{id}/confirm
  └─ UPDATE transfer_intents SET status='ready'

        │
        ▼
[Provider processes transfer (ACH, EFT, etc.)]

        │
        ▼
Provider webhook: "Transfer settled"

        │
        ▼
POST /api/webhooks/plaid
  ├─ Dedup: INSERT provider_webhook_events (if not duplicate)
  ├─ Orchestrate: SettlementOrchestrator.planSettlement() → no side effects
  ├─ Execute:
  │  ├─ B3.1: UPDATE transfer_intents SET status='settled'
  │  ├─ B3.2a: INSERT ledger_entries (debit sender, credit recipient)
  │  ├─ B3.2b: UPDATE users SET balance_cad = balance_cad ± amount
  │  └─ B3.3: INSERT notifications, UPDATE velocity_checks
  └─ Return 200

        │
        ▼
User sees notification: "Transfer settled"
Balance updated: sender −$100, recipient +$100
```

**Database Schema (Simplified)**

```
users
├─ id (UUID, PK)
├─ email (unique)
├─ password_hash (bcrypt)
├─ country ('CA' or 'US')
├─ balance_cad (NUMERIC(12,2))
├─ balance_usd (NUMERIC(12,2))
├─ kyc_status ('pending', 'verified', 'rejected')
└─ created_at

transfer_intents
├─ id (UUID, PK)
├─ sender_id (FK → users)
├─ recipient_id (FK → users)
├─ amount (NUMERIC(12,2))
├─ currency ('CAD', 'USD')
├─ status ('draft', 'ready', 'processing', 'settled', 'failed', 'returned')
├─ provider_reference_id (from provider)
├─ provider ('plaid', 'eft', 'sandbox_us', 'sandbox_ca')
├─ created_at
└─ settled_at (nullable)

ledger_entries
├─ id (UUID, PK)
├─ user_id (FK → users)
├─ amount (NUMERIC(12,2), positive)
├─ currency ('CAD', 'USD')
├─ entry_type ('debit', 'credit')
├─ transfer_intent_id (nullable, FK)
├─ description
└─ created_at (immutable)

provider_webhook_events
├─ id (UUID, PK)
├─ provider ('plaid', 'eft', etc.)
├─ provider_event_id (unique per provider)
├─ event_type ('settled', 'failed', 'returned')
├─ related_provider_reference (links to transfer_intents)
├─ balance_processed_at (nullable, set after B3.2b)
├─ balance_processing_error (nullable, error reason if B3.2b failed)
├─ received_at
└─ UNIQUE(provider, provider_event_id) [deduplication]

audit_logs
├─ id (UUID, PK)
├─ user_id (FK, nullable)
├─ admin_id (FK, nullable)
├─ action ('transfer_created', 'kyc_approved', 'balance_corrected', etc.)
├─ entity_type ('user', 'transfer', 'ledger', etc.)
├─ entity_id
├─ change_summary (JSON: {from, to})
├─ reason (nullable)
└─ created_at (immutable)
```

---

## Conclusion

This technical strategy articulates Manna's path from a validated prototype to a production-grade payments platform. The strategy is risk-based, phased, and executable within 12 weeks with the right team and resources.

**Key Success Factors:**

1. **Financial Correctness First:** Every design decision prioritizes balance accuracy over feature richness.
2. **Regulatory Alignment:** Compliance is not an afterthought; it is engineered in from day one.
3. **Operational Transparency:** All actions are auditable, observable, and reversible.
4. **Modular Architecture:** Provider abstractions, settlement phases, and KYC/AML integrations are pluggable.
5. **Team & Culture:** Hiring experienced engineers, establishing clear decision-making processes, and fostering blameless incident response.

**Next Steps (Week of June 28, 2026):**

1. Approve this strategy with board/leadership
2. Initiate MSB licensing applications (legal team)
3. Hire: Senior Backend Engineer, DevOps Engineer, QA Engineer, Compliance Analyst
4. Begin Phase C1 engineering work (balance reconciliation, rate limiting, recovery mechanisms)
5. Establish on-call rotation and incident response culture

The roadmap is ambitious but achievable. Execution excellence on Phase C1–C5 will position Manna for Series A funding and sustained growth as a trusted cross-border payment platform.

---

**Document Prepared By:** Principal Payments Platform Architect  
**Date:** June 28, 2026  
**Classification:** Technical Strategy — Confidential  
**Next Review:** September 15, 2026 (after Phase C1 completion)
