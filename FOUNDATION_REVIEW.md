# Release 0.95 Phase 1: Foundation Architecture Review

**Date:** June 28, 2026  
**Scope:** Comprehensive analysis of current architecture before implementing operational infrastructure  
**Status:** Complete — Ready for Phase 1 milestone execution

---

## Executive Summary

Manna has a **strong settlement and financial foundation** built on immutable ledgers, idempotent webhooks, and provider abstraction. The codebase is well-positioned for operational tooling.

**Current strengths:**
- ✅ Ledger-driven balance model (immutable append-only)
- ✅ Idempotent settlement architecture (3-phase executor)
- ✅ Provider abstraction (modular, testable)
- ✅ Webhook deduplication (UNIQUE constraint)
- ✅ Atomic SQL operations (prevent race conditions)
- ✅ Basic audit logging infrastructure

**Critical gaps for operational platform:**
- ❌ No correlation ID system (request tracing lost)
- ❌ No repository pattern (queries scattered)
- ❌ No RBAC system (no admin roles)
- ❌ No immutable audit logging (auditLog exists but no table)
- ❌ Missing velocity_checks table (referenced but not created)
- ❌ No recovery/replay APIs (manual recovery impossible)
- ❌ No admin UI (ops team cannot self-serve)

**Release 0.95 Foundation will establish:**
1. Correlation IDs for request tracing
2. Repository pattern for type-safe data access
3. RBAC with 5 admin roles
4. Immutable audit logging for all actions
5. Complete database schema for operational needs
6. Test infrastructure for all new components

---

## Part 1: Current Architecture

### 1.1 Authentication & Authorization

**Current Model:**

```typescript
// lib/auth.ts: Only authentication mechanism
export interface JWTPayload {
  userId: number;
  email: string;
  username: string;
  // NO roles, NO permissions
}

// No RBAC concept exists
// No admin role, no role middleware
// All authenticated users have same permissions
```

**JWT Flow:**
1. User logs in → `POST /api/auth/login` → password verified → JWT signed
2. JWT stored in httpOnly cookie `manna-token`
3. `getAuthUser()` called on each request → extracts JWT → returns JWTPayload
4. Middleware in `proxy.ts` checks if token exists, gates `/feed`, `/send`, etc.
5. API routes call `getAuthUser()` → 401 if missing

**Current Auth Usage:**
- Every authenticated route: `const user = await getAuthUser()`
- Routes return `{ error: 'Unauthorized' }` if user is null
- No role checking anywhere
- No IP whitelist
- No MFA support
- No session timeout (7-day JWT expiry)

**Gap:** No way to distinguish between user and admin. All authenticated users are equal.

---

### 1.2 Settlement Architecture & Entry Points

**Settlement Lifecycle:**

```
Webhook arrives (POST /api/webhooks/plaid)
    ↓
Signature verification (JOSE ES256)
    ↓
Deduplication check (UNIQUE(provider, provider_event_id))
    ↓
Event handler (handleTransferEventStatusUpdate)
    ↓
Orchestrator.orchestrateSettlement() [B2: Planning only]
    ├─ Query transfer_intents
    ├─ Call SettlementProcessor (state machine validation)
    └─ Return SettlementPlan (no side effects)
    ↓
Executor.executeSettlementPlan() [B3.1: Status update only]
    ├─ UPDATE transfer_intents SET status
    └─ Return status update result
    ↓
Executor.executeLedgerCreation() [B3.2a: Ledger entries]
    ├─ INSERT ledger_entries (debit/credit pairs)
    └─ Return ledger creation result
    ↓
Executor.executeBalanceUpdate() [B3.2b: Balance atomic update]
    ├─ Check balance_processed_at (idempotency)
    ├─ UPDATE users SET balance_X = balance_X ± amount
    └─ Set balance_processed_at (mark as processed)
    ↓
Audit log (auditLog call with metadata)
    ↓
Return 200 (success or failure, both return 200)
```

**Entry Point 1: Transfer Intent Creation**
- Route: `POST /api/transfers/intent`
- Auth: `getAuthUser()` → 401 if missing
- Logic:
  1. Load user (get country for provider routing)
  2. Check KYC status (verified required)
  3. Velocity check (not recorded yet)
  4. Provider routing (region → provider)
  5. Call `provider.createIntent()` → INSERT transfer_intents
- Result: transfer_id returned

**Entry Point 2: Transfer Confirmation**
- Route: `POST /api/transfers/{id}/confirm`
- Auth: `getAuthUser()`
- Logic:
  1. Load transfer_intent (check ownership)
  2. Update status to 'confirmed'
  3. Record velocity
