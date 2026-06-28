# Production Readiness Backlog — Prioritized Tasks

**Last Updated:** 2026-06-28  
**Total Effort:** 1,532+ hours  
**Target:** Ship Phase C1-C2 in 4 weeks, C3-C4 in 8 weeks, C5 in 12 weeks

---

## CRITICAL (Ship before any real money movement)

**Definition:** Blocks production launch. Must complete before enabling real transfers.

**Total Effort:** 500+ hours

### C-001: Regulatory Licensing Assessment
**Effort:** 60+ hours (external legal)  
**Phase:** C1  
**Description:** Determine MSB licensing requirements for US and Canada. Identify costs, timelines, and compliance obligations.  
**Acceptance Criteria:**
- [ ] Licensing requirements document for all target jurisdictions
- [ ] Cost estimate and timeline
- [ ] Licensing applications submitted or scheduled
- [ ] Internal compliance team assigned

**Dependencies:** None (must start immediately)  
**Owner:** Legal team (Compliance/Regulatory counsel)  

---

### C-002: Daily Balance Reconciliation Service
**Effort:** 40 hours  
**Phase:** C1  
**Description:** Build automated daily balance-to-ledger reconciliation. Detect and alert on discrepancies.  
**Acceptance Criteria:**
- [ ] Reconciliation script runs daily at midnight UTC
- [ ] Reports all discrepancies (balance_X != sum(ledger_entries))
- [ ] Stores audit log of reconciliations
- [ ] Email alerts ops on discrepancies
- [ ] Zero discrepancies for 7 days in staging

**Dependencies:** Existing ledger and balance data  
**Owner:** Platform engineer

---

### C-003: FX Rate Audit Logging
**Effort:** 16 hours  
**Phase:** C1  
**Description:** Log every FX quote (rate, amount, timestamp, source). Enables audit trail for cross-border transfers.  
**Acceptance Criteria:**
- [ ] FX quotes logged to `fx_quotes` table
- [ ] Every transfer includes FX quote ID
- [ ] `GET /api/admin/transfer/{id}/fx-audit` shows rate history
- [ ] Rate drift detectable from logs

**Dependencies:** None  
**Owner:** Platform engineer

---

### C-004: Transfer Timeout & Recovery
**Effort:** 24 hours  
**Phase:** C1  
**Description:** Identify transfers in processing state > 7 days. Provide manual recovery workflow.  
**Acceptance Criteria:**
- [ ] Scheduled job identifies stale transfers
- [ ] Alert created with transfer details
- [ ] Admin can move transfer to settled/failed/cancelled
- [ ] Audit log shows who forced state change and reason

**Dependencies:** Scheduled jobs infrastructure  
**Owner:** Platform engineer

---

### C-005: Dead-Letter Queue for Webhooks
**Effort:** 20 hours  
**Phase:** C1  
**Description:** Store failed webhooks in separate table. Enable manual reprocessing.  
**Acceptance Criteria:**
- [ ] Failed webhooks stored in `webhook_dlq` table
- [ ] Admin endpoint to list/filter DLQ events
- [ ] Admin endpoint to reprocess single event
- [ ] Exponential backoff on auto-retry (future)

**Dependencies:** Admin tooling partially  
**Owner:** Platform engineer

---

### C-006: Rate Limiting Implementation
**Effort:** 24 hours  
**Phase:** C1  
**Description:** Per-user, per-endpoint, and per-IP rate limits to prevent abuse.  
**Acceptance Criteria:**
- [ ] Per-user: 100 requests/minute
- [ ] Per-endpoint: transfers 10/hour, login 5/hour
- [ ] Per-IP: 1000 requests/minute
- [ ] Rate limit exceeded returns 429 with retry-after header
- [ ] Rate limits configurable without deploy

**Dependencies:** None  
**Owner:** Platform engineer

---

### C-007: Admin Dashboard — User Lookup & Balance
**Effort:** 32 hours  
**Phase:** C2  
**Description:** Admin dashboard to search users and view/edit balance and KYC status.  
**Acceptance Criteria:**
- [ ] Search users by email, ID, phone
- [ ] View balance (both currencies)
- [ ] View KYC status and documents
- [ ] Edit KYC status (approved/rejected/pending)
- [ ] All actions audit-logged
- [ ] Protected by MFA + IP whitelist

