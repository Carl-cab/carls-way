# Release 0.95: Operations Platform — Implementation Plan

**Date:** June 28, 2026  
**Scope:** Comprehensive operations and financial investigation tooling  
**Effort:** ~200–250 engineering hours  
**Timeline:** 4–6 weeks (aggressive), 6–8 weeks (recommended)  
**Status:** Planning phase

---

## Executive Summary

Release 0.95 is a non-customer-facing operations platform that enables financial investigators, compliance teams, and ops engineers to investigate, troubleshoot, and recover financial events entirely through a secure web UI—without ever accessing the production database directly.

**Core Principle:** Every operation must be:
- **Idempotent:** Safe to retry; no duplicate financial mutations
- **Auditable:** Every action logged with operator identity, timestamp, before/after state
- **Reversible:** No permanent damage from human error
- **Type-Safe:** Full TypeScript strict mode, zero `any` types
- **Secure:** Admin-only, IP-whitelisted, MFA-gated for sensitive actions

---

## Current State Assessment

### Existing Infrastructure (Reusable)

| Component | Status | Location | Reuse Plan |
|-----------|--------|----------|-----------|
| Settlement architecture | ✅ Complete | `lib/settlement/` | Extend with replay support |
| Ledger & balance model | ✅ Complete | `lib/ledger.ts` | Query layer, no mutations |
| Provider abstraction | ✅ Complete | `lib/providers/` | Query provider history |
| Webhook deduplication | ✅ Complete | `provider_webhook_events` table | Extend with replay flag |
| Audit logging function | ✅ Partial | `lib/auth.ts:auditLog()` | Extend for admin actions |
| JWT auth middleware | ✅ Complete | `proxy.ts`, `lib/auth.ts` | Extend with admin role check |
| Error handling patterns | ✅ Complete | API routes | Apply consistently |

### Critical Gaps (Must Build)

| Gap | Impact | Solution |
|-----|--------|----------|
| **velocity_checks table** | Velocity logic references missing table | Create in migration + seed |
| **audit_logs table** | Audit logging not persisted | Create in migration, make immutable |
| **Admin RBAC system** | No role-based authorization | Build admin middleware + role enum |
| **Admin UI pages** | No operations dashboard exists | Build 10 pages (dashboard, search, explorers, etc.) |
| **Recovery APIs** | No replay/retry endpoints | Build 8 endpoints (replay, retry, cancel, settle, etc.) |
| **Exception tracking** | Failures not centralized | Extend provider_webhook_events + add exceptions table |
| **Search infrastructure** | Global search not implemented | Build search service + API endpoints |
| **Correlation IDs** | No request tracing | Add to settlement + webhook handlers |

### Database Schema Additions Required