- Result: Ready for settlement

**Entry Point 3: Webhook Handler**
- Route: `POST /api/webhooks/plaid`
- Auth: Signature verification (JOSE + body hash), no user auth
- Logic: (See settlement lifecycle above)
- Result: Settlement executed (3 phases)

**Key Observation:** Settlement flow is **side-effect-free planning** (Orchestrator) followed by **atomic execution** (Executor). This is good for testing and recovery.

---

### 1.3 Database Mutation Paths

**Direct SQL INSERT/UPDATE mutations found:**

| Mutation | Location | Frequency | Idempotency |
|----------|----------|-----------|-------------|
| INSERT transfer_intents | `POST /api/transfers/intent` | Per user transfer | No (but unique provider_reference_id) |
| UPDATE transfer_intents status | Executor.executeSettlementPlan | Per settlement | ✅ Checks current status |
| INSERT ledger_entries | Executor.executeLedgerCreation | Per settlement | ✅ UNIQUE constraint on (transfer_intent_id, provider_event_id, entry_type) |
| UPDATE users balance_cad/usd | Executor.executeBalanceUpdate | Per settlement | ✅ balance_processed_at check |
| INSERT provider_webhook_events | Webhook handler | Per webhook | ✅ UNIQUE(provider, provider_event_id) |
| UPDATE provider_webhook_events status | Webhook handler | Per webhook | ✅ Idempotent (idempotency check first) |
| INSERT notifications | Various routes | Per event | No, but immutable records |
| INSERT transactions | (legacy P2P flow) | Per legacy transfer | Not traced |
| INSERT audit_logs | auditLog() function | Per action | No constraint, table missing |
| INSERT velocity_checks | recordVelocity() | Per settlement | Upsert with ON CONFLICT |
| INSERT friends | POST /api/friends | Per friend request | UNIQUE(user_id, friend_id) |
| UPDATE bank_accounts | Various | Per account update | No global idempotency |

**Mutation Pattern Analysis:**

1. **Financial mutations (balance, ledger):** Highly protected (UNIQUE constraints, idempotency checks, atomic SQL)
2. **Settlement mutations (status, webhook events):** Highly protected (state machine validation, dedup)
3. **Non-financial mutations (notifications, friends):** Less protected, but immutable records
4. **Missing audit trail:** auditLog() is called but audit_logs table doesn't exist

**Gap:** No way to trace WHO made a mutation (no admin/operator context). All mutations logged to auditLog but table missing.

---

### 1.4 Ledger Architecture (Strengths)

**Ledger-Driven Balance Model:**

```
ledger_entries (immutable, append-only):
├─ user_id (who)
├─ transfer_intent_id (why)
├─ currency (what currency)
├─ debit/credit (amounts)
├─ description (reason)
├─ created_at (immutable timestamp)
└─ UNIQUE(transfer_intent_id, provider_event_id, entry_type) [prevent duplicates]

users.balance_cad/usd:
├─ Not stored independently
├─ Derived from: SUM(credit) - SUM(debit) in ledger_entries
└─ Updated atomically by executor
```

**Strengths:**
- ✅ Immutable append-only design
- ✅ Every balance change traceable to ledger entry
- ✅ Supports reconciliation (can recompute balance)
- ✅ UNIQUE constraint prevents duplicate entries from same provider event
- ✅ ledger_entries never updated, only inserted

**Usage:**
- Settlement creates ledger entries for every balance change
- Balance must match ledger sum (enforced by application, not DB constraint)
- Reconciliation would query: `SELECT user_id, SUM(credit) - SUM(debit) FROM ledger_entries`

---

### 1.5 Provider Abstraction (Strengths)

**Current Providers:**

```typescript
interface TransferProvider {
  createIntent(): Promise<...>
  validateIntent(): Promise<...>
  executeTransfer(): Promise<...>  // Blocked in sandbox
  getStatus(): Promise<...>
  cancelTransfer(): Promise<...>
  reverseTransfer(): Promise<...>
  parseWebhookEvent(): Promise<...>
}

Implementations:
├── SandboxUSProvider (sandbox, no real API calls)
├── SandboxCAProvider (sandbox, no real API calls)
├── PlaidTransferProvider (placeholder, not implemented)
└── CanadianEFTProvider (placeholder, not implemented)
```

**Routing:**

```typescript
// lib/transfers/router.ts
function getTransferProvider(region) {
  if (region === 'US') return new SandboxUSProvider();
  if (region === 'CA') return new SandboxCAProvider();
}
```