**Dependencies:** C-004 (admin API foundation)  
**Owner:** Full-stack engineer

---

### C-008: Transfer Operations Tooling
**Effort:** 24 hours  
**Phase:** C2  
**Description:** Admin tools to view, settle, refund, or cancel transfers.  
**Acceptance Criteria:**
- [ ] Search transfers by ID, status, user, date range
- [ ] View transfer details (both parties, provider, status, ledger)
- [ ] Manual settlement (processing → settled, with approval)
- [ ] Manual refund (create reversal ledger entries)
- [ ] Cancellation (draft/ready only)
- [ ] All actions require justification + audit logged

**Dependencies:** C-007, failure recovery tools  
**Owner:** Full-stack engineer

---

### C-009: Structured Logging & Aggregation
**Effort:** 64 hours  
**Phase:** C3  
**Description:** JSON logging + centralized log aggregation (Datadog/LogRocket).  
**Acceptance Criteria:**
- [ ] All console.log converted to structured format
- [ ] Correlation IDs on every request
- [ ] All logs sent to Datadog (or chosen vendor)
- [ ] Searchable by timestamp, user, request ID, endpoint
- [ ] Retention: 30 days (audit), 7 days (debug)
- [ ] Cost ~$500-2000/month budgeted

**Dependencies:** Choice of log vendor (external)  
**Owner:** Platform engineer

---

### C-010: Alert Rules & Escalation
**Effort:** 40 hours  
**Phase:** C3  
**Description:** PagerDuty/Opsgenie alerts for SEV-1/2/3 incidents with escalation.  
**Acceptance Criteria:**
- [ ] SEV-1 rules (error rate >5%, DB down, payment failures)
- [ ] SEV-2 rules (error rate >1%, P99 latency >2s)
- [ ] SEV-3 rules (balance discrepancy, unused deps)
- [ ] Page on-call engineer (15 min escalation to manager)
- [ ] Auto-create incident ticket + notify #incidents
- [ ] On-call rotation active and tested

**Dependencies:** Monitoring dashboard, logging aggregation  
**Owner:** DevOps / Platform engineer

---

### C-011: Incident Response Playbooks
**Effort:** 20 hours  
**Phase:** C1-C2  
**Description:** Document runbooks for common incidents and train ops team.  
**Acceptance Criteria:**
- [ ] Runbook: Resolve stuck transfer
- [ ] Runbook: Handle failed KYC
- [ ] Runbook: Balance discrepancy response
- [ ] Runbook: Data breach response
- [ ] Runbook: Provider API down
- [ ] Team training completed (all members signed off)
- [ ] Runbooks in shared wiki, accessible to on-call

**Dependencies:** Admin tooling, monitoring  
**Owner:** Ops manager + Platform team

---

### C-012: MSB License Applications (US & Canada)
**Effort:** 60+ hours (legal-led, product support)  
**Phase:** C1-C4  
**Description:** Complete and submit MSB licensing applications for all target jurisdictions.  
**Acceptance Criteria:**
- [ ] FINTRAC registration (Canada) submitted/approved
- [ ] State registrations (US) submitted/approved (or exempted)
- [ ] Provincial registrations (Canada) submitted/approved
- [ ] Licenses tracked in compliance dashboard
- [ ] Renewal reminders set up
- [ ] Feature access mapped to license status

**Dependencies:** Regulatory assessment (C-001)  
**Owner:** Legal team, Compliance officer  

---

## HIGH (Complete in Phase C1-C3, before C4)

**Definition:** Important for production but not blocking (can be mitigated). Significant risk if missing.

**Total Effort:** 450+ hours

### H-001: Metrics Collection & Dashboards
**Effort:** 56 hours  
**Phase:** C3  
**Description:** Prometheus metrics + Grafana dashboards for observability.  
**Acceptance Criteria:**
- [ ] Request metrics (count, latency p50/p95/p99)
- [ ] Error metrics (count by status, by endpoint)
- [ ] Business metrics (transfers, users, revenue)
- [ ] Database metrics (query count, latency, pool utilization)
- [ ] Dashboards: operations, performance, business health
- [ ] All metrics queryable for 30 days

**Dependencies:** Application instrumentation  
**Owner:** Platform engineer