```sql
-- 1. Create audit_logs table (immutable audit trail)
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES users(id),
  action VARCHAR(255) NOT NULL,  -- 'replay_webhook', 'retry_settlement', 'cancel_transfer', etc.
  entity_type VARCHAR(255),      -- 'transfer', 'webhook_event', 'ledger_entry', etc.
  entity_id INTEGER,
  previous_state JSONB,          -- Before state snapshot
  new_state JSONB,               -- After state snapshot
  reason TEXT,                   -- Why action was taken
  correlation_id VARCHAR(255),   -- Links to original request
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(admin_id, created_at, action, entity_id)  -- Prevent duplicate operations
);

-- 2. Create velocity_checks table (already referenced, not yet created)
CREATE TABLE velocity_checks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  window_type VARCHAR(50),  -- 'hourly', 'daily', 'weekly'
  window_start TIMESTAMPTZ,
  transaction_count INTEGER DEFAULT 0,
  total_amount NUMERIC(12,2) DEFAULT 0,
  currency VARCHAR(10),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, window_type, window_start, currency)
);

-- 3. Create exceptions table (centralized failure tracking)
CREATE TABLE operation_exceptions (
  id SERIAL PRIMARY KEY,
  exception_type VARCHAR(255) NOT NULL,  -- 'failed_settlement', 'orphaned_transfer', 'balance_mismatch', etc.
  severity VARCHAR(50),                   -- 'critical', 'high', 'medium', 'low'
  status VARCHAR(50) DEFAULT 'open',     -- 'open', 'in_progress', 'resolved', 'invalid'
  category VARCHAR(255),                  -- 'provider', 'webhook', 'ledger', 'balance', etc.
  
  -- Entity references (flexible: any entity can be involved)
  transfer_intent_id INTEGER REFERENCES transfer_intents(id),
  webhook_event_id INTEGER REFERENCES provider_webhook_events(id),
  user_id INTEGER REFERENCES users(id),
  
  -- Details
  title TEXT NOT NULL,
  description TEXT,
  root_cause TEXT,                        -- After investigation
  
  -- Metadata
  metadata JSONB,                         -- Provider error, balance delta, etc.
  attempted_recovery TEXT[],              -- Array of recovery action descriptions
  owner_id INTEGER REFERENCES users(id),  -- Ops engineer assigned
  
  -- Timeline
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Traceability
  correlation_id VARCHAR(255)
);

-- 4. Create replay_log table (track all replay operations)
CREATE TABLE replay_log (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES users(id),
  
  -- What was replayed
  replay_type VARCHAR(50),  -- 'webhook', 'settlement', 'ledger', 'balance'
  entity_id INTEGER,
  entity_type VARCHAR(50),
  
  -- Original vs replayed
  original_correlation_id VARCHAR(255),
  replay_correlation_id VARCHAR(255),
  original_timestamp TIMESTAMPTZ,
  
  -- Outcome
  success BOOLEAN,
  result_summary JSONB,       -- { statusBefore, statusAfter, entriesCreated, etc. }
  error_message TEXT,
  
  -- Reason & audit
  reason TEXT NOT NULL,
  admin_reason TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Add to provider_webhook_events for replay tracking
ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS replay_count INTEGER DEFAULT 0;
ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS last_replay_at TIMESTAMPTZ;
ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS replay_approved_by INTEGER REFERENCES users(id);
ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255);
```

---

## Architecture: Separation of Concerns

### Layer 1: Data Access Layer (Repository Pattern)

**File:** `lib/admin/repositories/`

Create type-safe, read-only repositories for each domain:

```typescript
// TransferRepository: Query transfer lifecycle
TransferRepository.findById(id)
TransferRepository.findByProvider(providerId, reference)
TransferRepository.findPending()
TransferRepository.findFailed()
TransferRepository.findByDateRange(start, end)

// LedgerRepository: Query ledger, compute balances
LedgerRepository.findEntriesByUser(userId, currency)
LedgerRepository.findEntriesByTransfer(transferId)
LedgerRepository.computeBalance(userId, currency)
LedgerRepository.findDiscrepancies()

// WebhookRepository: Query webhook history
WebhookRepository.findByEvent(provider, eventId)
WebhookRepository.findByTransfer(transferId)
WebhookRepository.findFailed()
WebhookRepository.findRetryable()

// ExceptionRepository: Query + mutate exceptions (controlled)
ExceptionRepository.create(exception)
ExceptionRepository.findOpen()
ExceptionRepository.findByTransfer(transferId)
ExceptionRepository.updateStatus(id, newStatus, reason)

// AuditRepository: Append-only audit logs
AuditRepository.log(action, entity, previousState, newState, reason)
AuditRepository.findByEntity(entityType, entityId)
AuditRepository.findByAdmin(adminId, dateRange)
```

**Why:** Consolidates all data queries in type-safe layer. Enforces read-only access (no balance mutations). Makes tests easier. Enables audit logging at query layer.

### Layer 2: Service Layer (Business Logic)

**File:** `lib/admin/services/`

Services contain operational logic:

```typescript
// SettlementRecoveryService: Safe settlement retry
recoveryService.retrySettlement(transferId, reason)
recoveryService.forceCancelTransfer(transferId, reason)
recoveryService.forceMarkSettled(transferId, reason)

// WebhookReplayService: Safe webhook replay
replayService.replayWebhook(webhookId, reason)
replayService.replayRange(startId, endId, reason)
replayService.validateReplayability(webhookId)

// ExceptionService: Exception management
exceptionService.createFromWebhookFailure(webhookId)
exceptionService.assignToOperator(exceptionId, operatorId)
exceptionService.resolveException(exceptionId, resolution)

// SearchService: Global search
searchService.search(query, types)
searchService.autocomplete(partial)

// BalanceInvestigation: Detect anomalies
investigationService.findBalanceMismatches()
investigationService.findOrphanedTransfers()
investigationService.verifyLedgerSum(userId)
```

