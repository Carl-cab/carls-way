# Production Readiness Roadmap — Phases C1 through C5

**Objective:** Transform Manna from a validated sandbox application into a production-ready payments platform handling real money safely.

**Timeline:** ~12 weeks, 1,532+ engineering hours + legal/regulatory work

---

## Phase C1: Validation & Hardening (Weeks 1-2)

**Goal:** Complete regulatory assessment, document risk mitigations, and harden core systems before moving to operations work.

**Duration:** 2 weeks  
**Effort:** 280+ hours (legal) + 100 hours (engineering)

### C1.1: Regulatory & Compliance Assessment (BLOCKING)

**Must complete before any real money movement.**

**Deliverables:**
- [ ] MSB licensing analysis for target jurisdictions (US + Canada)
- [ ] Regulatory risk assessment document
- [ ] Compliance roadmap with timelines
- [ ] Terms of service and privacy policy (PIPEDA-compliant)
- [ ] AML/KYC policy documentation
- [ ] Incident response & notification procedures
- [ ] FINTRAC/FinCEN reporting framework

**Effort:** 60+ hours (external legal counsel required)

**Outcome:** Clear path to regulatory compliance; identified licensing costs and timelines

---

### C1.2: Financial Correctness Hardening

**Implement balance reconciliation (eliminates financial correctness risk).**

**Deliverables:**
- [ ] Daily balance-to-ledger reconciliation service
  - Queries all users' balance_cad, balance_usd
  - Sums ledger_entries per user
  - Reports discrepancies
  - Stores reconciliation audit log
  
- [ ] FX rate audit logging
  - Logs every FX quote (amount, rate, timestamp, source)
  - Enables audit trail for cross-border transfers
  - Detects rate drift

- [ ] Ledger completeness verification
  - Every balance change must have ledger entries
  - Automated check for orphaned balance updates

- [ ] Balance assertions
  - Periodic balance sanity checks (no negative, no overflow)
  - Automated anomaly detection (sudden large changes)

**Effort:** 100 hours

**Outcome:** Automatic daily detection of any balance/ledger mismatch; audit trail of all FX conversions

---

### C1.3: Failure Recovery Mechanisms (MVP)

**Implement basic recovery for common failure scenarios.**

**Deliverables:**
- [ ] Dead-letter queue for failed webhooks
  - Store failed events in separate table
  - Manual trigger to reprocess
  - Exponential backoff for automatic retries (v2)

- [ ] Transfer timeout handling
  - Identify transfers in processing state > 7 days
  - Alert for manual review
  - Procedure to move to failed/cancelled

- [ ] Manual settlement override
  - Admin endpoint to force transfer to settled state
  - Requires approval workflow
  - Creates audit log entry

- [ ] Balance correction tool
  - Admin ability to adjust balance
  - Requires approval + justification
  - Creates double-entry ledger reversal

**Effort:** 64 hours

**Outcome:** Can recover from most failure scenarios without database interventions

---

### C1.4: Security Hardening

**Implement critical security controls.**

**Deliverables:**
- [ ] Rate limiting
  - Per-user rate limits (100 requests/min)
  - Per-endpoint rate limits (transfers: 10/hour)
  - Per-IP limits (login: 5 attempts/hour)

- [ ] API key rotation procedures
  - ENV var rotation playbook
  - Secret versioning in vault (Vercel secrets or external)
  - Automated rotation alerts

- [ ] Admin API protection
  - IP whitelist for `/api/admin/*`
  - MFA requirement for sensitive operations
  - Rate limits on admin endpoints

- [ ] Session timeout
  - JWT expiry: 24 hours (was infinite)
  - Force re-auth after 12 hours of inactivity
  - Session revocation on logout

**Effort:** 72 hours

**Outcome:** API protected from brute force; admin operations require MFA; sessions controlled

---

**C1 Completion Criteria:**
- [ ] Regulatory assessment complete, path to licensing defined
- [ ] Daily balance reconciliation running with zero discrepancies
- [ ] All C1.3 recovery mechanisms tested with failure scenarios
- [ ] Security controls in place and tested
- [ ] No financial correctness issues in 1 week of operation

---

## Phase C2: Operations Console (Weeks 3-4)

**Goal:** Build admin dashboard and operations tools so the team can operate safely without database access.