---

### H-002: Performance Testing & Baselines
**Effort:** 44 hours  
**Phase:** C3  
**Description:** Load test with 100+ concurrent users. Establish performance baselines and SLOs.  
**Acceptance Criteria:**
- [ ] k6/JMeter load tests for critical flows
- [ ] Sustained 100 concurrent users
- [ ] P99 latency baseline established (target: <500ms)
- [ ] Error rate baseline (target: <0.5%)
- [ ] Database query performance profiled
- [ ] Bottlenecks identified and prioritized

**Dependencies:** Staging environment, production monitoring setup  
**Owner:** Platform engineer

---

### H-003: AML/KYC Vendor Integration
**Effort:** 40 hours  
**Phase:** C1-C4  
**Description:** Integrate 3rd-party AML/KYC service (sanctions screening, transaction monitoring).  
**Acceptance Criteria:**
- [ ] Vendor selected (cost-benefit analysis)
- [ ] Integration complete (API calls + webhook callbacks)
- [ ] Sanctions screening on KYC (blocks flagged users)
- [ ] Transaction monitoring active (alerts on suspicious patterns)
- [ ] High-value reporting automated (>$10k CTR, Canada >$10k aggregate)
- [ ] Reports integrated into admin dashboard
- [ ] Cost ~$5k-20k/month budgeted

**Dependencies:** Regulatory framework (C-001), Admin dashboard (C-007)  
**Owner:** Compliance team + Platform engineer

---

### H-004: Testing Infrastructure & Test Suite
**Effort:** 80 hours  
**Phase:** C1-C3  
**Description:** Unit tests, integration tests, E2E tests, and CI/CD gates.  
**Acceptance Criteria:**
- [ ] Jest/Vitest setup with >70% code coverage
- [ ] Unit tests for: balance logic, FX conversion, state transitions
- [ ] Integration tests for: API endpoints, webhook processing
- [ ] E2E tests for: auth, transfers, KYC, recovery scenarios
- [ ] Load tests for critical paths
- [ ] CI/CD gate: tests must pass before merge
- [ ] Automated security scanning (SAST)

**Dependencies:** Testing frameworks (should exist)  
**Owner:** QA engineer + Platform team

---

### H-005: Database Backup & Restore Testing
**Effort:** 16 hours  
**Phase:** C2  
**Description:** Document and test backup/restore procedures. Define RTO/RPO.  
**Acceptance Criteria:**
- [ ] RTO target: 1 hour (max downtime before restore complete)
- [ ] RPO target: 1 hour (max data loss, 1hr of transactions)
- [ ] Backup testing: monthly restore drill
- [ ] Restore procedure documented and tested
- [ ] Automated backup verification
- [ ] Off-site backup copy (geographically separate)

**Dependencies:** Supabase backup infrastructure  
**Owner:** DevOps engineer

---

### H-006: Security Audit (3rd Party)
**Effort:** 24 hours (internal coordination + 3rd party cost)  
**Phase:** C3-C4  
**Description:** Third-party security audit (OWASP, penetration testing).  
**Acceptance Criteria:**
- [ ] Vendor selected and SOW agreed
- [ ] No critical vulnerabilities (CVSS >7.0)
- [ ] All high vulnerabilities fixed before launch
- [ ] Audit report archived (compliance)
- [ ] Cost ~$5k-15k budgeted

**Dependencies:** Security hardening (C-001-C-006)  
**Owner:** Security team + DevOps

---

### H-007: Ops Team Training & Certification
**Effort:** 20 hours  
**Phase:** C2-C3  
**Description:** Comprehensive training for ops team on systems, dashboards, runbooks, and incident response.  
**Acceptance Criteria:**
- [ ] All team members pass system architecture quiz
- [ ] Dashboard walkthrough completed
- [ ] Runbook exercises completed (pass/fail)
- [ ] Simulated incident response (SEV-1, SEV-2)
- [ ] On-call rotation set up and tested
- [ ] Escalation procedure practiced

**Dependencies:** Dashboards, runbooks, monitoring  
**Owner:** Ops manager + Platform lead

---