**Why:** Business logic separate from HTTP layer. Enables same logic to be called from API and jobs. Easy to test.

### Layer 3: Admin Middleware (Authorization)

**File:** `lib/admin/middleware/`

```typescript
// Check admin role
async requireAdmin(req) → throws 403 if not admin
async requireAdminWithMFA(req) → throws 401 if no MFA token
async checkIPWhitelist(req) → throws 403 if IP not whitelisted

// Log admin action
async auditAdminAction(
  admin: AdminUser,
  action: string,
  entity: { type, id },
  previousState?: any,
  newState?: any,
  reason?: string
)
```

**Why:** Consistent authorization across all admin endpoints. Automatic audit logging. MFA support.

### Layer 4: API Routes (HTTP Handlers)

**Files:** `app/api/admin/*/`

All routes follow pattern:
1. Check auth (admin + optional MFA)
2. Validate input (strict TypeScript types)
3. Call service layer
4. Return structured response with audit context
5. Audit log action

---

## Implementation Phases (Detailed)

### Phase 1: Foundation (Weeks 1–2, ~40 hours)

**Goal:** Build infrastructure for all subsequent phases.

**Deliverables:**

1. **Database schema migration** (4 hours)
   - Add audit_logs table (immutable, indexes on admin_id + created_at)
   - Add velocity_checks table (already referenced, not created)
   - Add operation_exceptions table (flexible schema for exception tracking)
   - Add replay_log table (complete audit of all replays)
   - Extend provider_webhook_events with replay fields + correlation_id
   - Seed test data in non-production environments

2. **Admin RBAC system** (12 hours)
   - Define admin user type in users table (add admin_role VARCHAR column)
   - Admin roles: 'superadmin', 'investigator', 'operator', 'viewer'
   - Permission matrix (superadmin = all, investigator = view+replay, operator = recovery, viewer = read-only)
   - Admin middleware: requireAdmin(), requireRole(), requireMFA()
   - IP whitelist implementation (env var or config)

3. **Repository pattern implementation** (16 hours)
   - TransferRepository with finder methods (no mutations)
   - LedgerRepository with query + computed balance (no mutations)
   - WebhookRepository with complete history (no mutations)
   - ExceptionRepository with controlled mutations
   - AuditRepository (append-only)
   - Type definitions for all queries
   - Unit tests for each repository

4. **Correlation ID infrastructure** (8 hours)
   - Add correlation_id to all settlement operations
   - Add correlation_id to webhook handlers
   - Thread correlation_id through request context
   - Add correlation_id to logs + audit records
   - Ability to trace single transfer through all systems

### Phase 2: Admin API Foundation (Week 2, ~20 hours)

**Goal:** Build reusable API patterns for admin endpoints.

**Deliverables:**

1. **Search API** (8 hours)
   - Global search endpoint: `GET /api/admin/search?q=...&types=transfer,user,webhook`
   - Supported query types: transfer_id, user_id, email, username, webhook_event_id, correlation_id, ledger_entry_id
   - Return linked results with related entities
   - Pagination support
   - Type-safe response envelopes

2. **Admin response envelopes** (4 hours)
   - Standard { success, data, error, context } format
   - Include audit context: { admin_id, timestamp, reason, correlation_id }
   - Proper error codes and messages
   - Structured validation errors

3. **Exception tracking APIs** (8 hours)
   - `GET /api/admin/exceptions` — list open exceptions
   - `GET /api/admin/exceptions/{id}` — exception detail with related entities
   - `POST /api/admin/exceptions/{id}/assign` — assign to operator
   - `POST /api/admin/exceptions/{id}/resolve` — mark resolved + reason
   - `POST /api/admin/exceptions/{id}/reopen` — reopen if needed

---

### Phase 3: Dashboard & UI Foundation (Weeks 3–4, ~60 hours)

**Goal:** Build operations dashboard with real-time data.

**Deliverables:**

1. **Admin layout** (8 hours)
   - Create app/(admin)/ route group
   - Admin navigation sidebar with links to all tools
   - Breadcrumb + admin status indicator
   - User/logout controls
   - Time-based activity indicator (24/7 operations)

2. **Dashboard page** (16 hours)
   - Real-time card widgets:
     - Active transfers (count, list)
     - Failed transfers (count, list with reason)
     - Pending settlements (count by age)
     - Webhook failures (count, recent)
     - Open exceptions (count by severity)
     - Provider health (status, last sync)
   - Charts: daily volume, success rate, settlement time
   - Recent activity feed (transfers, exceptions, manual actions)
   - Alert banner for critical issues
   - Auto-refresh every 30 seconds