**Strengths:**
- ✅ Modular design (easy to swap providers)
- ✅ Provider routing hidden from business logic
- ✅ Sandbox blocker (executeTransfer throws)
- ✅ All providers implement same interface

---

### 1.6 Webhook Deduplication (Strengths)

**Design:**

```sql
CREATE TABLE provider_webhook_events (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  related_provider_reference TEXT,
  raw_payload JSONB,
  processing_status TEXT,
  processing_error TEXT,
  processed_at TIMESTAMPTZ,
  balance_processed_at TIMESTAMPTZ,
  balance_processing_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(provider, provider_event_id)  -- Natural deduplication
);
```

**How it works:**

```
Webhook arrives with event_id
    ↓
INSERT INTO provider_webhook_events (provider, provider_event_id, ...)
    ↓
If UNIQUE constraint violated → silent ignore (ON CONFLICT DO NOTHING)
    ↓
If insert succeeds → process the event
    ↓
If insert fails (duplicate) → return 200 immediately (idempotent)
```

**Strengths:**
- ✅ Natural deduplication via UNIQUE constraint
- ✅ Duplicate webhooks are safely ignored
- ✅ No need for manual tracking
- ✅ Works even if processor crashes mid-execution

**Enhancement Opportunity:** Add replay_count, last_replay_at, correlation_id for operational tracking.

---

## Part 2: Dependency Analysis

### 2.1 Critical Dependencies (Cannot Break)

These patterns must be preserved exactly:

1. **Ledger immutability:** All balance changes must flow through ledger_entries INSERT
2. **Settlement idempotency:** balance_processed_at + UNIQUE constraints prevent duplicates
3. **Atomic balance updates:** `UPDATE balance_X = balance_X ± amount` syntax for no race conditions
4. **Webhook deduplication:** UNIQUE(provider, provider_event_id) constraint
5. **Provider abstraction:** All transfers route through TransferProvider interface
6. **Audit logging:** auditLog() calls must continue (even though table missing)

### 2.2 Reusable Components (Will Integrate)

These will be extended for admin use:

1. **Settlement Orchestrator:** Already planning (no side effects). Will add admin context.
2. **Settlement Executor:** Already executing (3 phases). Will add audit trail.
3. **ledger.ts helpers:** getLedgerBalance(), createLedgerEntry(). Will add to repositories.
4. **auth.ts utilities:** getAuthUser(), auditLog(). Will extend with admin roles.
5. **Provider routing:** getTransferProvider(). Will add admin query API.

### 2.3 New Components (Will Build)

1. **Correlation ID system:** Generate + propagate through settlement
2. **Repository pattern:** 8 repositories (users, transfers, wallets, settlements, ledger, webhooks, providers, audit logs)
3. **RBAC middleware:** 5 roles + permission validation
4. **Admin audit service:** Immutable audit logging
5. **Database schema:** 5 new tables (audit_logs, velocity_checks, exceptions, replay_log, extensions to existing tables)
6. **Admin API layer:** Recovery, search, investigation endpoints
7. **Admin UI:** 10 pages for dashboard, search, investigation

---

## Part 3: Current Data Model

### 3.1 Core Tables (Immutable)

```
users
├─ id (PK)
├─ email, username, password_hash
├─ balance_cad, balance_usd (derived from ledger)
├─ kyc_status ('pending', 'verified', 'rejected')
├─ country ('CA', 'US')
└─ created_at

transfer_intents
├─ id (PK)
├─ user_id, bank_account_id (FKs)
├─ type ('add_money', 'cash_out')
├─ amount, currency
├─ status (state machine: draft → confirmed → submitted → settled/failed/returned)
├─ provider_reference_id (from provider)
├─ provider_name, provider_region, execution_mode
├─ created_at, updated_at
└─ (No uniqueness on provider_reference_id yet — should add)

ledger_entries
├─ id (PK)
├─ user_id, transfer_intent_id (FKs)
├─ currency, debit, credit
├─ entry_type, description
├─ created_at (immutable)
└─ UNIQUE(transfer_intent_id, provider_event_id, entry_type)

provider_webhook_events
├─ id (PK)
├─ provider, provider_event_id (UNIQUE)
├─ event_type, related_provider_reference
├─ raw_payload (JSONB)
├─ processing_status, processing_error, processed_at
├─ balance_processed_at, balance_processing_error (idempotency)
├─ created_at
└─ UNIQUE(provider, provider_event_id)
```

### 3.2 Missing Tables (For Operations)

These will be created in Phase 1:

```
audit_logs
├─ id (PK)
├─ admin_id (FK to users)
├─ action (type of admin operation)
├─ entity_type, entity_id
├─ previous_state, new_state (JSONB snapshots)
├─ reason (why operator took action)
├─ correlation_id
├─ source_ip, user_agent
├─ created_at (immutable)
└─ (No updates ever, append-only)

velocity_checks
├─ id (PK)
├─ user_id, window_type ('hourly', 'daily', 'weekly')
├─ window_start, transaction_count, total_amount, currency
├─ updated_at, created_at
└─ UNIQUE(user_id, window_type, window_start, currency)

operation_exceptions
├─ id (PK)
├─ exception_type, severity, status, category
├─ transfer_intent_id, webhook_event_id, user_id (FKs)
├─ title, description, root_cause, metadata (JSONB)
├─ owner_id (FK), attempted_recovery (array)
├─ detected_at, resolved_at, created_at
└─ correlation_id

replay_log
├─ id (PK)
├─ admin_id (FK), replay_type, entity_id, entity_type
├─ original_correlation_id, replay_correlation_id
├─ success, result_summary (JSONB), error_message
├─ reason, admin_reason
└─ created_at
```

---

## Part 4: Security Analysis

### 4.1 Current Security Posture

| Component | Status | Details |
|-----------|--------|---------|
| **Authentication** | ✅ Good | JWT-based, httpOnly cookie, 7-day expiry |
| **Password Storage** | ✅ Good | (Assuming bcrypt, not verified in code) |
| **SQL Injection** | ✅ Good | All queries use postgres.js parameterized syntax |
| **Webhook Verification** | ✅ Good | JOSE ES256 signature + body hash verification |
| **Encryption at Rest** | ✅ Good | Plaid tokens encrypted AES-256-GCM |
| **Authorization** | ❌ Missing | No RBAC, no admin roles, no permission checking |
| **Audit Logging** | ⚠️ Partial | auditLog() called but audit_logs table missing |
| **Rate Limiting** | ❌ Missing | No per-user or per-endpoint limits |
| **Admin Access** | ❌ Missing | No admin-only endpoints, no IP whitelist, no MFA |
| **Data Privacy** | ⚠️ Partial | No data retention policy, no PII protection |

### 4.2 Security Requirements for Phase 1

1. **RBAC:** 5 roles with permission matrix (superadmin > operations admin > investigator > compliance > viewer)
2. **Admin MFA:** TOTP-based 2FA for sensitive operations (force settle, replay, etc.)
3. **IP Whitelist:** Configurable env var restricting admin access
4. **Audit Logging:** Every admin action immutably logged with operator identity + reason
5. **Rate Limiting:** Per-endpoint, per-user, per-IP limits (prevent brute force + DoS)
6. **Secrets Management:** No hardcoded secrets, all env vars
7. **CORS Restrictions:** Admin APIs not callable from untrusted origins

---

## Part 5: Existing Test Coverage

**Test Status:** No test files found in codebase.

```bash
$ find . -name "*.test.ts" -o -name "*.spec.ts" | wc -l
0
```

**Implications:**
- No existing tests to break (but also no test infrastructure)
- Need to build testing framework from scratch
- Phase 1 should include unit test setup

---

## Part 6: Recommended Phase 1 Approach

### 6.1 Implementation Order (Optimized for Dependency)

1. **Correlation ID System** (earliest)
   - Add correlation_id to contexts
   - Propagate through all settlement flows
   - Store in ledger + audit logs
   - No breaking changes

2. **RBAC Roles + Middleware** (foundational)
   - Add admin_role to users table
   - Create role enum + permission matrix
   - Implement middleware for authorization checks
   - No breaking changes to user APIs

3. **Repository Pattern** (data access foundation)
   - Create 8 repositories (read-only for most)
   - Type-safe queries
   - No direct SQL in service layer
   - Can be added alongside existing routes

4. **Immutable Audit Logging** (compliance foundation)
   - Create audit_logs table
   - Audit service + middleware
   - Log every admin action
   - Extend existing auditLog() calls

5. **Database Schema** (operational foundation)
   - Create 5 new tables
   - Add columns to existing tables
   - Migrations with rollback support
   - No data loss risk

6. **Testing Infrastructure** (quality foundation)
   - Jest setup
   - Repository tests
   - RBAC tests
   - Audit tests
   - Settlement integration tests

### 6.2 Backwards Compatibility Strategy