**Duration:** 2 weeks  
**Effort:** 180 hours (engineering)

### C2.1: Admin Dashboard

**Deliverables:**
- [ ] User management console
  - Search by email, phone, ID
  - View balance (both currencies)
  - View KYC status and documents
  - Edit KYC status (with audit log)
  - View transaction history
  - View audit log for user
  - View velocity limit status

- [ ] Transfer operations
  - Search transfers by ID, status, date range
  - View transfer details (both parties, provider, status, ledger entries)
  - Manual settlement (draft → settled, with approval)
  - Manual refund (create reversal ledger entries)
  - Cancellation (only from draft/ready states)
  - Force completion (move from processing → settled/failed)

- [ ] Velocity management
  - View user velocity limit
  - Override velocity for specific user
  - Bulk velocity adjustments
  - Velocity reset for new month

**Effort:** 80 hours

---

### C2.2: Monitoring Dashboard

**Deliverables:**
- [ ] Real-time operations dashboard
  - Recent transfers (last 24 hours) — status, amount, provider
  - Failed transfers count — grouped by reason
  - Pending transfers count — grouped by age
  - Error rate — requests/responses, sorted by endpoint
  - API latency distribution (p50, p95, p99)

- [ ] Financial health dashboard
  - Total balance in system (CAD + USD)
  - New users today, this week
  - Total transactions today, this week
  - Transaction success rate
  - Average settlement time

- [ ] Provider status dashboard
  - Plaid/Stripe API health
  - Provider error rate
  - Recent provider events

**Effort:** 48 hours

---

### C2.3: Operations Runbooks & Training

**Deliverables:**
- [ ] Runbook: Resolve stuck transfer
  - Steps to identify root cause
  - Decision tree for manual vs auto recovery
  - Approval workflow for manual settlement

- [ ] Runbook: Handle failed KYC
  - How to manually review/approve
  - How to request additional docs
  - How to reject and notify user

- [ ] Runbook: Balance discrepancy
  - How to identify (daily reconciliation report)
  - How to root cause
  - How to correct (with approval)

- [ ] Runbook: Incident response
  - Escalation procedure
  - Customer communication template
  - Regulatory notification procedure
  - Post-mortem template

- [ ] Operations team training
  - Dashboard walkthrough
  - Runbook exercises
  - Simulated incident response

**Effort:** 52 hours

---

**C2 Completion Criteria:**
- [ ] Admin dashboard deployed and tested
- [ ] Ops team can resolve 95% of customer issues without database access
- [ ] Monitoring dashboard shows real-time system health
- [ ] All runbooks documented and team trained

---

## Phase C3: Monitoring & Alerting (Weeks 5-6)

**Goal:** Implement comprehensive observability so issues are detected and escalated automatically.

**Duration:** 2 weeks  
**Effort:** 160 hours (engineering)

### C3.1: Structured Logging & Aggregation

**Deliverables:**
- [ ] Structured logging implementation
  - JSON logging format
  - Correlation IDs for request tracing
  - Request/response logging (redacted for PII)
  - Error context (stack trace, user ID, request ID)

- [ ] Log aggregation system (Datadog, LogRocket, or similar)
  - All logs shipped to centralized system
  - Searchable by timestamp, user, request ID, endpoint
  - Retention: 30 days for audit, 7 days for debug logs
  - Cost ~$500-2000/month

- [ ] Audit trail querying
  - `GET /api/admin/audit-log?user_id=X&date_range=...`
  - Queryable audit log (who changed what, when)
  - Immutable storage

**Effort:** 64 hours

---

### C3.2: Metrics Collection

**Deliverables:**
- [ ] Prometheus metrics instrumentation
  - Request count (by endpoint, status, method)
  - Request latency (p50, p95, p99)
  - Database query count & latency
  - API error count (by type)
  - Business metrics:
    - Transfers created, settled, failed (daily)
    - Revenue (sum of transfers, by currency)
    - New users (by day)
    - KYC pass rate

- [ ] Dashboards in Prometheus/Grafana
  - Real-time request rate & latency
  - Error rate trends
  - Business metrics trends
  - Database connection pool utilization
  - Response time by endpoint

**Effort:** 56 hours

---

### C3.3: Alerting Rules & Escalation