3. **Search page** (8 hours)
   - Global search box with autocomplete
   - Search results grouped by type (transfers, users, webhooks)
   - Quick links to detailed pages
   - Recent searches

4. **Transfer detail page** (12 hours)
   - Transfer info: id, sender, recipient, amount, currency, status
   - Timeline: created → confirmed → submitted → settled/failed
   - Provider info: provider, reference_id, execution mode
   - Ledger entries related to transfer
   - Webhook events in order
   - Balance changes for both users
   - Audit log (all admin actions affecting this transfer)
   - Action buttons: retry, cancel, force settle (if applicable + authorized)

5. **Ledger explorer page** (8 hours)
   - Ledger entry table: entry_id, user, type, debit, credit, currency, timestamp
   - Filters: user, transfer, currency, date range, account type
   - Column sorting (amount, timestamp)
   - Pagination
   - Detail drawer: full entry with related transfer + webhook event
   - Balance verification: show current balance vs ledger sum

6. **Webhook explorer page** (8 hours)
   - Webhook event table: event_id, provider, event_type, timestamp, status
   - Filters: provider, status (received, processed, failed), date range
   - Raw payload display (formatted JSON)
   - Processing history: attempt count, last error, last retry
   - Replay button (if conditions met)
   - Link to related transfer

---

### Phase 4: Recovery Operations (Week 5, ~50 hours)

**Goal:** Build safe, idempotent recovery workflows.

**Deliverables:**

1. **Settlement Retry Service** (16 hours)
   - `retrySettlement(transferId, reason)` — re-run settlement phases
   - Idempotency: check if already processed via correlation_id
   - Transactions: atomic, no partial updates
   - Audit: log before/after state, operator, reason
   - Tests: retry of already-settled, retry of failed, duplicate prevention

2. **Webhook Replay Service** (16 hours)
   - `replayWebhook(webhookId, reason)` — re-process webhook
   - Safety checks: verify transfer exists, not already processing
   - New correlation_id to prevent deduplication confusion
   - Track in replay_log table
   - Idempotent by design (balance_processed_at prevents duplicate balance updates)
   - Tests: successful replay, duplicate prevention, already-processed

3. **Batch Replay Service** (10 hours)
   - Replay range of webhooks: `replayRange(startId, endId, reason)`
   - Rate limiting: one per second to avoid overload
   - Progress tracking: return job_id, allow polling status
   - Audit: each replay separately logged
   - Tests: verify all replayed, verify audit trail complete

4. **Force Settlement Service** (8 hours)
   - `forceMarkSettled(transferId, reason)` — manually settle stuck transfer
   - Preconditions: transfer in processing > 7 days, operator confirmation
   - Creates ledger entries if not present
   - Updates balance atomically
   - Audit: clear reason required, admin MFA gated
   - Tests: creates ledger entries, updates balance correctly, prevents duplicates

---

### Phase 5: Exception Center & Investigation Tools (Week 6, ~40 hours)

**Goal:** Centralize exception tracking and investigation.

**Deliverables:**

1. **Exception Detection Service** (12 hours)
   - Detect failed webhooks: no completion event after X hours
   - Detect orphaned transfers: exists in transfer_intents but no provider_reference_id
   - Detect balance mismatches: compute via ledger, compare to balance column
   - Detect duplicate webhooks: same event_id processed multiple times
   - Detect provider failures: API errors, timeouts, rate limits
   - Create exception record for each
   - Scheduled job (run every 5 min): query for new issues
   - Tests: detect each exception type, no false positives

2. **Exception investigator page** (12 hours)
   - Exception list: type, severity, status, detected_at, owner
   - Detail page: full context (transfer, webhook, ledger, balance)
   - Investigation workflow:
     - [ ] Assign to investigator
     - [ ] Categorize root cause (provider, network, config, user, unknown)
     - [ ] Attempt recovery (retry, replay, force settle)
     - [ ] Mark resolved + notes
   - Sidebar: related exceptions (same provider, same user, similar time)