### H-008: Provider API Contract Testing
**Effort:** 32 hours  
**Phase:** C4  
**Description:** Test integration with Plaid and Canadian EFT providers. Validate contracts.  
**Acceptance Criteria:**
- [ ] Plaid Transfer API integration tested (create, execute, webhooks)
- [ ] Canadian EFT integration tested
- [ ] All error scenarios tested (timeout, invalid account, etc.)
- [ ] Webhook signature validation tested
- [ ] Provider rate limits validated (no account bans)
- [ ] Fallback behavior on provider down (graceful degradation)

**Dependencies:** Live provider integration (C4.1, C4.2)  
**Owner:** Platform engineer

---

### H-009: Regulatory Compliance Audit (3rd Party)
**Effort:** 40 hours (internal coordination + audit cost)  
**Phase:** C4  
**Description:** Third-party compliance audit (regulatory readiness for real money).  
**Acceptance Criteria:**
- [ ] Audit scope: AML/KYC, data privacy, transaction reporting, record keeping
- [ ] All high-risk findings remediated
- [ ] Audit report approved (passed)
- [ ] Report archived
- [ ] Cost ~$10k-30k budgeted

**Dependencies:** All compliance systems in place (C-001-C-004, H-003)  
**Owner:** Compliance officer + Legal team

---

### H-010: Canary Deployment Procedure
**Effort:** 20 hours  
**Phase:** C4  
**Description:** Define and test gradual rollout process (5% → 25% → 100%).  
**Acceptance Criteria:**
- [ ] Feature flags for provider routing
- [ ] Monitoring alerts for canary phase
- [ ] Rollback procedure tested
- [ ] Success criteria defined (error rate threshold, latency threshold)
- [ ] Process documented for future rollouts

**Dependencies:** Live provider integration, monitoring  
**Owner:** DevOps + Platform lead

---

## MEDIUM (Complete in Phase C3-C5)

**Definition:** Improves production safety and operations but not critical for launch. Can be deferred to post-launch.

**Total Effort:** 350+ hours

### M-001: Advanced Failure Recovery (Auto-Retry)
**Effort:** 24 hours  
**Phase:** C5+  
**Description:** Automatic exponential backoff for webhook reprocessing.  
**Acceptance Criteria:**
- [ ] Dead-letter events retried automatically
- [ ] Exponential backoff: 1min, 5min, 15min, 1hour, 1day
- [ ] Max 3 retries, then alert ops
- [ ] Idempotency prevents duplicate effects
- [ ] Metrics on retry success rate

**Dependencies:** Dead-letter queue (C-005)  
**Owner:** Platform engineer

---

### M-002: Balance Correction Workflow (Approval)
**Effort:** 16 hours  
**Phase:** C2-C3  
**Description:** Two-person approval required for balance adjustments.  
**Acceptance Criteria:**
- [ ] Admin initiates balance correction (amount, reason)
- [ ] Second approver confirms (different user)
- [ ] Correction creates double-entry ledger reversal
- [ ] Audit log immutable (who, what, when, why)
- [ ] Email notification to user (if adjustment affects them)

**Dependencies:** Admin tooling, approval workflow library  
**Owner:** Full-stack engineer

---

### M-003: Regulatory Reporting Automation
**Effort:** 32 hours  
**Phase:** C4-C5  
**Description:** Automated CTR and SAR reporting to FINTRAC (Canada) / FinCEN (US).  
**Acceptance Criteria:**
- [ ] CTR reporting for transfers >$10k (Canada)
- [ ] FinCEN CTR reporting for transfers >$10k (US)
- [ ] SAR generation for suspicious patterns
- [ ] Report generation weekly + on-demand
- [ ] Reports verified by compliance team before filing

**Dependencies:** AML/KYC integration (H-003), regulatory framework (C-001)  
**Owner:** Compliance team + Platform engineer

---

### M-004: Velocity Tier System
**Effort:** 20 hours  
**Phase:** C5+  
**Description:** Progressive velocity unlocking based on user history.  
**Acceptance Criteria:**
- [ ] Tier 1: $100/day (new users)
- [ ] Tier 2: $500/day (after 10 successful transfers)
- [ ] Tier 3: $2000/day (after KYC + 30 days history)
- [ ] Admin can manually increase tier
- [ ] Tier changes logged
- [ ] User notified of tier progression

**Dependencies:** KYC system, user history tracking  
**Owner:** Full-stack engineer

---