**Deliverables:**
- [ ] Alert rules (PagerDuty, Opsgenie, or similar)
  - **SEV-1 (page ops immediately):**
    - API error rate > 5% (5 min)
    - Database unavailable (2 min)
    - Payment processing failed (3 consecutive failures)
    - Unauthorized access attempt (5 in 10 min)
  
  - **SEV-2 (page within 15 min):**
    - Error rate > 1% (10 min)
    - P99 latency > 2s (10 min)
    - High CPU usage > 80% (5 min)
    - Failed transfer queue growing
  
  - **SEV-3 (notify next day):**
    - Balance reconciliation discrepancy
    - Unused dependencies
    - Log storage quota near limit

- [ ] Escalation procedure
  - Page on-call engineer
  - Auto-escalate to manager if not acknowledged (15 min)
  - Auto-escalate to VP if not resolved (30 min)

- [ ] Incident response automation
  - Auto-create incident ticket
  - Auto-notify #incidents Slack channel
  - Auto-gather context (recent errors, metrics, logs)

**Effort:** 40 hours

---

**C3 Completion Criteria:**
- [ ] All logs aggregated and searchable
- [ ] Metrics collected and dashboards visible
- [ ] Alerting rules tested and on-call rotation active
- [ ] P99 latency < 500ms
- [ ] Error rate < 0.5% (baseline for health)

---

## Phase C4: Live Provider Integration (Weeks 7-10)

**Goal:** Switch from sandbox providers to live Plaid/provider APIs for real bank transfers.

**Duration:** 4 weeks  
**Effort:** 200+ hours (engineering) + provider integration

### C4.1: Plaid Transfer API Integration (US)

**Deliverables:**
- [ ] Plaid Transfer API setup
  - Create Plaid Transfer environment
  - Configure webhook for settlement events
  - Test with Plaid sandbox (verify B3.2b validation passes)

- [ ] Switch routing to live provider
  - `TransferProviderFactory` routes US/live → `PlaidTransferProvider`
  - `PlaidTransferProvider` implements all 7 methods
  - executeTransfer() calls Plaid API
  - Webhooks processed by B3.2b settlement executor

- [ ] Live transfer flow (USD)
  - Create intent
  - Review & confirm
  - Execute → Plaid processes ACH
  - Webhook → settled/failed/returned

- [ ] Canary deployment
  - 5% of US transfers → live
  - 95% remain sandbox
  - Monitor success rate & latency
  - Gradually increase to 100%

**Effort:** 80 hours

---

### C4.2: Canadian EFT Integration

**Deliverables:**
- [ ] Canadian EFT provider setup
  - Research providers (Payments Canada EFT, Wealthsimple for Business, etc.)
  - Setup integration with chosen provider
  - Configure webhook

- [ ] Switch routing for CA/live
  - `CanadianEFTProvider` implements all 7 methods
  - Test with provider sandbox
  - Gradual canary rollout (5% → 100%)

**Effort:** 60 hours

---

### C4.3: Provider Testing & Validation

**Deliverables:**
- [ ] Sandbox validation (repeats B3.2b but with live APIs)
  - All 8 settlement scenarios with real provider
  - All error cases with real provider
  - Provider timeout handling
  - Provider error handling

- [ ] Chaos testing
  - Provider timeout simulation
  - Provider 5xx response
  - Provider network partition
  - Webhook signature validation failure
  - Webhook delivery failure (no callback)

- [ ] Load testing with live provider
  - 100 concurrent transfers
  - Verify provider handles load
  - Measure settlement time (real)
  - Identify bottlenecks

**Effort:** 60 hours

---

### C4.4: Regulatory Compliance for Live Transfers

**Deliverables:**
- [ ] MSB licenses obtained (legal + regulatory team)
  - US state registrations complete
  - FINTRAC registration complete
  - Provincial registrations complete

- [ ] AML/KYC with live monitoring
  - Sanctions screening (OFAC, FATF, etc.)
  - Transaction monitoring (suspicious patterns)
  - High-value reporting (>$10k CTR, Canada >$10k aggregate)
  - SAR (Suspicious Activity Report) workflow

- [ ] Compliance audit
  - Third-party compliance audit
  - Verify all controls in place
  - Address audit findings

**Effort:** 120+ hours (legal + product)

---