3. **Recovery actions page** (16 hours)
   - UI for controlled recovery:
     - Retry settlement (select transfer, confirm, submit)
     - Replay webhook (select event, confirm, submit)
     - Force settlement (transfer → settled, requires MFA)
     - Cancel transfer (draft/ready only)
   - Each action: confirmation dialog, reason field, MFA entry
   - After action: show result, next steps, related exceptions to resolve
   - Audit: action logged with all context

---

### Phase 6: Ledger & Balance Investigation Tools (Week 6–7, ~30 hours)

**Goal:** Deep financial investigation capability.

**Deliverables:**

1. **Ledger verification service** (10 hours)
   - `verifyLedgerSum(userId, currency)` — compute ledger sum, compare to balance
   - Report discrepancies with delta amount
   - Trace which entries caused mismatch (identify duplicate/missing entries)
   - Return investigation data: all entries, sum, current balance, delta
   - Scheduled job: daily verification, create exception if mismatch

2. **Balance investigation page** (10 hours)
   - User lookup: search by ID, email, username
   - User detail: name, KYC status, both balances (CAD + USD)
   - Balance verification:
     - [ ] Ledger sum CAD
     - [ ] Ledger sum USD
     - [ ] Current balance CAD
     - [ ] Current balance USD
     - [ ] Discrepancies (if any)
   - Ledger entries table: all entries for this user (both currencies)
   - Related transfers: all transfers where user is sender/receiver
   - Related webhooks: events that affected this user

3. **Reconciliation tools** (10 hours)
   - Daily reconciliation viewer: see results of daily balance check
   - Export reconciliation report: CSV of user balances vs ledger
   - Manual reconciliation trigger: run verification now (for testing)
   - Discrepancy details: which entries are problematic

---

### Phase 7: Audit & Compliance Tools (Week 7, ~25 hours)

**Goal:** Complete audit trail for regulatory compliance.

**Deliverables:**

1. **Audit log viewer page** (10 hours)
   - Audit log table: admin, action, entity, timestamp, reason
   - Filters: admin, action type, date range, entity type
   - Detail drawer: full before/after state comparison
   - Export: CSV/JSON for compliance
   - Search: correlation_id, entity_id
   - Immutability verification: show created_at, no updates allowed

2. **Admin activity dashboard** (8 hours)
   - Per-admin stats: actions today, actions this week, most common action
   - Timeline: all actions chronologically
   - Alert: unusual activity (e.g., 100 force-settlements in 1 hour)
   - Reports: actions by type (replays, settlements, cancellations)

3. **Data export tools** (7 hours)
   - Export transfers: date range, filter by status
   - Export ledger: user, currency, date range
   - Export webhooks: date range, filter by provider/status
   - Export audit logs: date range, admin, action type
   - CSV format, safe for compliance
   - Audit log entry for each export

---

### Phase 8: Testing & Validation (Week 8, ~60 hours)

**Goal:** Production-ready test coverage and security validation.

**Deliverables:**

1. **Unit tests** (20 hours)
   - Repository tests: finder methods, computed balances, no mutations
   - Service tests: retry logic, replay idempotency, force settlement
   - Middleware tests: admin check, MFA validation, IP whitelist
   - Exception detection tests: all exception types
   - Audit logging tests: complete + immutable

2. **Integration tests** (20 hours)
   - Replay webhook → verify settlement → verify ledger → verify balance
   - Retry settlement → verify idempotency on second retry
   - Force settlement → verify ledger entries + balance updated
   - Exception creation → resolve → verify audit log
   - Search across all entity types

3. **Security & authorization tests** (12 hours)
   - Non-admin cannot access `/api/admin/*`
   - Viewer cannot call recovery endpoints (read-only enforced)
   - Operator cannot call force-settlement without MFA
   - Sensitive operations require reason + audit context
   - SQL injection prevention (parameterized queries)
   - CORS: admin APIs not callable from browser

4. **Financial correctness tests** (8 hours)
   - Replay → no duplicate balance mutations
   - Retry → idempotent, no double-apply
   - Force settlement → balance delta correct
   - Ledger sum = balance after any operation

---

### Phase 9: Documentation (Week 8, ~15 hours)

**Deliverables:**

1. **OPERATIONS_PLATFORM.md** (5 hours)
   - Architecture overview with diagrams
   - Layer descriptions: repositories, services, middleware, routes
   - Data model: entities, relationships
   - API specifications for all endpoints
   - Authentication & authorization model