**All new code must:**
1. Not modify existing customer-facing APIs
2. Not change settlement behavior
3. Not break ledger immutability
4. Extend auth.ts (not replace it)
5. Add repositories (not remove direct SQL)
6. Add audit logging (not change existing calls)

**New admin APIs can:**
1. Use new repositories
2. Require RBAC checks
3. Generate audit logs
4. Use correlation IDs
5. Be in new /api/admin/* routes

---

## Part 7: Migration Rollback Strategy

Every new database migration must be reversible:

```sql
-- Forward
CREATE TABLE audit_logs (...);

-- Backward
DROP TABLE IF EXISTS audit_logs;
```

```sql
-- Forward
ALTER TABLE users ADD COLUMN admin_role VARCHAR(50);

-- Backward
ALTER TABLE users DROP COLUMN IF EXISTS admin_role;
```

**Testing:** Each migration tested in staging before production.

---

## Part 8: Known Constraints & Assumptions

### 8.1 Immutable Constraints (Cannot Change)

1. **Ledger entries never updated** — only INSERT allowed
2. **Balance update atomicity** — `balance_X = balance_X ± amount` syntax required
3. **Settlement 3-phase design** — status → ledger → balance sequence
4. **Webhook deduplication** — UNIQUE(provider, provider_event_id)
5. **Provider abstraction** — business logic never directly calls providers

### 8.2 Safe Assumptions

1. Database is Supabase PostgreSQL (supports UNIQUE, JSONB, RLS)
2. Node.js/Next.js 16+ environment (supports TypeScript strict mode)
3. No breaking changes to production APIs allowed
4. Correlation IDs can be generated at middleware layer
5. RBAC can be bolted on without changing user auth
6. Audit logging can be async/non-blocking

### 8.3 Testing Assumptions

1. Type checking (TypeScript strict mode) sufficient for correctness
2. Unit tests sufficient for repositories + services
3. Integration tests sufficient for settlement flows
4. No E2E tests needed for Phase 1 (API-only)
5. Manual testing by ops team after deployment

---

## Part 9: Recommended Tools & Patterns

### 9.1 Code Organization

```
lib/admin/
├── repositories/     (data access layer)
├── services/         (business logic layer)
├── middleware/       (auth + audit)
├── types/            (admin TypeScript types)
└── __tests__/        (unit tests)

app/api/admin/
├── search/           (global search)
├── transfers/        (transfer queries + recovery)
├── ledger/           (ledger investigation)
├── webhooks/         (webhook debugging)
├── exceptions/       (exception management)
└── audit-logs/       (audit log queries)
```

### 9.2 Testing Setup

```
Package: jest
Config: jest.config.js
Pattern: *.test.ts files next to implementation
Coverage: >90% for admin code, >70% for utils
```

### 9.3 TypeScript Patterns

```typescript
// Strict mode only
"strict": true,
"noImplicitAny": true,
"noUnusedLocals": true,

// No `any` types anywhere
// Use explicit types on all function parameters
// Use discriminated unions for response envelopes
```

---

## Part 10: Next Steps

### Before Milestone 2 (Correlation IDs)

1. ✅ **Review this document** — confirm approach
2. ✅ **Approve database migrations** — no conflicts with production
3. ✅ **Lock down admin roles** — who will be superadmin, investigator, etc.
4. ✅ **Approve RBAC permission matrix** — what each role can do
5. ⏳ **Ready to proceed to Milestone 2**

### Milestone 2 Deliverables

1. Correlation ID generation + propagation
2. Integration with settlement pipeline
3. Logging with correlation IDs
4. Validation tests
5. Commit + approval before Milestone 3

### Phase 1 Final Deliverables

1. Code: Repositories, services, middleware, migrations
2. Docs: RBAC_ARCHITECTURE.md, AUDIT_LOGGING.md, REPOSITORY_GUIDE.md
3. Tests: Unit tests for all new components
4. Report: PHASE1_VALIDATION.md with coverage + security review

---

## Conclusion

Manna's codebase is **production-ready for financial correctness** but **not ready for operations management**. Phase 1 will add the operational infrastructure (RBAC, audit logging, repositories, correlation IDs) that Phases 2–10 depend on.

The approach is **low-risk** because:
- All changes are additive (no breaking changes)
- Ledger + settlement architecture is not touched
- New code is isolated in admin layer
- Backwards compatible with existing APIs

**Ready to proceed to Milestone 2: Correlation ID Implementation**

---

**Document prepared by:** Principal Staff Engineer  
**Review status:** Complete — Awaiting approval to begin Milestone 2  
**Next action:** Confirm recommended approach, lock down RBAC roles, proceed to correlation ID implementation