**C4 Completion Criteria:**
- [ ] Live provider integration tested in sandbox
- [ ] Canary deployment at 50% of traffic, no increase in error rate
- [ ] MSB licenses in place
- [ ] AML/KYC monitoring active
- [ ] Compliance audit passed

---

## Phase C5: Production Pilot (Weeks 11-12)

**Goal:** Enable real money movement with careful monitoring and gradual user onboarding.

**Duration:** 2 weeks  
**Effort:** 40 hours (engineering)

### C5.1: Full Production Deployment

**Deliverables:**
- [ ] Go/no-go checklist
  - All C1-C4 criteria met? ✓
  - All alerts in place? ✓
  - Ops team trained and on-call? ✓
  - Rollback procedure tested? ✓
  - Incident response playbook reviewed? ✓

- [ ] Gradual user onboarding
  - Week 1: Internal team (10 users) — $100 transfers
  - Week 2: Trusted testers (50 users) — up to $1000 transfers
  - Week 3: Open to public with velocity limits ($500/day initially)

- [ ] Continuous monitoring
  - On-call rotation 24/7
  - Daily reconciliation review
  - Weekly ops review meeting
  - Monthly compliance audit

**Effort:** 20 hours

---

### C5.2: Scaling & Optimization

**Deliverables:**
- [ ] Performance optimization based on prod load
  - Query optimization (if needed)
  - Caching layer (if needed)
  - Connection pool sizing (if needed)

- [ ] Velocity limit adjustments
  - Track user requests for increases
  - Implement tiered velocity (based on history)
  - Progressive velocity unlocking

**Effort:** 20 hours

---

**C5 Completion Criteria:**
- [ ] Real money transfers enabled for all users
- [ ] Zero compliance violations
- [ ] Error rate < 0.5%
- [ ] Settlement time < 2 business days (ACH/EFT)
- [ ] Revenue tracking (all transfers recorded)
- [ ] Daily reconciliation passing
- [ ] On-call team handling issues < 15 min resolution time

---

## Timeline Summary

```
Week 1-2:   C1 Validation & Hardening
  ├─ Regulatory assessment (LEGAL TEAM)
  ├─ Balance reconciliation
  ├─ Failure recovery (MVP)
  └─ Security hardening

Week 3-4:   C2 Operations Console
  ├─ Admin dashboard
  ├─ Monitoring dashboard
  └─ Training & runbooks

Week 5-6:   C3 Monitoring & Alerting
  ├─ Structured logging
  ├─ Metrics collection
  └─ Alert rules & escalation

Week 7-10:  C4 Live Provider Integration
  ├─ Plaid US integration
  ├─ Canadian EFT integration
  ├─ Sandbox validation
  └─ Compliance audit (LEGAL TEAM)

Week 11-12: C5 Production Pilot
  ├─ Go/no-go checklist
  ├─ Gradual user onboarding
  └─ Scaling & optimization
```

**Total: 12 weeks, 1,532+ engineering hours + legal + regulatory**

---

## Parallel Workstreams

These can run in parallel with engineering phases:

1. **Legal/Regulatory (Weeks 1-10)**
   - MSB licensing applications
   - Regulatory documentation
   - Compliance audit
   - AML/KYC vendor selection & integration

2. **Infrastructure (Weeks 1-6)**
   - Datadog/LogRocket setup
   - PagerDuty/Opsgenie setup
   - Redis cache setup (if needed for C11)
   - Third-party monitoring setup

3. **Testing (Weeks 1-12)**
   - Write automated tests in parallel
   - Load testing in Week 6
   - Security testing in Week 5

---

## Success Metrics (Exit Criteria)

### Financial Safety ✅
- Zero balance discrepancies (daily reconciliation)
- 100% ledger-to-balance match
- FX rates auditable (logged at transaction time)

### Operational Excellence ✅
- Alert response time < 15 minutes
- Incident resolution time < 1 hour
- 99.5% uptime (SLA)
- 0% financial data loss

### Regulatory Compliance ✅
- All MSB licenses in place
- AML/KYC monitoring active
- All reporting completed (CTR, SAR, etc.)
- Third-party audit passed

### Customer Experience ✅
- P99 API latency < 500ms
- Error rate < 0.5%
- Settlement time < 2 business days
- Zero unauthorized transactions

---