2. **ADMIN_SECURITY.md** (3 hours)
   - Admin role definitions + permissions matrix
   - MFA requirements for sensitive operations
   - IP whitelist configuration
   - Audit logging requirements
   - Compliance considerations

3. **RECOVERY_PROCEDURES.md** (4 hours)
   - Common incident scenarios + recovery steps
   - Stuck transfer → troubleshoot → resolve
   - Balance mismatch → investigate → correct
   - Failed webhook → replay or retry
   - Exception center workflow

4. **REPLAY_ENGINE.md** (3 hours)
   - How replay works: correlation_id, idempotency, safety
   - When to use replay vs retry
   - Replay failure modes + handling
   - Monitoring replays

---

### Phase 10: Deployment & Validation (Week 8, ~10 hours)

**Deliverables:**

1. **Pre-production validation** (6 hours)
   - Test in staging environment with prod-like data
   - Validate all admin flows work end-to-end
   - Confirm audit logging complete
   - Confirm no data mutations from read-only queries
   - Security scan: no hardcoded secrets, no SQL injection

2. **Ops team training** (2 hours)
   - Walkthrough of dashboard + search
   - Exception center workflow
   - Recovery procedures (safe paths only)
   - Audit log review
   - When to escalate to engineering

3. **Go-live** (2 hours)
   - Deploy to production
   - Verify all endpoints responding
   - Spot-check audit logging
   - Set up monitoring alerts

---

## Detailed Task Breakdown by File

### Database Migrations

**File:** `app/api/migrate/route.ts` (additions)

```typescript
// Add 5 new tables + extend 1 existing table
// Lines TBD: ~150 lines total
```

### Repositories Layer

**Files:** `lib/admin/repositories/` (new directory)

```
TransferRepository.ts        (~120 lines) — transfer finders + details
LedgerRepository.ts          (~150 lines) — ledger queries + balance calc
WebhookRepository.ts         (~100 lines) — webhook history + retry checks
ExceptionRepository.ts       (~130 lines) — exceptions (query + controlled mutations)
AuditRepository.ts           (~80 lines) — append-only audit logs
index.ts                     (~20 lines) — export all repositories
__tests__/
  TransferRepository.test.ts
  LedgerRepository.test.ts
  WebhookRepository.test.ts
  ExceptionRepository.test.ts
```

### Services Layer

**Files:** `lib/admin/services/` (new directory)

```
SettlementRecoveryService.ts (~180 lines) — retry, cancel, force settle
WebhookReplayService.ts      (~150 lines) — replay, batch replay, validation
ExceptionService.ts          (~120 lines) — exception lifecycle
SearchService.ts             (~100 lines) — global search
BalanceInvestigationService.ts (~140 lines) — detect mismatches + verify
index.ts                     (~15 lines) — export all services
__tests__/
  SettlementRecoveryService.test.ts
  WebhookReplayService.test.ts
  ExceptionService.test.ts
  BalanceInvestigationService.test.ts
```

### Middleware

**Files:** `lib/admin/middleware/` (new directory)

```
authorization.ts             (~80 lines) — requireAdmin, requireRole, requireMFA
adminAudit.ts                (~60 lines) — auditAdminAction
ipWhitelist.ts               (~40 lines) — IP validation
index.ts                     (~15 lines) — export
__tests__/
  authorization.test.ts
  adminAudit.test.ts
```

### API Routes

**Files:** `app/api/admin/` (new directory + additions)

```
api/admin/
├── search/route.ts                       (~100 lines) — global search endpoint
├── exceptions/
│   ├── route.ts                          (~80 lines) — list exceptions
│   └── [id]/
│       ├── route.ts                      (~100 lines) — exception detail
│       ├── assign/route.ts               (~60 lines) — assign to operator
│       └── resolve/route.ts              (~80 lines) — resolve exception
├── transfers/
│   ├── route.ts                          (~80 lines) — list transfers
│   └── [id]/
│       ├── route.ts                      (~150 lines) — transfer detail + related entities
│       ├── retry-settlement/route.ts     (~120 lines) — retry settlement
│       ├── replay-webhook/route.ts       (~100 lines) — replay webhook
│       ├── force-settle/route.ts         (~140 lines) — force settlement
│       └── cancel/route.ts               (~100 lines) — cancel transfer
├── ledger/
│   ├── route.ts                          (~100 lines) — ledger entries
│   └── verify/route.ts                   (~80 lines) — verify balance
├── webhooks/
│   ├── route.ts                          (~100 lines) — webhook list
│   └── [id]/
│       ├── route.ts                      (~120 lines) — webhook detail
│       ├── replay/route.ts               (~100 lines) — single replay
│       └── batch-replay/route.ts         (~150 lines) — batch replay
├── audit-logs/
│   └── route.ts                          (~100 lines) — audit log list
└── __tests__/
    ├── search.test.ts
    ├── exceptions.test.ts
    ├── transfers.test.ts
    ├── recovery.test.ts
    └── replay.test.ts
```