### M-005: Financial Reporting Dashboard
**Effort:** 24 hours  
**Phase:** C5+  
**Description:** Accounting/finance dashboard for daily settlement reporting.  
**Acceptance Criteria:**
- [ ] Daily transfer totals (by currency, by status)
- [ ] Revenue tracking (commission or spread, if applicable)
- [ ] Ledger balance verification report
- [ ] CSV export for accounting (trial balance)
- [ ] Monthly reconciliation checklist

**Dependencies:** Financial data model, reporting library  
**Owner:** Full-stack engineer

---

### M-006: PIPEDA/GDPR Data Privacy Framework
**Effort:** 32 hours  
**Phase:** C1-C3  
**Description:** Data privacy compliance (Canada PIPEDA, if applicable GDPR).  
**Acceptance Criteria:**
- [ ] Privacy policy (PIPEDA-compliant, in plain language)
- [ ] Data consent flow (sign-up, email consent)
- [ ] Right-to-be-forgotten endpoint (`DELETE /api/user/my-data`)
- [ ] Data portability endpoint (`GET /api/user/export-data`)
- [ ] Data retention policy (how long we keep inactive account data)
- [ ] Third-party service data handling (Plaid, Stripe, Wise)
- [ ] Audit log of data deletions/exports

**Dependencies:** User database, consent tracking  
**Owner:** Legal team + Full-stack engineer

---