**Total API lines:** ~2,100 lines

### UI Pages

**Files:** `app/(admin)/` (new route group, 10 pages)

```
(admin)/
├── layout.tsx                 (~150 lines) — admin layout + navigation
├── page.tsx                   (~250 lines) — dashboard
├── search/page.tsx            (~120 lines) — search page
├── transfers/
│   ├── page.tsx               (~150 lines) — transfer list
│   └── [id]/page.tsx          (~300 lines) — transfer detail
├── ledger/
│   ├── page.tsx               (~180 lines) — ledger explorer
│   └── balance-check/page.tsx (~150 lines) — balance verification
├── webhooks/
│   ├── page.tsx               (~180 lines) — webhook list
│   └── [id]/page.tsx          (~200 lines) — webhook detail
├── exceptions/
│   ├── page.tsx               (~200 lines) — exception list
│   └── [id]/page.tsx          (~300 lines) — exception detail + recovery
└── audit-logs/page.tsx        (~150 lines) — audit log viewer
```

**Total UI lines:** ~2,500 lines (React components)

### Supporting Files

```
types/admin.ts               (~200 lines) — TS interfaces for admin entities
utils/admin-responses.ts     (~80 lines) — response envelope helper
constants/admin.ts           (~40 lines) — role constants, severity levels
```

### Documentation Files

```
OPERATIONS_PLATFORM.md       (~2,000 words) — Architecture + API spec
ADMIN_SECURITY.md            (~1,000 words) — RBAC + security model
RECOVERY_PROCEDURES.md       (~1,500 words) — Common scenarios + solutions
REPLAY_ENGINE.md             (~1,000 words) — How replay works
```

---

## Critical Design Decisions

### 1. Idempotency via Correlation IDs

**Decision:** Every settlement operation gets a unique correlation_id. Retries preserve the original ID.

**Why:** Allows safe retries. If the same operation is retried, balance_processed_at prevents double-apply. If system crashes mid-operation, retry with same correlation_id is safe.

**Implementation:** 
- Add correlation_id to transfer_intents at creation
- Thread through settlement pipeline
- Store in ledger_entries + provider_webhook_events
- Replay operations generate new correlation_id for traceability

### 2. Repository Pattern for Data Access

**Decision:** All queries go through repositories. No direct SQL in route handlers.

**Why:**
- Enforces read-only for most entities
- Easy to test + mock
- Audit logging at query layer (detect unusual queries)
- Type-safe queries
- Prevents "accidental" mutations in non-mutation endpoints

**Exception:** Mutations only in Service layer (after validation, with audit)

### 3. Audit Logging at Every Layer

**Decision:** Audit log entry for every admin action (search, view detail, replay, force settle).

**Why:**
- Regulatory requirement (FINTRAC)
- Security: detect unauthorized access attempts
- Forensics: trace who changed what when
- Immutable: no edits, only appends

**Implementation:**
- middleware/adminAudit captures before/after state
- Automatic for all recovery operations
- Manual for reads (e.g., search logged for compliance)

### 4. Strict TypeScript + No Any Types

**Decision:** All code strict mode, zero `any`.

**Why:**
- Financial correctness depends on type safety
- Prevents silent bugs (e.g., string vs number in balance calc)
- Makes refactoring safe
- IDE support for navigation + completion

### 5. MFA for Sensitive Operations

**Decision:** Force settlement, bulk replay, manual balance correction require MFA.

**Why:**
- Prevents human error from single compromise
- Slows attackers even with stolen admin token
- Industry standard for financial systems

**Implementation:**
- Generate MFA token via 2FA app (TOTP)
- Validate MFA token on sensitive endpoints
- Log MFA success/failure

### 6. No Direct Database Access in Operations

**Decision:** Zero direct SQL for ops team. All operations via web UI.

**Why:**
- Prevents accidental data corruption
- Forces operations through audit layer
- Reduces security surface
- Easier to onboard new team members

### 7. Safe Failure Modes

**Decision:** All recovery operations fail-safe. Better to raise exception than silently corrupt.

**Why:**
- Financial systems must never silently fail
- Exceptions get tracked in exception center
- Ops team notified immediately
- Prevents cascading failures

---

## Reusable Components (Don't Duplicate)

| Component | Location | Reuse |
|-----------|----------|-------|
| Settlement phases | `lib/settlement/` | Call existing executors, don't rewrite |
| Ledger logic | `lib/ledger.ts` | Query via LedgerRepository, don't duplicate balance calc |
| Auth + auditLog | `lib/auth.ts` | Extend auditLog for admin actions, don't fork |
| Webhook dedup | `provider_webhook_events` | Extend table for replay tracking |
| Error patterns | Existing routes | Follow same error handling style |
| JWT validation | `lib/auth.ts` | Use getAuthUser(), extend for admin role |

**Critical:** Do NOT rewrite settlement executor, balance logic, or ledger functions. Extend existing code.

---

## Security Checklist

- [ ] All admin endpoints require authentication (getAuthUser)
- [ ] Role-based authorization (requireRole middleware)
- [ ] IP whitelist (configurable env var)
- [ ] MFA for sensitive operations (force settle, bulk replay)
- [ ] No hardcoded secrets (use env vars)
- [ ] All queries parameterized (no string interpolation)
- [ ] Audit logging for every admin action
- [ ] Response envelopes don't leak PII or system details
- [ ] Rate limiting on recovery endpoints (1 per second)
- [ ] CORS headers restrict admin UI origins
- [ ] No console.log of sensitive data
- [ ] Error messages generic (don't expose DB schema)

---

## Monitoring & Alerting for Ops Platform

Once deployed, monitor:

- **Exception queue:** Alert if > 10 open exceptions
- **Replay failures:** Log all replay attempts, alert on > 5 failures in an hour
- **Recovery latency:** Track time from exception detection to resolution
- **Audit log gaps:** Alert if > 5 min without audit log entry (indicates logging failure)
- **Admin activity:** Alert on unusual patterns (e.g., 100 force-settlements in 1 hour)

---

## Success Metrics

| Metric | Target |
|--------|--------|
| **Ops team autonomy** | 100% of incidents resolved without engineering DB access |
| **MTTR (Mean Time To Resolve)** | < 15 min for common failures (stuck transfer, failed webhook) |
| **Audit completeness** | 100% of admin actions logged with before/after state |
| **Replay success rate** | > 95% (only fail if transfer already processed or business rule prevents) |
| **Test coverage** | > 90% for services + repositories, 100% for recovery paths |
| **Security incidents** | 0 unauthorized access attempts via brute force (rate limiting + MFA) |

---

## Rollout Plan

### Staging Environment (Week 8)
- Deploy all code to staging
- Load prod-like data snapshot
- QA team tests all 10 phases
- Security scan + pen test
- Ops team does dry runs

### Production (Week 8, EOD)
- Feature gate: only reachable if admin role set
- Start with 1 admin user (yourself)
- Expand to ops team after 1 week
- Monitor audit logs + exceptions
- Incident reviews using ops platform

---

## Known Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Operator makes invalid recovery | Financial error | MFA + reason required + dry-run simulation |
| Replay doesn't achieve idempotency | Duplicate balance mutation | Comprehensive tests + balance verification UI |
| Audit logs incomplete | Compliance failure | Audit logging at every layer + daily audit verify job |
| Exceptional performance | Ops team can't work | Caching for read-heavy pages, pagination for large result sets |
| Authorization bypass | Unauthorized recovery | Strict TS types, role checks in middleware, security scan |

---

## Next Steps

1. **Review this plan** with ops team + security team
2. **Validate database migrations** don't conflict with production
3. **Approve reusable component strategy** (extend don't rewrite)
4. **Allocate 200–250 engineering hours** across 8 weeks
5. **Lock down admin roles** (who will be admin, investigator, operator, viewer)
6. **Set up staging environment** with test data
7. **Begin Phase 1: Foundation**

---

**Document prepared by:** Principal Staff Engineer  
**Date:** June 28, 2026  
**Status:** Ready for approval + coding start