### M-007: Provider API Circuit Breaker
**Effort:** 16 hours  
**Phase:** C4-C5  
**Description:** Circuit breaker pattern for provider APIs (Plaid, Canadian EFT).  
**Acceptance Criteria:**
- [ ] If provider fails >5 times in 10 min, circuit opens
- [ ] Requests fail-fast while circuit open (don't retry)
- [ ] Circuit closes after 5 min of success
- [ ] Metrics on circuit state (openings, duration)
- [ ] Fallback behavior when circuit open (graceful degradation)

**Dependencies:** Provider integration (C4.1, C4.2)  
**Owner:** Platform engineer

---

### M-008: Comprehensive E2E Test Suite
**Effort:** 32 hours  
**Phase:** C2-C3  
**Description:** E2E tests for all critical user journeys.  
**Acceptance Criteria:**
- [ ] Sign up → KYC → Transfer → Settlement (happy path)
- [ ] Cross-border transfer with FX
- [ ] Failed transfer recovery
- [ ] Request acceptance flow
- [ ] Velocity limit exceeded
- [ ] Provider error handling
- [ ] Webhook idempotency
- [ ] Tests run on every deploy

**Dependencies:** Testing infrastructure (H-004), staging environment  
**Owner:** QA engineer

---

## LOW (Complete in Phase C5+)

**Definition:** Nice-to-have operational improvements. Not critical for launch.

**Total Effort:** 150+ hours

### L-001: Advanced Alerting Rules
**Effort:** 16 hours  
**Phase:** C5+  
**Description:** ML-based anomaly detection for error rates, latency, transaction patterns.  
**Acceptance Criteria:**
- [ ] Baseline learning for 1 week
- [ ] Alert on 2-sigma deviation from baseline
- [ ] No false positives (tune sensitivity)
- [ ] Metrics on alert accuracy

**Dependencies:** Metrics collection (H-001)  
**Owner:** Data engineer / Platform engineer

---

### L-002: Customer Self-Service Recovery
**Effort:** 20 hours  
**Phase:** C5+  
**Description:** UI for customers to view transfer status and request help.  
**Acceptance Criteria:**
- [ ] `/transfers/[id]` shows detailed status
- [ ] Button to request help (creates ticket)
- [ ] Estimated settlement time (T+1 or T+2 business days)
- [ ] FAQ for common issues
- [ ] Live chat or email support widget

**Dependencies:** Admin tooling, support infrastructure  
**Owner:** Full-stack engineer

---

### L-003: Provider Dashboard Integration
**Effort:** 12 hours  
**Phase:** C5+  
**Description:** Admin dashboard integrated with provider dashboards (Plaid, Canadian EFT).  
**Acceptance Criteria:**
- [ ] Link to Plaid dashboard for US transfers
- [ ] Link to provider dashboard for CA transfers
- [ ] Transfer status sync from provider (manual refresh button)
- [ ] Transaction history from provider (if available)

**Dependencies:** Admin dashboard (C-007), provider APIs  
**Owner:** Full-stack engineer

---

### L-004: Scheduled Job Management UI
**Effort:** 16 hours  
**Phase:** C5+  
**Description:** Dashboard to view/manage scheduled jobs (reconciliation, reporting, etc.).  
**Acceptance Criteria:**
- [ ] View all scheduled jobs (status, next run, last run)
- [ ] Manual trigger for any job
- [ ] Job logs (success/failure history)
- [ ] Disable/enable job without code deploy
- [ ] Metrics on job duration and success rate

**Dependencies:** Scheduled jobs infrastructure  
**Owner:** Full-stack engineer

---

### L-005: User Behavior Analytics
**Effort:** 20 hours  
**Phase:** C5+  
**Description:** Track user behaviors for fraud detection and UX improvement.  
**Acceptance Criteria:**
- [ ] Event tracking (view transfer, initiate transfer, confirm, etc.)
- [ ] Funnel analysis (how many users complete transfer flow)
- [ ] Cohort analysis (new user retention, repeat transfers)
- [ ] Behavioral anomalies (flag unusual patterns for fraud team)
- [ ] Opt-out mechanism for privacy-conscious users

**Dependencies:** Analytics library, privacy framework (M-006)  
**Owner:** Product analytics engineer

---

### L-006: Velocity Limit Request Workflow
**Effort:** 16 hours  
**Phase:** C5+  
**Description:** Self-service UI for users to request higher velocity limits.  
**Acceptance Criteria:**
- [ ] User submits request with reason
- [ ] Compliance team reviews (manual approval)
- [ ] Auto-approval for low-risk users (based on history)
- [ ] Notification when approved/rejected
- [ ] Audit log of all requests and approvals

**Dependencies:** Velocity system, user history tracking  
**Owner:** Full-stack engineer

---

### L-007: Batch Settlement Processing (Hourly)
**Effort:** 16 hours  
**Phase:** C5+  
**Description:** Batch process pending transfers hourly (vs. waiting for webhooks).  
**Acceptance Criteria:**
- [ ] Hourly job queries pending transfers
- [ ] Checks provider status for each (if provider supports batch query)
- [ ] Marks as settled if confirmed by provider
- [ ] Avoids duplicate-processing (idempotency key)
- [ ] Metrics on batch success rate

**Dependencies:** Provider APIs support batch query, webhook integration  
**Owner:** Platform engineer

---

### L-008: Compliance Dashboard
**Effort:** 12 hours  
**Phase:** C5+  
**Description:** Self-service compliance metrics for audits (report generation).  
**Acceptance Criteria:**
- [ ] Report: All transfers > $10k (for CTR filing)
- [ ] Report: Flagged transactions (AML/KYC)
- [ ] Report: Users by KYC status
- [ ] Report: Transaction volume (daily, monthly, year-to-date)
- [ ] Export to CSV (for filing with regulators)

**Dependencies:** Financial data model, AML/KYC system (H-003)  
**Owner:** Full-stack engineer

---

## Implementation Priority Order

**Weeks 1-2 (C1):** C-001 → C-002 → C-003 → C-004 → C-005 → C-006 → C-011  
**Weeks 3-4 (C2):** C-007 → C-008 → H-007  
**Weeks 5-6 (C3):** C-009 → C-010 → H-001 → H-004  
**Weeks 7-10 (C4):** C-012 → H-003 → H-008 → H-009 → H-010  
**Weeks 11-12 (C5):** Ship pilot + M-001 → M-003  

**Post-launch (C5+):** M-002 → M-004 → M-005 → H-002 → L-* (continuous improvement)

---

## Success Metrics

| Metric | Before | Target | 
|--------|--------|--------|
| Error rate | N/A | < 0.5% |
| P99 latency | N/A | < 500ms |
| Uptime SLA | N/A | 99.5% |
| Alert response time | N/A | < 15 min |
| Incident resolution | N/A | < 1 hour |
| Balance discrepancies | N/A | 0 (daily) |
| Settlement time | N/A | < 2 business days |
| Compliance violations | N/A | 0 |
| Unauthorized transactions | N/A | 0 |

---

**Total: 1,532+ hours, ~12 weeks, multiple teams**

