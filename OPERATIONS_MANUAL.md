# Manna Operations Manual

**Version:** 1.0  
**Last Updated:** June 2026  
**Classification:** Internal Use Only

---

## Executive Overview

### Purpose

The Operations Manual is the authoritative guide for operating the Manna platform in production. It defines the operational procedures, investigation methodologies, escalation paths, and decision-making frameworks that ensure Manna operates safely, reliably, and in compliance with all applicable regulations.

Operations is responsible for:

- **Financial Integrity** — Ensuring every dollar is properly accounted for and no customer money is lost
- **Customer Safety** — Protecting customer funds and ensuring timely resolution of issues
- **Compliance** — Maintaining adherence to all KYC, AML, and financial regulations
- **Incident Response** — Detecting and responding to operational issues before they impact customers
- **Investigation** — Thoroughly investigating customer issues and platform anomalies
- **Documentation** — Creating an auditable record of all operational actions

### Core Operational Principle

**The Operations Team never performs direct database changes.**

Every operational action must occur through one of:
1. Approved workflows in the Operations Console
2. Engineering-approved recovery procedures executed by engineers
3. Customer-initiated actions verified through the Manna platform

This principle ensures financial correctness, auditability, and accountability. If an operation cannot be completed through the Operations Console or approved procedures, it must be escalated to Engineering.

### Scope

This manual covers:

- Daily operational tasks
- Investigation methodologies for customer issues
- Settlement verification and reconciliation
- Ledger investigation and reconciliation
- Provider operations and failure modes
- Incident response and escalation
- Compliance and security operations
- Disaster recovery and business continuity

This manual does NOT cover:

- System architecture or design (see CLAUDE.md)
- API documentation (see API reference)
- Engineering procedures or deployment
- Developer onboarding or local setup
- Code review or software development

### Operational Philosophy

Manna's operational philosophy is built on five principles:

**1. Financial Correctness First**

Every decision prioritizes financial accuracy and customer fund safety. If uncertainty exists about balances, settlements, or ledger entries, we verify before taking action. A conservative operational approach is preferred to an aggressive one.

**2. Customer Safety First**

Customer funds are our primary concern. We respond quickly to transfer issues, KYC delays, or account access problems. Customer escalations are handled with urgency.

**3. Auditability**

Every operational action is logged, timestamped, and linked to the operator who performed it. We never take actions that cannot be audited or reversed.

**4. Least Privilege**

Operations staff have access only to the information and actions necessary for their role. Sensitive operations require explicit approval and documented justification.

**5. Escalate When Uncertain**

If an issue is unclear, potentially involves data corruption, or requires database modification, we escalate to Engineering immediately rather than attempting an uncertain fix.

---

## 1. Operational Principles and Policies

### 1.1 Authority and Responsibility

**Operations Authority:**

Operations staff are authorized to:
- View all operational dashboards and logs
- Investigate customer issues within the Operations Console
- Access KYC, AML, and compliance records
- Generate reports and analytics
- Initiate customer communications about known issues
- Mark provider events as acknowledged
- Create internal notes on customer records
- Suspend accounts for fraud/abuse (with approval)
- Approve KYC documents
- Reject KYC documents with documented reasons
- Escalate to Engineering

**Operations Limitations:**

Operations staff are NOT authorized to:
- Modify customer balances directly
- Edit ledger entries
- Bypass KYC requirements
- Ignore AML alerts without investigation
- Force-settle transfers or transactions
- Delete records or audit logs
- Modify system configurations
- Access production databases directly
- Override settlement rules
- Create test transactions in production

### 1.2 Financial Correctness Standards

**Balance Verification:**

- Customer balances in the Operations Console reflect the single source of truth
- Balances are calculated from the immutable ledger, not stored separately
- Balance corrections never happen through direct edits; they happen through documented ledger entries
- If a customer reports a balance discrepancy, we reconcile using ledger entries, not by changing the balance
- Monthly reconciliation verifies total customer assets equal the sum of all customer balances

**Ledger Integrity:**

- The ledger is immutable; ledger entries are never deleted or modified
- All financial movement is recorded as ledger entries with full context
- Ledger entries reference the transaction or settlement that caused them
- Every ledger entry has an timestamp, operator, and audit trail
- Ledger corrections happen through reversal entries, not deletion

**Settlement Correctness:**

- Settlements follow the settlement engine's rules; no manual overrides
- Settlement state transitions are validated and audited
- Failed settlements are investigated; not re-forced without Engineering approval
- Provider references are verified before marking settlements as complete
- Cross-border FX rates are verified against the original quote

### 1.3 Incident-Driven Operations

Operations are primarily driven by incidents, customer issues, and provider anomalies. We do not proactively modify state without cause.

**Incident Categories:**

- **Customer Issue** — A customer reports a problem with their account, transfer, or KYC
- **Provider Event** — A webhook event fails, is missing, or is malformed
- **Anomaly** — An automated alert detects an unusual pattern
- **Compliance Alert** — AML, KYC, or regulatory check requires investigation
- **Audit Request** — Internal or external audit requires specific records

**Response Principle:**

For every incident, the response sequence is:
1. Verify the issue exists
2. Determine the root cause
3. Assess impact (SEV-1/2/3/4)
4. Decide: Can Operations resolve? Or does Engineering need to resolve?
5. Execute resolution (Operations or Engineering)
6. Verify the fix
7. Document the incident and resolution

### 1.4 Escalation Culture

Escalation is encouraged, not discouraged. Examples of when to escalate:

- A customer issue persists after two investigation attempts
- A settlement refuses to progress and we don't know why
- A ledger entry appears incorrect but we cannot explain it
- A provider's behavior changes unexpectedly
- A customer reports missing money and we cannot explain the ledger
- An AML alert involves significant amounts or patterns we don't recognize
- A refund or balance correction would require ledger manipulation

Escalation is **not** a failure; it is the correct operational response when a situation exceeds our authority or understanding.

---

## 2. Operations Console Overview

The Operations Console is the primary interface for all operational activities. It provides secure, audited access to customer data, settlement information, ledger records, and system logs.

### 2.1 Console Architecture

The Operations Console is built on:

- **RBAC (Role-Based Access Control)** — Access to features and data depends on role
- **Audit Logging** — Every action is logged with operator identity, timestamp, and details
- **Correlation ID Tracking** — All related requests across settlement lifecycle use correlation IDs
- **Read-Only by Default** — Most operations are investigation and read-only
- **Explicit Approval** — Sensitive actions (KYC rejection, account suspension) require confirmation

### 2.2 Dashboard (Operations Home)

The Dashboard provides an at-a-glance view of platform health and key metrics.

**Key Metrics Displayed:**

- **Total Transfers (24hr)** — Count of all transfer intents created in the last 24 hours
- **Total Webhooks (24hr)** — Count of all provider webhook events received
- **Audit Events (24hr)** — Count of operational actions performed
- **Success Rate** — Percentage of audit events that succeeded

**Sections:**

**Recent Transfers**
- Shows the 5 most recent transfer intents
- Displays ID, status, amount, currency, created date
- Click to view full transfer details
- Identifies stuck or failed transfers

**Your Activity**
- Shows your recent operational actions
- Timestamp, action, resource type, success/failure
- Duration of the operation
- Useful for personal audit trail review

**Audit Summary**
- Total operational actions performed (all-time)
- Success count and failure count
- Success rate percentage
- Helps identify operational trends

**Expected Daily Review:**

Morning operations should begin with a Dashboard review to identify any overnight issues, failed webhooks, or pending transfers that need attention.

### 2.3 Users (Admin User Management)

The Users page shows all administrative users with access to the Operations Console.

**Columns:**

- **Name** — Full name of the admin
- **Email** — Email address and contact method
- **Role** — Admin role (SuperAdmin, OperationsManager, OperationsAnalyst, etc.)
- **Status** — Active or inactive
- **Last Login** — When the user last accessed the console

**Current Features:**

- View all admin users and their roles
- See when each user last logged in
- Identify users who may need account refresh

**Future Features:**

- Role management
- Permission adjustments
- User deactivation

### 2.4 Transfers (Transfer Intent Investigation)

The Transfers page is the primary interface for investigating transfer issues.

**Search and Filter:**

- **Status** — All, Draft, Ready, Processing, Settled, Failed
- **Provider** — Filter by provider (Plaid, Sandbox, Canadian EFT, etc.)
- **Correlation ID** — Search by correlation ID to trace full flow

**Columns:**

- **ID** — Transfer intent ID
- **User** — Customer ID or username
- **Amount** — Amount and currency
- **Status** — Current status with color coding
- **Provider** — Provider handling the transfer
- **Correlation ID** — Clickable badge linking to full trace
- **Date** — Creation date

**Status Colors:**

- **Green (Settled)** — Transfer completed successfully
- **Red (Failed)** — Transfer failed; investigation recommended
- **Yellow (Processing)** — Transfer in progress; waiting on provider
- **Gray (Draft/Ready)** — Transfer not yet confirmed or submitted

**Detail View:**

Click on any transfer to see:

- Transfer ID
- User ID
- Amount and currency
- Current status
- Provider name
- Creation date and time
- Correlation ID (linked to full trace)
- Full audit trail of state transitions

**Investigation Workflow:**

When a customer reports a transfer issue:

1. Search for the transfer by ID or correlation ID
2. View the transfer detail to understand current state
3. Check status transitions in the audit trail
4. For failed transfers, review the provider event that caused the failure
5. For stuck transfers, check if provider webhooks are being received
6. Click correlation ID to trace all related events
7. If unclear, escalate to Engineering with the correlation ID

**Common Scenarios:**

**Transfer Stuck in Processing**
- Check the most recent provider event in the trace
- Verify webhook status (was it received?)
- Check if provider returned an error
- If webhook is recent but status unchanged, escalate to Engineering

**Transfer Marked Failed**
- View the provider event that caused the failure
- Verify the provider's error message is recorded
- Contact customer with the specific error
- Determine if customer can retry or if issue is permanent
- If refund needed, escalate to Engineering for ledger adjustment

**Transfer Never Appeared**
- Search by correlation ID to find if it exists
- If not found, customer may not have completed transfer flow
- Guide customer to re-attempt
- If transfer created but deleted, escalate to Engineering

### 2.5 Ledger (Financial Ledger Investigation)

The Ledger page shows all financial transactions and balance movements.

**Search and Filter:**

- **Currency** — Filter by USD or CAD
- Results show entries for the selected currency

**Columns:**

- **User ID** — Customer whose ledger is affected
- **Type** — Ledger entry type (seed_balance, transfer_debit, transfer_credit, settlement, etc.)
- **Currency** — Currency of the amount
- **Debit** — Amount removed from user's account (shows "-" if credit)
- **Credit** — Amount added to user's account (shows "-" if debit)
- **Date** — Timestamp of the ledger entry

**Data Accuracy:**

- Ledger entries are immutable; they are never deleted or modified
- Every entry includes full context (linked transaction, operator, timestamp)
- Ledger balance for a user = sum of all that user's ledger entries
- Daily reconciliation verifies ledger totals match customer expectations

**Investigation Workflow:**

When a customer reports a balance discrepancy:

1. Ask the customer what balance they expect
2. Calculate the ledger balance by filtering their entries
3. Compare ledger balance to the balance shown in the customer's account
4. If they match, the discrepancy is in customer's expectation; explain each entry
5. If they don't match, ledger is source of truth; investigate what's missing
6. Trace each entry back to the transaction or settlement
7. If an entry is missing, lost, or incorrect, escalate to Engineering

**Common Scenarios:**

**Customer Says They Lost Money**
- Calculate ledger balance for their account
- Show them each debit and credit in chronological order
- Verify each debit matches a transfer they initiated
- If a debit exists they didn't initiate, investigate as potential fraud
- If ledger is correct but customer disputes, escalate to Compliance

**Balance Shows Amount Customer Didn't Spend**
- Verify all ledger entries are accounted for
- Check for failed transfers (debits without corresponding credits)
- Check for pending settlements (transfers not yet settled)
- If entry exists without explanation, escalate to Engineering

**Duplicate Ledger Entries**
- If two identical entries exist on the same day, this is unusual
- Verify via provider webhook if settlement created duplicate
- Check settlement state to see if both are marked complete
- Escalate to Engineering for ledger correction

### 2.6 Settlement (Cross-Border Settlement Tracking)

The Settlement page shows all cross-border transfers and FX settlements.

**Search and Filter:**

No filter currently; shows all settlements with pagination

**Columns:**

- **ID** — Settlement transaction ID
- **User ID** — Customer initiating the transfer
- **Recipient ID** — Customer receiving the transfer
- **Amount** — Amount and currency
- **Status** — Settlement state
- **Date** — Creation date

**Settlement States:**

- **Draft** — Customer started but didn't complete the transfer flow
- **Reviewed** — Customer reviewed and accepted FX rate
- **Confirmed** — Customer confirmed; ready for processing
- **Processing** — Provider is processing the transfer
- **Settled** — Provider confirmed completion; funds transferred
- **Failed** — Provider reported failure; settlement did not complete
- **Returned** — Provider reversed a completed settlement

**Investigation Workflow:**

Settlements follow a structured lifecycle. To investigate a settlement:

1. Find the settlement by ID or correlation ID
2. View the current status and creation date
3. Note how long the settlement has been in current status
4. Check if the status matches expected timeline:
   - Draft → Reviewed: Usually immediate (customer reviews screen)
   - Reviewed → Confirmed: Usually immediate (customer clicks confirm)
   - Confirmed → Processing: Should begin within seconds to minutes
   - Processing → Settled: Depends on provider; typically hours
   - Processing → Failed: Can happen anytime during processing

5. If status is older than expected, investigate:
   - For stuck Processing: Check provider webhook status
   - For stuck Confirmed: Check if processing started
   - For stuck Reviewed: Check if customer confirmed

6. If failed, review the provider event for error message
7. Contact customer with specific failure reason
8. For refunds or retries, escalate to Engineering

**FX Information:**

- Original FX rate shown at confirmation time
- Amount in sender's currency and recipient's currency
- Rate used for settlement recorded with full context
- If rate changed significantly since confirmation, escalate to Engineering

### 2.7 Provider Events (Webhook Event Investigation)

Provider Events show all webhook events received from external providers (Plaid, Canadian bank APIs, etc.).

**Search and Filter:**

- **Provider** — Filter by provider (Plaid, Sandbox, Canadian, etc.)
- **Event Type** — Filter by event type
- **Status** — Filter by processing status

**Columns:**

- **ID** — Webhook event ID
- **Provider** — Source provider
- **Event Type** — Type of event
- **Status** — Processing status (received, processed, failed)
- **Correlation ID** — Linked to original transfer/settlement
- **Date** — When event was received

**Event Status:**

- **Received** — Event arrived but processing hasn't started (unusual; should move to processed quickly)
- **Processed** — Event successfully processed and acted upon
- **Failed** — Event processing failed; requires investigation

**Webhook Deduplication:**

Manna uses provider event IDs to detect and skip duplicate webhooks. If the same event_id arrives twice, the second is ignored. This prevents double-crediting or double-debiting.

**Investigation Workflow:**

When a transfer seems stuck or settlement status doesn't match expectations:

1. Search for provider events matching the correlation ID
2. View the most recent event for the settlement
3. Check status (processed or failed?)
4. For failed events:
   - Note the error message
   - Determine if it's a transient error (retry) or permanent (escalate)
   - Contact customer with explanation
5. For missing events:
   - Check provider webhook status on provider's dashboard
   - Verify webhook endpoint is responding
   - If events are systematically missing, escalate to Engineering

**Common Scenarios:**

**Settlement Stuck in Processing, No Recent Webhook**
- Check the last webhook timestamp
- Compare to how long processing has been ongoing
- If no webhook for > 24 hours, provider may be delayed
- Contact provider support or escalate to Engineering

**Duplicate Event Received**
- Verify the event_id of both events
- If event_id is identical, system correctly deduped; no action needed
- If different event_ids but same transfer, investigate as potential double-processing

**Event Shows Error But Settlement Succeeded**
- Verify settlement status
- If settlement completed, error was likely recovered
- No customer action needed
- Document in internal notes

### 2.8 Webhooks (Webhook Delivery Tracking)

The Webhooks page shows all outbound webhooks sent to external systems (banks, payment providers, etc.).

**Search and Filter:**

- **Status** — Filter by status (pending, sent, failed, acknowledged)
- **Provider** — Filter by provider
- **Event Type** — Filter by event type

**Columns:**

- **ID** — Webhook ID
- **Provider** — Destination provider
- **Event Type** — Type of event
- **Status** — Delivery status
- **Retries** — Number of retry attempts
- **Correlation ID** — Linked to transfer/settlement
- **Date** — When webhook was sent

**Webhook Retry Mechanism:**

- Initial attempt: Immediately when event occurs
- First retry: 30 seconds
- Second retry: 5 minutes
- Third retry: 30 minutes
- Fourth retry: 2 hours
- After 4 retries: Marked as failed; manual intervention required

**Investigation Workflow:**

When a customer reports that a provider didn't receive an event:

1. Search for webhook by correlation ID
2. Check webhook status
3. For failed webhooks:
   - Note the error and timestamp
   - Verify provider webhook endpoint is correct
   - Check if provider's system is down
   - Contact provider support if endpoint is unreachable
4. For stuck webhooks:
   - Check how long it's been in current state
   - Verify network connectivity to provider
   - Escalate to Engineering if endpoint appears reachable but unresponsive

**Webhook Retry Wisdom:**

- If a webhook fails multiple times, retrying again will likely fail
- The issue is usually on the provider's end (down system, wrong endpoint, auth failure)
- Manual retry should only happen after the underlying issue is resolved
- We do not auto-retry after the retry limit is reached

### 2.9 Audit Logs (Operational Action History)

The Audit Logs page provides complete record of all operational actions taken by admin staff.

**Search and Filter:**

- **Action** — Filter by action type (e.g., "list_transfers")
- **Resource Type** — Filter by resource (e.g., "transfer", "user")
- **Status** — Filter by success/failure

**Columns:**

- **Admin** — Admin user who performed the action
- **Action** — What action was performed
- **Resource** — What resource was acted upon
- **Status** — Success or failure (with checkmark/X)
- **Duration (ms)** — How long the action took
- **Timestamp** — When the action was performed

**Summary Stats:**

- **Total Events** — Total actions ever performed
- **Success Rate** — Percentage of successful actions
- **Successful** — Count of successful actions
- **Failed** — Count of failed actions

**Audit Trail Accuracy:**

- Every console action is logged
- API calls made by Operations are logged
- User identity is verified and logged
- Timestamps are precise to the millisecond
- Audit logs are immutable; they cannot be deleted or modified

**Investigation Workflow:**

When an operational action needs to be verified:

1. Search for the specific action by action type
2. Filter by timestamp range if needed
3. View details: who, what, when, duration
4. For failed actions, review the error message
5. For unusual patterns, escalate to Security team

**Common Uses:**

- **Verify Action Occurred** — "Did someone reject a customer's KYC?" → Search for kyc_rejected action
- **Find Operator of an Action** — "Who processed this customer issue?" → Search timestamp range
- **Identify Failures** — "Are KYC approvals failing?" → Filter action type + status
- **Performance Review** — "Are operations slow?" → Check action durations

### 2.10 Global Search (Correlation ID Deep Linking)

The Global Search page allows searching across all resources by ID or correlation ID.

**Search Capabilities:**

- **Transfer ID** — Search for a specific transfer intent
- **Correlation ID** — Search all related events for a settlement
- **Webhook ID** — Find a specific webhook event
- **Provider Event ID** — Find a provider webhook event
- **Audit Log** — Find operational actions matching a query

**Search Results:**

Results show all matching resources with their status and metadata. Click any result to navigate directly to the detail page.

**Investigation Workflow:**

When investigating a settlement or transfer:

1. Get the correlation ID from the customer or from the transfer detail view
2. Paste the correlation ID into Global Search
3. View all related transfers, settlements, webhooks, and provider events
4. Understand the full lifecycle from one view
5. Identify where the issue occurred (settlement delay? webhook failure? provider error?)

**Trace Analysis:**

A complete trace shows:
- Original transfer intent creation
- Customer confirmation and review
- Settlement initiation
- Provider webhook events
- Webhook delivery attempts
- State transitions
- Any failures or errors
- Final settlement completion

This end-to-end view makes complex multi-step issues much easier to understand.

---

## 3. Daily Operations

### 3.1 Morning Operations Review

Operations should begin each day with a health check to identify any overnight issues.

**Morning Checklist (30 minutes):**

□ Log into Operations Console  
□ Review Dashboard overview  
□ Check for SEV-1 or SEV-2 incidents overnight  
□ Review failed transfers and webhooks  
□ Check provider status dashboard  
□ Scan audit logs for unusual patterns  
□ Review escalations from on-call engineer  
□ Prepare daily incident report  

**Specific Reviews:**

**Dashboard Review (5 min)**
- Are metrics reasonable for this time of day?
- Is success rate > 98%?
- Are there any obvious anomalies?

**Transfer Status Check (5 min)**
- Filter transfers by status = Failed
- How many failed overnight? (Normal: 0-2, concerning: >5)
- Are failures related to a specific provider?
- Do they need customer outreach?

**Webhook Status Check (5 min)**
- Filter webhooks by status = Failed
- Which providers had delivery failures?
- Are any webhooks still failing after retries?
- Do they need manual retry or escalation?

**Provider Status Check (5 min)**
- Check known provider status pages
- Are there any maintenance windows?
- Any unusual processing delays?
- Any provider-wide failures?

**Escalations Review (5 min)**
- Are there any engineering escalations pending response?
- Do any require urgent action?
- Should any be escalated higher?

**Reporting (5 min)**
- Prepare brief daily incident report
- Summarize any issues found
- List actions taken or escalated
- Flag any recurring issues

If any findings require investigation, document and escalate before starting routine work.

### 3.2 Settlement Review

Settlements are reviewed throughout the day to ensure FX transactions are progressing normally.

**Settlement Timeline Expectations:**

- **Draft → Reviewed:** Immediate (customer interaction on app)
- **Reviewed → Confirmed:** Immediate (customer interaction on app)
- **Confirmed → Processing:** < 1 minute (system should begin processing immediately)
- **Processing → Settled:** 2-6 hours (depends on provider SLA)
- **Processing → Failed:** Can occur at any time

**Daily Settlement Review (15 minutes):**

1. View the Settlements page
2. Sort by status = Processing
3. Check the oldest settlement in Processing
4. If created > 6 hours ago:
   - Check the most recent provider event
   - Is it recent (< 30 min) or stale (> 2 hours)?
   - Recent events with old status: provider is processing; wait
   - Stale events: provider may be stuck; investigate
5. Check settlements marked Failed
6. Have customers been contacted about failures?
7. Do any failures indicate a provider-wide issue?

**When to Escalate:**

- Settlement in Processing for > 12 hours → Escalate
- Multiple simultaneous failures → Escalate
- Provider reporting errors different from usual → Escalate
- Settlement status doesn't match provider webhook status → Escalate

### 3.3 Webhook Delivery Review

Webhooks are critical for keeping providers in sync. Daily review ensures delivery is working.

**Webhook Review (10 minutes):**

1. Filter webhooks by status = Failed
2. Group failures by provider
3. Note how many failures per provider
4. Check error messages:
   - Network timeout? → Provider may be slow
   - Auth failure? → Credentials may be wrong
   - Endpoint not found? → Configuration issue
   - Rate limit? → Provider throttling us

5. For each failed webhook:
   - Check retry count (how many times already retried?)
   - Is it after the 4-retry limit?
   - If still retrying, wait before manual intervention
   - If past retry limit, escalate for potential manual retry

**Provider-Wide Issues:**

If a provider has >10 webhook failures, especially with same error:
- Check provider status page
- Try pinging provider API from personal device
- Contact provider support
- Escalate to Engineering

### 3.4 Provider Health Monitoring

Each provider is monitored for signs of degradation or failures.

**Provider Health Indicators:**

For each provider, track:

**Plaid (ACH Transfers)**
- Webhook delivery success rate
- Settlement completion time (average)
- Error rate on new settlements
- Response time for API calls

**Stripe (KYC/Customer Verification)**
- KYC document approval time
- Rejection rate (should be <5% of submissions)
- API error rate
- Verification webhook delivery

**Canadian EFT (Domestic CA Transfers)**
- Settlement completion time
- Error rate
- Webhook delivery reliability
- Webhook arrival latency

**Health Thresholds:**

- Success rate < 95% → Investigate
- Average settlement time > 8 hours → Investigate
- More than 1 failed webhook → Monitor closely
- Outage > 15 minutes → Escalate immediately

### 3.5 Balance Reconciliation

Daily balance reconciliation verifies that customer balances are correct.

**Reconciliation Process (30 minutes):**

1. In Ledger page, filter by USD
2. Manually sum all ledger credits (additions)
3. Manually sum all ledger debits (subtractions)
4. Note: Total Balances (USD) = all credits - all debits
5. Verify this matches the reported total
6. Repeat for CAD

**For each currency:**
- Total credits: ________
- Total debits: ________
- Expected total balances: ________ (credits - debits)
- Actual reported total: ________
- **Variance:** If actual ≠ expected, ledger is out of balance

**If Variance Exists:**

1. Identify the discrepancy amount
2. Look for recent unusual ledger entries
3. Check for double-credited transfers
4. Look for missing settlement entries
5. Escalate to Engineering immediately with variance amount and affected accounts

**Monthly Reconciliation (Monthly, 1-2 hours):**

Monthly reconciliation is more detailed:

1. Export all ledger entries for the month
2. For each account, calculate opening balance
3. Add all credits for the month
4. Subtract all debits for the month
5. Verify result matches current balance
6. Identify any accounts with discrepancies
7. Investigate each discrepancy
8. Generate monthly reconciliation report

### 3.6 Failed Event Investigation

Failed transfers and settlements require investigation to understand root causes and customer impact.

**When to Investigate:**

- Any transfer marked Failed
- Any webhook marked Failed after all retries
- Any settlement that didn't complete within expected timeframe
- Any customer complaint about a missing or failed transfer

**Investigation Workflow:**

1. Locate the failed resource (transfer, settlement, webhook)
2. Get the correlation ID
3. Use Global Search to find all related events
4. Understand the sequence:
   - What state was it in when it failed?
   - What was the last provider event?
   - What error was reported?
5. Determine category:
   - **Transient error** (network timeout, rate limit) → Can retry
   - **Customer error** (insufficient funds, invalid account) → Contact customer
   - **Provider error** (API broken, new failure mode) → Escalate
   - **System error** (unknown, unexpected) → Escalate to Engineering

6. Take appropriate action:
   - Transient: Manual retry (if past auto-retry limit)
   - Customer error: Contact customer with reason
   - Provider error: Escalate and document workaround
   - System error: Escalate to Engineering

### 3.7 Customer Escalations

Customer support may escalate issues to Operations for investigation. The triage process:

**Escalation Triage (5 minutes per escalation):**

1. Read the customer issue description
2. Note the customer ID, transfer/settlement ID, or correlation ID
3. Determine issue category:
   - **Transfer Issue** → Go to Transfers page
   - **Balance Issue** → Go to Ledger page
   - **KYC Issue** → Go to user details
   - **Settlement Issue** → Go to Settlements page

4. Perform quick investigation (5 min)
5. Categorize response:
   - **Can answer immediately** → Respond to support with findings
   - **Needs escalation** → Escalate to Engineering with findings
   - **Needs customer action** → Respond with instructions (password reset, resubmit doc, etc.)
   - **Fraud concern** → Escalate to Compliance immediately

**Common Issues and Quick Responses:**

| Issue | Quick Check | Response |
|-------|------------|----------|
| Transfer not showing up | Search by ID or correlation ID | Transfer likely never created; guide customer through flow again |
| Transfer stuck for hours | View status and recent provider events | If stuck in Confirmed, likely app crash; have customer retry |
| Balance lower than expected | Calculate ledger total | Show customer each debit; verify they initiated transfers |
| KYC stuck pending | Check KYC status and document timestamp | If >7 days, escalate to KYC team |
| Settlement took longer than expected | Check settlement status and provider events | Compare to normal timeframe for that provider; if unusually late, escalate |

### 3.8 Daily Reporting

Brief daily reports track operational health and issues.

**Daily Report Template:**

```
DATE: [Date]
OPERATOR: [Name]

INCIDENTS:
- [Brief description of any issues]
- Impact: [Customers affected / $ amount affected]
- Status: [Resolved / Escalated / Monitoring]

METRICS:
- Transfers processed: [#]
- Settlement success rate: [%]
- Webhook delivery success rate: [%]
- Failed transfers resolved: [#]

ESCALATIONS:
- [Issue 1 escalated to Engineering at [time]]
- [Issue 2 escalated to Compliance at [time]]

NOTES:
- [Any operational observations]
- [Any provider issues noted]
- [Any process improvements]

FOLLOW-UP:
- [Action item 1]
- [Action item 2]
```

---

## 4. Customer Investigation Playbooks

When customers report issues, use these standardized playbooks to investigate consistently and thoroughly.

### 4.1 Customer Cannot Log In

**Symptoms:**
- Customer enters correct password but login fails
- Customer receives "Invalid credentials" error
- Customer cannot reset password

**Likely Causes:**
1. Customer entered wrong password
2. Account locked due to failed attempts
3. Account suspended for compliance
4. Technical issue with auth system

**Investigation Steps:**

Step 1: Verify account status
- Search for customer in Users or via customer lookup
- Check account status (active, suspended, locked)
- If suspended: Note reason and suspension date
- If locked: Wait 15 minutes then unlock

Step 2: Check for password reset
- If customer tried to reset password:
  - Verify reset email was sent
  - Check reset token expiration (valid for 1 hour)
  - Have customer reset again and try login

Step 3: Verify customer identity
- Ask for customer's registered email
- Ask for recent transaction amount and date
- Ask for their CAD or USD balance (verify in console)

Step 4: Check suspension reason
- If account is suspended, view suspension details
- Common reasons: KYC failure, AML alert, fraud investigation
- If operational suspension, unlock and communicate reason
- If compliance suspension, don't unlock; escalate to Compliance

**Resolution Path:**

| Issue | Action |
|-------|--------|
| Wrong password | Confirm password requirements; have customer reset |
| Account locked | Unlock account in console after 15 min |
| KYC incomplete | Direct customer to complete KYC in app |
| Suspended for review | Escalate to Compliance team |
| Technical issue | Escalate to Engineering |

### 4.2 Customer Forgot Password

**Symptoms:**
- Customer doesn't remember their password
- Customer wants to change password
- Customer received password reset email but it expired

**Investigation Steps:**

1. Verify customer identity:
   - Ask for registered email
   - Verify identity by asking about recent transactions
   - For security, never verbally confirm password

2. Initiate password reset:
   - Direct customer to "/forgot-password" page
   - Customer enters email
   - Manna sends reset email
   - Customer clicks link in email
   - Customer enters new password

3. Verify reset worked:
   - Have customer attempt login with new password
   - If login succeeds, issue resolved

**Common Blockers:**

- **Reset email in spam:** Confirm email received; check spam folder
- **Reset link expired:** 1-hour expiration is standard; request new reset
- **Customer not receiving email:** Verify email address in system; try alternate email if available
- **Can't reset in app:** Escalate to Engineering for technical issue

**Resolution Path:**

No database changes needed; all self-service through password reset flow.

### 4.3 KYC Documentation Pending

**Symptoms:**
- Customer submitted KYC documents but status still shows "Pending"
- Customer waiting for approval
- Customer unsure what documents are needed

**Typical Timeline:**

- Submission → Pending: Immediate (KYC system receives docs)
- Pending → Approved: Usually < 4 hours (automated verification)
- Pending → Rejected: Usually < 4 hours (if verification fails)

**Investigation Steps:**

1. Check KYC status in user profile
2. Note submission timestamp and current status
3. If "Pending" for < 4 hours:
   - Normal; verification is processing
   - Provide customer with estimated completion time
   - Ask customer to check back in 2-4 hours
   
4. If "Pending" for 4-12 hours:
   - Verify documents received (check KYC history)
   - Common issues: Poor photo quality, non-matching ID, expired ID
   - Message customer asking to resubmit if needed
   
5. If "Pending" for > 12 hours:
   - Document was likely rejected but not communicated
   - Check KYC history for any "Rejected" status
   - If rejected, show rejection reason to customer
   - Guide customer to resubmit with corrections

**KYC Rejection Reasons:**

- **Identity mismatch** — Photo doesn't match ID
- **ID expired** — Submitted ID is past expiration date
- **Poor image quality** — Photo too blurry or dark
- **Face not visible** — Selfie doesn't show clear face
- **Document type wrong** — Submitted document not acceptable
- **Name mismatch** — Name on ID doesn't match account

**Resolution Path:**

- If pending < 4 hours: Wait and ask customer to check back
- If pending > 4 hours but rejected: Contact customer with rejection reason; guide resubmission
- If pending > 24 hours and not rejected: Escalate to KYC team for manual review

### 4.4 Transfer Pending for Too Long

**Symptoms:**
- Customer initiated transfer but status shows "Processing" for many hours
- Customer unsure if transfer will complete
- Customer worried money is lost

**Expected Timeline for Processing:**

- US ACH transfers: 2-4 hours typically; up to 24 hours in rare cases
- Canadian EFT transfers: 2-6 hours typically
- Same-day in rare circumstances if both parties on same bank

**Investigation Steps:**

1. Locate the transfer by ID or correlation ID
2. Check current status and creation timestamp
3. Calculate elapsed time (now - creation time)
4. Check settlement state transitions:
   - When did it enter "Processing"?
   - How long in that state?
5. View most recent provider event:
   - Was a webhook received?
   - How long ago?
   - Was it successful?
6. Check if provider has status updates:
   - Log into provider dashboard
   - Look up transfer by reference number
   - What does provider say about status?

**Diagnosis:**

**Case 1: Recently entered Processing (< 1 hour)**
- Normal; provider is processing
- Provide customer with estimated completion time (2-6 hours remaining)
- Ask customer to check back later

**Case 2: In Processing for 2-4 hours, recent webhook**
- Provider is still processing; within normal range
- No action needed; monitor for completion

**Case 3: In Processing for > 6 hours, old webhook**
- Provider may be stuck or delayed
- Check provider status dashboard
- If provider has issue, escalate to provider support
- Message customer with update (delay but in progress)

**Case 4: In Processing for > 24 hours**
- Unusual; needs investigation
- Check provider for error messages
- Escalate to Engineering to investigate provider state machine

**Resolution Path:**

| Scenario | Action |
|----------|--------|
| < 4 hours, recent webhook | Wait; monitor |
| 4-6 hours, recent webhook | Still normal; provide ETA |
| > 6 hours, stale webhook | Check provider status; escalate if needed |
| > 24 hours | Escalate to Engineering |

### 4.5 Transfer Failed

**Symptoms:**
- Transfer status shows "Failed"
- Customer's money didn't arrive
- Customer frustrated about failure

**Investigation Steps:**

1. Locate transfer by ID
2. View transfer detail and status = Failed
3. Check failure timestamp (when did failure occur?)
4. View provider event that caused failure:
   - Go to Global Search with correlation ID
   - Find provider webhook marked "Failed"
   - Note error message from provider
5. Categorize failure:
   - Customer error (wrong account, insufficient funds)
   - Provider error (bank account closed, network issue)
   - System error (unexpected, needs escalation)

**Common Failure Reasons:**

| Provider Error | Meaning | Customer Action |
|---|---|---|
| Insufficient funds | Account balance too low | Check balance; retry later |
| Account not found | Destination account invalid | Verify destination account info |
| Account closed | Destination account is closed | Confirm account status with recipient |
| Network timeout | Provider network issue | Retry later |
| Rate limit exceeded | Too many requests | Retry later (30 min) |
| Invalid token | Auth credentials bad | System issue; escalate |

**Customer Communication:**

**For customer-fixable issues:**
- "Transfer failed: [Reason]"
- "You can fix this by: [Action]"
- "Then try the transfer again"

**For provider issues:**
- "Transfer failed due to a temporary issue with [Provider]"
- "We're working with [Provider] to resolve this"
- "We'll retry this transfer automatically"

**For system issues:**
- "Transfer failed unexpectedly"
- "Our technical team is investigating"
- "We'll follow up with you shortly"

**Escalation Criteria:**

- Customer still has money (debit was reversed) → No escalation needed
- Multiple customers same error → Potential provider issue → Escalate
- Debit occurred but no credit → Money lost → Escalate to Engineering immediately
- Retry after fix succeeded → Document and close
- Retry still fails → Escalate to Engineering

### 4.6 Money Request Stuck

**Symptoms:**
- Customer sent money request to another user
- Request shows as pending but not completing
- Recipient hasn't received or seen request

**Investigation Steps:**

1. Locate the request by ID
2. Check request status:
   - **Pending** — Recipient hasn't acted
   - **Accepted** — Recipient accepted; transfer should begin
   - **Rejected** — Recipient declined
   - **Completed** — Transfer completed
   - **Expired** — Request timed out (usually 7 days)

3. If Pending for reasonable time (< 1 week):
   - Request waiting for recipient action
   - Recipient may not have seen notification
   - Suggest sender resend request or contact recipient directly

4. If Pending for > 1 week:
   - Request likely expired
   - Sender can resend if needed

5. If Accepted but transfer not initiated:
   - Check if transfer was created
   - Search by correlation ID
   - If transfer created, see "Transfer Pending" playbook
   - If transfer never created, escalate to Engineering

**Common Issues:**

| Issue | Cause | Resolution |
|-------|-------|-----------|
| Recipient didn't see notification | Push notification delivery issue | Suggest direct contact |
| Recipient didn't accept | Just hasn't responded yet | Wait up to 7 days |
| Recipient declined | Recipient doesn't want to send | Request was rejected; normal |
| Accepted but transfer stuck | Technical issue | See "Transfer Pending" playbook |

**Escalation Criteria:**

- Accepted but no transfer created after 1 hour → Escalate
- Request shows completed but recipient says didn't receive → Escalate

### 4.7 Notification Missing or Delayed

**Symptoms:**
- Customer didn't receive email/SMS about transfer
- Customer didn't get push notification
- Notification arrived late

**Investigation Steps:**

1. Identify which notification was missed:
   - Transfer confirmation?
   - Settlement complete?
   - KYC status change?
   - Friend request?

2. Check notification preferences:
   - Does customer have email on file?
   - Does customer have phone on file?
   - Are notifications enabled?
   - Are notifications going to spam?

3. Investigate delivery:
   - Was notification queued?
   - Was it sent?
   - Did provider receive it?
   - Was it delivered?

4. If notification wasn't sent:
   - Check event that should trigger it
   - Did the event occur?
   - What status was customer in?

**Common Causes:**

| Issue | Likely Cause | Fix |
|-------|---|---|
| Email not received | In spam folder | Check spam; add to whitelist |
| SMS not received | Phone number wrong | Verify phone; resend |
| Push notification not received | Notifications disabled on phone | Enable in app settings |
| Email address invalid | Customer entered wrong email | Update email and resend |
| Notification delayed | Provider queue backlog | Normal; may arrive hours later |

**Escalation Criteria:**

- Customer clearly should have received notification but didn't → Escalate
- Systematic missing notifications (multiple customers) → Escalate
- Notification sent but provider never delivered → Escalate

### 4.8 Balance Discrepancy

**Symptoms:**
- Customer balance doesn't match their expectations
- Customer says they spent/received different amount
- Customer missing money

**Investigation Steps:**

1. Calculate ledger balance:
   - Filter Ledger page by customer's currency
   - Filter by customer ID
   - Sum all credits (additions)
   - Sum all debits (subtractions)
   - Ledger balance = credits - debits

2. Compare to account balance:
   - View customer's account balance in Operations Console
   - Compare to calculated ledger balance
   - If they match: Ledger is correct; discrepancy is in customer expectation
   - If they don't match: Ledger may be incomplete; escalate

3. Review transaction history with customer:
   - Walk through each debit and credit chronologically
   - Identify which transaction doesn't match customer's memory
   - Possible causes:
     - Customer forgot about transfer
     - Transfer failed but debit was reversed (shouldn't show)
     - Settlement took longer than expected (money not yet arrived)
     - Duplicate settlement (money credited twice — escalate)

4. Special cases:
   - **Pending settlements:** Money debited but not yet credited; will show when settled
   - **Failed transfers:** Money debited then returned; net zero
   - **FX adjustments:** Amount changed due to exchange rate

**Resolution Workflow:**

**Case 1: Ledger balance matches account balance**
- Discrepancy is in customer expectation
- Explain each transaction
- Resolve understanding
- No correction needed

**Case 2: Ledger balance differs from account balance**
- System issue; escalate to Engineering
- Document the variance amount
- Note which accounts affected
- Escalate immediately

**Case 3: Missing settlement credit**
- Verify settlement state
- Check provider webhook
- If settled but not credited: Escalate
- If still processing: Give updated ETA

**Escalation Criteria:**

- Any missing money that can't be explained by ledger → Escalate
- Duplicate ledger entries → Escalate
- Missing settlement credit despite provider confirmation → Escalate

---

## 5. Settlement Investigation Deep Dive

Settlements are the core of Manna's operation. This section provides comprehensive investigation guidance.

### 5.1 Settlement Lifecycle

Understanding the settlement lifecycle is critical for operational success.

**Phase 1: Initiation (User Action)**

1. Customer creates transfer intent
2. System creates transfer_intent record (status = draft)
3. Customer enters recipient, amount, and currency
4. System calculates FX rate if cross-border
5. Customer reviews details
6. Customer confirms (consent_confirmed_at recorded)
7. Transfer status → ready

**Phase 2: Provider Processing (System Action)**

1. System submits transfer to provider
2. Transfer status → processing
3. Provider queues transfer for execution
4. Provider returns transfer reference
5. Reference stored in transfer_intent

**Phase 3: Settlement (Provider + Bank Action)**

1. Provider initiates settlement with bank
2. Bank processes ACH/EFT
3. Bank returns settlement result
4. Provider sends webhook with result
5. Manna receives webhook
6. Transfer status → settled or failed

**Phase 4: Reconciliation (Operations + Finance)**

1. Settlement recorded in ledger
2. Customer balance updated
3. Daily reconciliation verifies settlement
4. Monthly reconciliation confirms all entries
5. Accounting team reconciles against bank

### 5.2 Settlement States and Transitions

Each transfer_intent moves through defined states. Only certain transitions are valid.

**Valid State Transitions:**

```
Draft → Ready → Processing → Settled ✓
                 ↓
              Failed → [No further transition]
                 ↓
              Returned → [No further transition]
```

**State Definitions:**

| State | Meaning | Duration | Next State |
|-------|---------|----------|-----------|
| Draft | Incomplete transfer; customer still reviewing | Minutes to hours | Ready |
| Ready | Customer confirmed; awaiting processing | Seconds to minutes | Processing |
| Processing | Provider is executing; awaiting bank | 2-6 hours | Settled / Failed |
| Settled | Provider confirmed success; funds transferred | Terminal | — |
| Failed | Provider reported failure; transfer didn't execute | Terminal | — |
| Returned | Provider reversed a completed settlement | Terminal | — |

**State Transition Rules:**

- No backwards transitions (can't go from Processing back to Ready)
- No skipped transitions (can't go from Ready directly to Settled)
- Only one terminal state allowed (Settled, Failed, or Returned)
- State is changed only by system or approved operations procedures

### 5.3 Settlement Provider References

When a provider processes a settlement, it returns a reference ID. This reference is critical for reconciliation.

**Provider Reference Storage:**

- Stored in transfer_intent.provider_reference
- Used to track transfer at provider
- Must match provider's system for verification
- Never manually edited

**Using Provider References:**

To verify a settlement with provider:

1. Get transfer ID
2. Find provider_reference in transfer detail
3. Log into provider dashboard
4. Search for transfer by reference
5. Verify status matches Manna's status
6. Note any discrepancies

**Example:**

- Manna status: Settled (completed 5/15/2026)
- Provider status: Settled (completed 5/15/2026, same day)
- Result: Verified ✓

**When Discrepancy Exists:**

If Manna and provider show different status:
- Verify the reference ID is correct
- Check if status change is in flight (delay between systems)
- If discrepancy persists > 1 hour: Escalate to Engineering

### 5.4 Settlement Timeline Expectations

Knowing normal timelines helps identify stuck or delayed settlements.

**US ACH Transfers (Domestic USD):**

| Phase | Expected Duration | Max Duration |
|-------|-------------------|--------------|
| Draft to Ready | < 5 minutes | 1 hour |
| Ready to Processing | < 1 minute | 5 minutes |
| Processing to Settled | 2-4 hours | 24 hours |
| **Total** | **2-4 hours** | **24 hours** |

Normal ACH settles within 2-4 hours. If > 6 hours, monitor closely.

**Canadian EFT Transfers (Domestic CAD):**

| Phase | Expected Duration | Max Duration |
|-------|-------------------|--------------|
| Draft to Ready | < 5 minutes | 1 hour |
| Ready to Processing | < 1 minute | 5 minutes |
| Processing to Settled | 2-6 hours | 24 hours |
| **Total** | **2-6 hours** | **24 hours** |

Canadian EFT can take up to 6 hours; longer processing windows are normal.

**Cross-Border Transfers (CAD ↔ USD):**

| Phase | Expected Duration | Max Duration |
|-------|-------------------|--------------|
| Draft to Ready | < 5 minutes | 1 hour |
| Ready to Processing | < 1 minute | 5 minutes |
| Processing to Settled | 4-12 hours | 48 hours |
| **Total** | **4-12 hours** | **48 hours** |

Cross-border transfers are slower due to multiple banks and FX processes. Up to 12 hours is normal.

### 5.5 Identifying Stuck Settlements

A settlement is "stuck" if it remains in a state longer than expected.

**Detection:**

1. Go to Settlements page
2. Filter by status = Processing
3. Sort by creation date (oldest first)
4. For each settlement:
   - Calculate elapsed time in Processing state
   - Compare to expected timeline for that provider
   - If elapsed > max expected: Mark as stuck

**Investigation Workflow:**

**Step 1: Check Provider Event**
- View the most recent provider webhook
- Is it recent (< 30 min) or old (> 2 hours)?
- Recent webhook: Provider is still processing; wait
- Old webhook: Provider may be stuck or done

**Step 2: Verify Provider Status**
- Log into provider dashboard
- Search for settlement by reference ID
- What does provider say?
- Possible findings:
  - Provider shows Settled: Webhook should arrive soon
  - Provider shows Processing: Normal; still working
  - Provider shows Failed: Failure webhook coming
  - Provider has no record: Escalate immediately

**Step 3: Assess Impact**
- How long has it been stuck?
- Is it close to SLA expiration?
- Are other settlements stuck too?

**Step 4: Decide Action**

**If stuck < 6 hours and recent webhook:**
- Action: Monitor; continue waiting
- Check again in 1 hour

**If stuck 6-24 hours:**
- Action: Monitor closely; contact provider if needed
- Escalate to Engineering if > 24 hours

**If stuck > 24 hours:**
- Action: Escalate to Engineering
- Provide: Correlation ID, transfer ID, provider reference

**If provider shows different status than Manna:**
- Action: Escalate to Engineering immediately
- Provides: Both statuses and discrepancy

### 5.6 Settlement Failure Investigation

When a settlement fails, investigation is needed to determine if it's retryable.

**Failure Categories:**

**Category 1: Transient Failures (Retryable)**
- Network timeout
- Rate limit (provider throttling)
- Temporary provider outage
- Temporary bank connection issue

**Category 2: Customer Failures (Non-Retryable)**
- Insufficient funds in bank account
- Destination account not found
- Destination account closed
- Customer fraud detection (provider or bank)

**Category 3: System Failures (Escalate)**
- Invalid provider reference (shouldn't happen)
- Unexpected provider API error
- Data corruption or inconsistency

**Investigation Steps:**

1. Locate settlement by ID
2. Check transfer status = Failed
3. View provider webhook that reported failure
4. Note error code and error message
5. Categorize error:
   - Known transient error? → Retryable
   - Known customer error? → Not retryable
   - Unknown error? → Escalate

6. Take action per category

**Common Error Codes and Meanings:**

| Code | Meaning | Retryable | Customer Action |
|------|---------|-----------|-----------------|
| INSUFFICIENT_FUNDS | Account balance too low | No | Check balance |
| ACCOUNT_CLOSED | Bank account closed | No | Verify account status |
| ACCOUNT_NOT_FOUND | Routing/account number wrong | No | Verify account info |
| NETWORK_ERROR | Connection failure | Yes | Retry later |
| RATE_LIMIT | Too many requests | Yes | Retry in 30 min |
| PROVIDER_OUTAGE | Provider is down | Yes | Retry later |
| INVALID_TOKEN | Auth credentials bad | No | Escalate to Engineering |

### 5.7 Settlement Reversal Investigation

In rare cases, a completed settlement is reversed by the provider.

**Reversal Lifecycle:**

1. Settlement completes normally (status = Settled)
2. Funds appear in recipient's account
3. Days later: Provider sends reversal webhook
4. Manna marks settlement as Returned
5. System creates ledger entries to reverse original settlement
6. Customer balances updated

**Common Causes of Reversal:**

- **Fraud detection** — Bank detected suspicious activity
- **Duplicate settlement** — Provider sent same settlement twice (only one valid)
- **Customer dispute** — Customer claims unauthorized or wrong amount
- **Bank reconciliation** — Bank identified processing error

**Investigation Workflow:**

1. Identify reversed settlement by ID
2. Calculate impact:
   - Recipient's balance decreased (funds removed)
   - Sender's balance increased (funds returned)
3. Note reversal timestamp (how long after original settlement?)
4. Review provider webhook for reversal reason
5. Contact provider support to understand why
6. If customer dispute:
   - Contact customer who sent funds
   - Document their response
   - Escalate to Compliance if needed

**Reversal Frequency:**

Reversals should be extremely rare (< 0.01% of settlements). If reversals increasing:
- Investigate for fraud patterns
- Check for provider system issues
- Escalate to Engineering

---

## 6. Ledger Investigation Complete Guide

The ledger is the immutable record of all financial movement. This section teaches comprehensive ledger investigation.

### 6.1 Ledger Fundamentals

**Ledger as Source of Truth:**

- Every financial movement is recorded as a ledger entry
- Ledger entries are immutable (never deleted or modified)
- Ledger balance = sum of all ledger entries for an account
- Account balance must equal ledger balance at all times

**Ledger Entry Structure:**

Each ledger entry contains:

| Field | Meaning |
|-------|---------|
| ID | Unique ledger entry ID |
| User ID | Account that was affected |
| Currency | USD or CAD |
| Entry Type | Type of movement (see below) |
| Debit | Amount removed (null if credit) |
| Credit | Amount added (null if debit) |
| Reference | Transaction ID or settlement ID |
| Timestamp | When entry was recorded |
| Operator | Who created the entry (system or admin) |

**Entry Types:**

| Type | Meaning | Who Creates | Normal Flow |
|------|---------|-------------|-------------|
| seed_balance | Initial $100 account creation | System | At signup |
| transfer_debit | Money sent out | System | At settlement |
| transfer_credit | Money received | System | At settlement |
| settlement_debit | Debit for cross-border transfer | System | At settlement |
| settlement_credit | Credit for cross-border transfer | System | At settlement |
| fee_debit | Fee charged to account | System | At settlement |
| reversal_debit | Reversal of previous credit | System | When settlement reversed |
| reversal_credit | Reversal of previous debit | System | When settlement reversed |

### 6.2 Balance Calculation

Understanding how balances are calculated is essential.

**Balance Formula:**

```
Account Balance = Sum(credits) - Sum(debits)
```

**Example:**

User receives:
- Seed balance: +$100
- Transfer from friend: +$50
- Settlement credit: +$75
- Total credits: $225

User sends:
- Transfer to friend: -$30
- Cross-border settlement: -$40
- Total debits: $70

Balance = $225 - $70 = **$155**

**Verification:**

To verify a customer's balance:

1. Go to Ledger page
2. Filter by customer ID and currency
3. Manually sum all credits
4. Manually sum all debits
5. Calculate: Credits - Debits = Expected Balance
6. Compare to displayed balance
7. If they match: Balance is correct
8. If they don't match: Escalate to Engineering

### 6.3 Ledger Discrepancy Investigation

When a customer's balance doesn't match their expectation, investigate the ledger.

**Discrepancy Types:**

**Type 1: Missing Ledger Entry**
- Customer sent transfer; no debit recorded
- Customer received transfer; no credit recorded
- Settlement completed; no ledger entry
- Causes: System bug, incomplete settlement recording

**Type 2: Duplicate Ledger Entry**
- Same transfer debited twice
- Same settlement credited twice
- Customer charged twice for same action

**Type 3: Wrong Amount in Ledger Entry**
- Ledger entry shows different amount than transfer
- FX adjustment applied incorrectly
- Fee added to wrong account

**Type 4: Orphaned Ledger Entry**
- Ledger entry exists but no corresponding settlement
- Settlement deleted but ledger entry remains
- Causes: Data corruption or incomplete rollback

**Investigation Workflow:**

**Step 1: Identify the discrepancy**
- Ask customer: What did they expect?
- Calculate ledger balance
- Compare to actual balance
- Note the difference in dollars

**Step 2: Trace related transactions**
- What transfer or settlement should have created the entry?
- Find the settlement ID or transfer ID
- Trace to provider event and confirmation

**Step 3: Check for missing entries**
- For each settlement that completed:
  - Verify debit appears for sender
  - Verify credit appears for recipient
- For settled transfers:
  - Verify debit appears in sender ledger
  - Verify credit appears in recipient ledger

**Step 4: Check for duplicate entries**
- Look for exact duplicates (same amount, same type, same day)
- Look for near-duplicates (same amount, different day)
- Verify via settlement: If settlement completed once, duplicates shouldn't exist

**Step 5: Check for wrong amounts**
- Compare ledger amount to settlement amount
- Account for FX if cross-border
- Calculate what FX rate would have been applied
- If amount doesn't match expected FX, escalate

**Escalation Criteria:**

**Immediate Escalation (SEV-1):**
- Missing debit: Customer money not recorded as sent (loss of $XXX)
- Missing credit: Customer money not recorded as received (loss of $XXX)
- Amount discrepancy > $100

**Urgent Escalation (SEV-2):**
- Duplicate ledger entries (double-crediting)
- Orphaned entries without explanation
- Recurring discrepancies for same customer

**Standard Escalation (SEV-3):**
- Small discrepancies (< $10) with unknown cause
- Entries that don't match provider confirmation

### 6.4 Daily Ledger Reconciliation

Daily reconciliation verifies ledger integrity and catches errors early.

**Daily Reconciliation Procedure (30 minutes):**

```
Reconciliation Date: [Date]
Operator: [Name]

STEP 1: Calculate Total Balances
--------
USD Ledger:
  Total credits: $[XXX,XXX]
  Total debits:  $[XXX,XXX]
  Expected USD total balance: $[XXX,XXX]

CAD Ledger:
  Total credits: $[XXX,XXX]
  Total debits:  $[XXX,XXX]
  Expected CAD total balance: $[XXX,XXX]

STEP 2: Verify Against System Totals
--------
Reported USD total: $[XXX,XXX]
Calculated USD total: $[XXX,XXX]
USD Variance: $[XXX] (should be $0)

Reported CAD total: $[XXX,XXX]
Calculated CAD total: $[XXX,XXX]
CAD Variance: $[XXX] (should be $0)

STEP 3: If Variance Exists
--------
Variance amount: $[XXX]
Direction: Over / Under
Likely cause: [Investigation findings]
Escalation: Yes / No
To: [Team/Engineer name]

STEP 4: Summary
--------
Result: ✓ Balanced / ✗ Out of Balance
Issues found: [#]
Escalations needed: [#]
Notes: [Any observations]
```

### 6.5 Monthly Ledger Reconciliation

Monthly reconciliation is detailed and catches systemic issues.

**Monthly Procedure (1-2 hours):**

1. Export all ledger entries for the month
2. For each active customer account:
   - Calculate opening balance (first entry of month)
   - Add all credits for month
   - Subtract all debits for month
   - Calculate ending balance
   - Verify ending balance matches actual balance
   - Note any discrepancies

3. For each account with discrepancy:
   - Investigate the specific entries
   - Find the missing or wrong entry
   - Trace to source transaction
   - Document finding

4. Generate report:
   - Total accounts: [#]
   - Accounts in balance: [#]
   - Accounts out of balance: [#]
   - Issues found: [#]
   - Escalations needed: [#]

5. Attach report to audit trail

**Red Flags for Escalation:**

- > 1% of accounts out of balance
- Multiple customers missing same type of entry (e.g., all missing settlement credits)
- Systematic discrepancies (all off by same amount)
- Duplicate entries appearing across multiple accounts

---

## 7. Provider Operations

### 7.1 Understanding Providers

Manna integrates with multiple providers for different services. Each provider has unique characteristics, timelines, and failure modes.

**Provider Categories:**

**Payment Providers** — Handle actual money movement
- Plaid (US ACH)
- Canadian EFT provider
- Future: Additional providers

**Verification Providers** — Verify customer identity
- Stripe (KYC verification)

**Status Monitoring:**

Each provider should be monitored for:
- Availability (is provider up?)
- Performance (how fast are processes?)
- Error rate (what's failing?)
- Webhook reliability (are we getting updates?)

### 7.2 Plaid Operations (US ACH)

**Provider:** Plaid  
**Service:** ACH direct debit transfers  
**Currencies:** USD  
**Region:** United States  
**Processing Time:** 2-4 hours typical; up to 24 hours  

**Normal Operation:**

1. Customer links bank account via Plaid auth flow
2. Manna receives bank account token
3. At settlement, Manna initiates ACH debit with Plaid
4. Plaid submits to banking network
5. Banking network processes debit (2-4 hours)
6. Plaid sends settlement webhook to Manna
7. Manna marks transfer as settled

**Expected Webhook Timeline:**

- Debit initiated: Immediately
- Bank processing: 2-4 hours
- Webhook received: Within 30 min of bank completion
- Manna status updated: Within 30 sec of webhook

**Known Failure Modes:**

| Failure | Cause | Resolution |
|---------|-------|-----------|
| Account not found | Bank account no longer valid | Customer relinks account |
| Insufficient funds | Checking account balance too low | Customer adds funds |
| Account closed | Customer closed the bank account | Customer provides new account |
| Invalid routing # | Routing number was wrong | Customer verifies account info |
| Debit not allowed | Account configured to disallow debits | Customer changes bank settings |
| Rate limit | Too many requests to Plaid | Retry in 30 minutes |
| Network error | Connection to Plaid failed | Retry later |

**Maintenance Windows:**

Plaid typically has 0 maintenance windows (99.9%+ uptime). If Plaid is down:
- No ACH transfers can be initiated
- Existing transfers waiting on Plaid will be delayed
- Monitor Plaid status page for updates

**Escalation Criteria:**

- Multiple customer failures with same error → Contact Plaid support
- Webhook delivery failures → Check webhook configuration
- Account linking failures → Escalate to Engineering

### 7.3 Canadian EFT Operations

**Provider:** [Canadian Bank Network]  
**Service:** EFT direct debit transfers  
**Currencies:** CAD  
**Region:** Canada  
**Processing Time:** 2-6 hours typical  

**Normal Operation:**

1. Customer provides Canadian bank account info
2. Manna verifies account and routing
3. At settlement, Manna initiates EFT with Canadian provider
4. Provider submits to Canadian banking network
5. Banking network processes debit (2-6 hours)
6. Provider sends settlement webhook to Manna
7. Manna marks transfer as settled

**Expected Webhook Timeline:**

- Debit initiated: Immediately
- Bank processing: 2-6 hours
- Webhook received: Within 1 hour of bank completion
- Manna status updated: Within 30 sec of webhook

**Known Failure Modes:**

Similar to Plaid; also:

| Failure | Cause | Resolution |
|---------|-------|-----------|
| Weekend/holiday delay | Banks slower on weekends | Normal; wait for Monday |
| SWIFT code mismatch | International account info | Customer verifies if international |
| Branch code invalid | Branch code was wrong | Customer verifies routing |

**Maintenance Windows:**

Canadian banking networks have scheduled maintenance windows:
- Typically: First Sunday 8pm-5am ET
- No transfers can settle during window
- Plan accordingly; don't surprise customers

**Escalation Criteria:**

- Multiple failures same day → Check if scheduled maintenance
- Systematic delays > 12 hours → Contact provider
- Webhook failures → Check webhook configuration

### 7.4 Stripe Operations (KYC Verification)

**Provider:** Stripe  
**Service:** Identity verification and KYC documentation  
**Scope:** Document verification, identity verification, fraud checks  

**Normal Operation:**

1. Customer submits KYC documents via Manna app
2. Manna forwards to Stripe for verification
3. Stripe performs automated checks
4. Stripe sends verification result webhook to Manna
5. Manna updates customer KYC status

**Expected Timeline:**

- Submission → Verification: Usually < 4 hours
- Verification → Result: Same time
- Result webhook → Manna update: < 30 seconds

**Verification Results:**

- **Approved** — Customer verified; can transact
- **Pending manual review** — Automated check inconclusive; human review needed (typically 24 hours)
- **Rejected** — Document invalid; customer must resubmit

**Rejection Reasons:**

- Selfie doesn't match ID
- ID is expired
- Image quality too poor
- Wrong document type
- Name on document doesn't match account
- Address missing

**Escalation Criteria:**

- Customer stuck pending > 24 hours → Escalate to Stripe
- Repeated rejections same customer → May indicate fraud
- Systematic rejections (many customers) → Quality issue; escalate

### 7.5 Provider Status Monitoring

Daily operations should include monitoring provider health.

**Monitoring Checklist (5 min daily):**

```
□ Check Plaid status page (plaid.com/status)
  - All systems green? Y / N
  - Any maintenance scheduled? Y / N
  - Any recent incidents? Y / N

□ Check Canadian provider status page
  - Network operational? Y / N
  - Delays reported? Y / N

□ Check Stripe status page (stripe.com/status)
  - Verification service up? Y / N
  - Any delays? Y / N

□ Check internal Manna health metrics
  - Settlement success rate > 95%? Y / N
  - Webhook delivery > 95%? Y / N
  - Any errors correlating to single provider? Y / N
```

**When to Escalate:**

- Provider status page shows issue → Monitor
- Provider issue affecting > 5 customers → Escalate
- Provider issue ongoing > 2 hours → Contact provider
- Provider issue ongoing > 4 hours → Escalate to Engineering

---

## 8. Incident Response

Incident response is structured by severity level. Each level has specific response times, escalation paths, and communication protocols.

### 8.1 Incident Severity Levels

**SEV-1 (Critical)** — Major impact, requires immediate response

Examples:
- All transfers failing
- All settlements unable to complete
- Customer funds lost or inaccessible
- Database corruption detected
- Security breach detected
- Regulatory compliance violation

Response time: < 15 minutes  
Escalation: CTO + Engineering leadership  
Customer communication: Immediate

**SEV-2 (High)** — Significant impact, needs quick response

Examples:
- Large subset of transfers failing (> 10%)
- Specific provider completely unavailable
- Significant number of customers reporting issues (> 10)
- KYC processing completely stopped
- Webhook delivery completely stopped

Response time: < 1 hour  
Escalation: Engineering manager  
Customer communication: Within 30 minutes

**SEV-3 (Medium)** — Moderate impact, normal business day response

Examples:
- Sporadic transfer failures (1-5%)
- Individual customer having major issue
- Provider experiencing performance degradation
- KYC delayed for specific customer
- Single webhook failure

Response time: < 4 hours  
Escalation: Engineering on-call  
Customer communication: Within 2 hours

**SEV-4 (Low)** — Minor impact, can wait for normal business hours

Examples:
- Single customer's question
- Minor documentation issue
- Small feature gap
- Non-critical bug

Response time: < 24 hours  
Escalation: Standard ticketing  
Customer communication: Within 24 hours

### 8.2 Incident Response Workflow

**When incident is detected:**

1. **Confirm severity** (< 2 min)
   - Gather facts
   - Assess impact
   - Assign severity level

2. **Escalate** (< 2 min)
   - For SEV-1/2: Page on-call engineering
   - For SEV-1: Also page CTO
   - Provide context and severity

3. **Respond** (< response time)
   - Operations or Engineering begins investigation
   - Take steps to mitigate impact
   - Keep stakeholders informed

4. **Communicate** (immediately)
   - For SEV-1/2: Prepare status update for customers
   - For SEV-1: Post to status page
   - For SEV-2/3: Customer-specific communication
   - Update every 30 minutes

5. **Resolve** (per severity timeline)
   - Implement fix
   - Verify fix works
   - Bring system back to normal

6. **Document** (post-incident)
   - Create incident report
   - Include timeline, impact, root cause, prevention
   - Schedule postmortem within 1 week

### 8.3 Common Incidents and Response

**Incident: Transfer Settlement Failing**

SEV level: 2-3 (depends on % failing)

Response steps:
1. Verify: How many transfers failing? What error?
2. Investigate: Is provider down? Is it transient?
3. Mitigate: If provider issue, communicate to customers; if system issue, escalate to Engineering
4. Resolve: Provider recovery or Engineering fix
5. Communicate: "Transfer delays due to [provider] issue. We're working on resolution. Updates every 30 min."
6. Follow-up: Once resolved, postmortem on why it happened

**Incident: Webhook Delivery Stopped**

SEV level: 2-3

Response steps:
1. Verify: Which provider? How long no webhooks?
2. Investigate: Is provider sending webhooks? Is our endpoint receiving?
3. Mitigate: Check network logs, provider status, endpoint health
4. Resolve: Fix network issue, provider issue, or code issue
5. Communicate: "Delays processing settlements due to webhook issue. Investigating."
6. Follow-up: Postmortem on architecture to prevent

**Incident: Customer Reports Missing Money**

SEV level: 2-3 (depends on amount)

Response steps:
1. Verify: How much money? Ledger balance matches?
2. Investigate: Review ledger, find settlement, check provider
3. Mitigate: If system error, escalate to Engineering immediately
4. Resolve: Explain finding to customer or escalate for balance correction
5. Communicate: Direct contact with customer with findings
6. Follow-up: If system error, postmortem to prevent

---

## 9. Compliance and Security Operations

### 9.1 KYC Operations

Know Your Customer (KYC) verification is required for all users.

**KYC Process:**

1. New user signs up
2. User is prompted to verify identity
3. User submits government ID photo
4. User submits selfie for liveness check
5. Stripe verifies (usually < 4 hours)
6. Result: Approved or Rejected

**Approved Status:**

- User can create transfer intents
- User can receive money
- No restrictions

**Rejected Status:**

- User cannot create transfers
- User can still receive money (already had account)
- User must resubmit to be approved

**Operations Actions:**

- View KYC status of any user
- See submission history and rejection reasons
- Send message to user about rejection
- Manually approve (with documentation) in rare cases
- Escalate to KYC team if stuck pending

**KYC Performance Targets:**

- < 2% rejection rate (too high = bad docs or bad process)
- > 95% approval rate within 4 hours
- < 5% requiring manual review

### 9.2 AML Operations

Anti-Money Laundering (AML) checks flag suspicious activity.

**AML Scenarios:**

- Large transfer amount (> $10,000)
- Rapid transfers (multiple large transfers within hour)
- Transfers to/from high-risk countries
- Transfer patterns matching known suspicious behavior

**Operations Actions When AML Alert Triggered:**

1. View the alert details
2. Note the amount and pattern that triggered alert
3. Review customer's history:
   - Account age
   - Previous transfers
   - Geographic pattern
   - Velocity
4. Decide: Legitimate or suspicious?
5. Document decision and reasoning
6. If suspicious: Flag account for investigation
7. If legitimate: Close alert

**When to Escalate to Compliance:**

- Customer under investigation for fraud
- Large amount (> $50,000) flagged
- Pattern suggests money laundering
- Customer previously flagged for other issues

### 9.3 Fraud Detection

Fraud includes:

- Account takeover (someone else logging in)
- Unauthorized transfers
- Duplicate transfers
- Identity fraud
- Collusion (multiple accounts conspiring)

**When to Suspect Fraud:**

- Customer reports account accessed without permission
- Unusual transfer pattern for customer
- Multiple accounts from same person
- Transfers to known high-risk recipients
- Rapid account creation and large transfer
- Multiple failed KYC attempts

**Operations Response:**

1. Don't assume fraud; verify first
2. Contact customer to confirm activity
3. If customer confirms: Legitimate
4. If customer denies: Likely fraud → Escalate
5. If customer unresponsive: Escalate

**When Fraud Confirmed:**

- Freeze account pending investigation
- Document all evidence
- Escalate to Compliance + Security
- Do not allow further transfers
- Prepare for potential law enforcement coordination

---

## 10. Disaster Recovery and Business Continuity

### 10.1 Outage Scenarios and Recovery

**Database Outage**

Scenario: PostgreSQL database becomes unavailable

Impact:
- No operations possible
- Transfers cannot be processed
- Ledger cannot be updated
- Customer app shows errors

Recovery steps:
1. Detect: Monitoring alerts fire (< 1 min)
2. Investigate: Engineering checks database status
3. Restart: Database service restarted (< 5 min)
4. Verify: Monitoring confirms connectivity restored
5. Assess: Check for data integrity issues
6. Communicate: Status update to customers
7. Resolve: Identify root cause and fix
8. Postmortem: Document and prevent recurrence

Recovery objective: < 30 minutes downtime

**Provider Outage**

Scenario: Plaid or other provider becomes unavailable

Impact:
- New transfers cannot be initiated
- Existing transfers waiting on provider are delayed
- No settlements can complete
- Customer app may show errors

Recovery steps:
1. Detect: Webhook failures or status page notice
2. Investigate: Engineering confirms provider status
3. Communicate: "Settlement delays due to provider issue"
4. Wait: For provider to recover (could be hours)
5. Resume: Once provider operational, process queued settlements
6. Verify: All delayed settlements eventually complete
7. Postmortem: How could we have better handled?

Recovery objective: Depends on provider; typically < 4 hours

**Webhook Delivery Outage**

Scenario: Webhook endpoint becomes unavailable

Impact:
- Settlements cannot be marked complete
- Transfers stuck in Processing
- Customers report transfers not settling
- Ledger entries are delayed

Recovery steps:
1. Detect: Webhook failures accumulate
2. Investigate: Check endpoint health, network, auth
3. Fix: Restore endpoint or network connectivity
4. Drain queue: Replay queued webhooks
5. Verify: All settlements eventually completed
6. Communicate: Status update once resolved

Recovery objective: < 2 hours

**Cloud Infrastructure Outage**

Scenario: Vercel or AWS region becomes unavailable

Impact:
- All Manna services offline
- No API responses
- Customer app inaccessible

Recovery steps:
1. Detect: Automated monitoring alerts
2. Investigate: Check cloud provider status
3. Failover: If regional failover available, activate
4. Wait: For provider to restore
5. Restore: Once service available, verify all components
6. Communicate: Regular updates to customers

Recovery objective: < 15 minutes (with failover); < 4 hours (without)

### 10.2 Business Continuity Planning

**Critical Operations:**

Operations must be able to continue even if some systems are down:

1. **Settlement Processing**
   - If app is down but API running: Settlements can still complete
   - If API is down: Settlements stall; need Engineering to restart
   - If database is down: Nothing can process

2. **Customer Communication**
   - If email is down: Use SMS or in-app messaging
   - If all comms down: Use status page
   - Keep templates ready for common issues

3. **Incident Response**
   - Have escalation contacts memorized (not just in app)
   - Have offline incident runbooks printed
   - Have backup communication channels (phone, radio)

4. **Data Access**
   - Have read-only database queries prepared
   - Export customer data daily for offline reference
   - Have recent database dumps available

---

## 11. Engineering Escalation Guide

This section defines when Operations must escalate to Engineering and what to provide.

### 11.1 Escalation Criteria

Escalate when:

**1. Balance Mismatch**
- Customer balance ≠ ledger balance
- Multiple customers affected
- Cannot determine cause

**Information to provide:**
- Customer ID(s)
- Expected vs actual amount
- Affected currency
- Recent transactions involved
- Correlation IDs if known

**2. Ledger Corruption**
- Missing ledger entry
- Duplicate ledger entry
- Ledger entry without corresponding settlement
- Amount mismatch

**Information to provide:**
- Affected customer ID
- Ledger entry details (ID, amount, type)
- Missing/duplicate reference ID
- Timeline of when issue occurred

**3. Settlement Inconsistency**
- Manna status ≠ Provider status (> 1 hour)
- Settlement state shouldn't exist (e.g., Settled + Failed)
- Settlement missing provider reference
- Multiple settlements for same transfer

**Information to provide:**
- Settlement/Transfer ID
- Correlation ID
- Both statuses (Manna + Provider)
- Provider reference ID
- Timeline of states

**4. Provider Outage**
- Provider status page shows issue
- Multiple customers affected
- Error rate > 10%
- Outage ongoing > 2 hours

**Information to provide:**
- Provider name
- Error type and code
- Number of customers affected
- Timeline of failures
- Impact on business (# transfers affected)

**5. Webhook Failures**
- Webhook delivery completely stopped
- All webhooks from provider failing
- > 50 consecutive webhook failures
- Pattern of failures suggesting code issue

**Information to provide:**
- Provider name
- Error messages
- Timeline of failures
- Correlation IDs of affected settlements
- Recent code changes (if known)

**6. Security Incident**
- Unauthorized access detected
- Customer funds moved without consent
- System compromise suspected
- Data breach suspected

**Information to provide:**
- Timeline of suspicious activity
- Affected customer IDs
- Evidence (IP addresses, IDs, timestamps)
- Impact assessment

**7. Database Issue**
- Direct database connection required
- Data appears corrupted
- Query performance degraded
- Storage running out

**Information to provide:**
- Description of issue
- Evidence (error messages, slow queries)
- Impact on operations

**8. Infrastructure Issue**
- Web service down
- API unresponsive
- Network connectivity issues
- Deployment failed

**Information to provide:**
- Service affected
- Error messages
- Timeline of outage
- Impact on customers

### 11.2 How to Escalate

**For SEV-1 Issues:**

1. Page on-call engineer immediately (phone/SMS)
2. Don't wait for text acknowledgment
3. Provide brief summary of issue
4. Get commitment for investigation time
5. Provide detailed information (see above)
6. Stay available for questions

**For SEV-2 Issues:**

1. Create engineering ticket with details
2. Assign to on-call engineer
3. Send Slack message to engineering channel
4. Link ticket in Slack
5. Follow up within 1 hour if not acknowledged

**For SEV-3 Issues:**

1. Create engineering ticket with details
2. Assign to appropriate engineer (if known)
3. Can wait for next business day if off-hours
4. Follow up within 2 hours if urgent

**For SEV-4 Issues:**

1. Create ticket in standard system
2. No urgent escalation needed
3. Can be addressed during normal work

---

## 12. Key Performance Indicators

Operations success is measured through KPIs. Track these metrics daily and monthly.

### 12.1 Settlement Performance

**Metric: Settlement Completion Rate**
- Definition: % of initiated settlements that complete successfully
- Target: > 98%
- Measured: Daily
- Action if < target: Investigate provider issues

**Metric: Average Settlement Time**
- Definition: Average duration from settlement initiation to completion
- Target: US: 2-4 hours; CA: 2-6 hours; Cross-border: 4-12 hours
- Measured: Daily
- Action if > target: Check provider status

**Metric: Settlement Failure Rate**
- Definition: % of settlements that fail
- Target: < 2%
- Measured: Daily
- Action if > target: Investigate failure patterns

### 12.2 Webhook Reliability

**Metric: Webhook Delivery Success Rate**
- Definition: % of webhooks delivered successfully
- Target: > 99%
- Measured: Daily
- Action if < target: Check endpoint health

**Metric: Webhook Delivery Time**
- Definition: Average time from event to webhook delivery
- Target: < 5 minutes
- Measured: Daily
- Action if > target: Check network/endpoint latency

### 12.3 Operational Effectiveness

**Metric: Incident Response Time**
- Definition: Time from incident detection to acknowledgment
- Target: SEV-1: < 15 min; SEV-2: < 1 hour; SEV-3: < 4 hours
- Measured: Per incident
- Action if > target: Improve escalation process

**Metric: Mean Time to Resolution**
- Definition: Time from incident detection to fix
- Target: SEV-1: < 1 hour; SEV-2: < 2 hours; SEV-3: < 4 hours
- Measured: Per incident
- Action if > target: Improve debugging/fix procedures

**Metric: Escalation Accuracy**
- Definition: % of escalations that actually required Engineering
- Target: > 80%
- Measured: Monthly
- Action if < target: Provide more Operations training

### 12.4 Customer Impact

**Metric: Customer-Reported Issues Per Day**
- Definition: Count of customer support tickets per day
- Target: < 10
- Measured: Daily
- Action if > target: Investigate for systematic issues

**Metric: Unresolved Issues > 24 Hours**
- Definition: Count of issues open > 24 hours
- Target: < 2
- Measured: Daily
- Action if > target: Prioritize pending investigations

---

## 13. Operational Checklists

### 13.1 Daily Checklist

```
DAILY OPERATIONS CHECKLIST
Date: ________  Operator: ________________

MORNING REVIEW (30 min)
□ Log in to Operations Console
□ Check Dashboard for anomalies
□ Review failed transfers
□ Review failed webhooks
□ Check provider status pages
□ Scan audit logs for unusual activity
□ Review overnight escalations
□ Prepare daily report

SETTLEMENT MONITORING (Throughout day)
□ Monitor Processing settlements for delays
□ Check webhook delivery status
□ Verify cross-border settlement progress
□ Document any unusual delays

CUSTOMER ESCALATIONS (As they arrive)
□ Review support escalation
□ Investigate issue (5-10 min)
□ Respond with findings or escalate
□ Follow up if escalated

EVENING REVIEW (15 min)
□ Review today's incidents
□ Check for any lingering issues
□ Document in daily report
□ Handoff notes to next operator

DOCUMENTATION
□ Daily report completed: Yes / No
□ All escalations documented: Yes / No
□ Audit trail complete: Yes / No
```

### 13.2 Weekly Checklist

```
WEEKLY OPERATIONS CHECKLIST
Week of: ________  Operator: ________________

MONDAY
□ Review past weekend incidents
□ Check for recurring issues
□ Preview upcoming scheduled maintenance

MID-WEEK
□ Verify all pending escalations have updates
□ Check provider health trends
□ Identify any pattern issues

FRIDAY
□ Compile weekly operational report
□ Summarize incident trends
□ Identify improvement opportunities
□ Document for team meeting

WEEKLY REPORT
□ Total incidents: ________
□ SEV-1: ___  SEV-2: ___  SEV-3: ___
□ Customer impact: _____ customers
□ Escalations: _____ to Engineering
□ Recurring issues: [list]
□ Improvements implemented: [list]
```

### 13.3 Monthly Checklist

```
MONTHLY OPERATIONS CHECKLIST
Month of: ________  Operator: ________________

WEEK 1
□ Review previous month's incidents
□ Calculate monthly KPIs
□ Review provider performance
□ Identify trends

WEEK 2
□ Complete monthly ledger reconciliation
□ Verify balance correctness
□ Document any discrepancies found
□ Review compliance metrics

WEEK 3
□ Prepare monthly operations report
□ Analyze incident patterns
□ Document lessons learned
□ Plan improvements for next month

WEEK 4
□ Conduct training on identified gaps
□ Update operational procedures
□ Schedule postmortems for major incidents
□ Prepare dashboard for leadership review

MONTHLY REPORT
□ Total transactions: _________
□ Settlement success rate: _____%
□ Incident count: ___
□ Customer complaints: ___
□ Escalations: ___
□ Operational improvements: [list]
□ Recommended actions: [list]
```

---

## 14. Appendix: Terminology and Definitions

**ACH** — Automated Clearing House; US electronic transfer system

**AML** — Anti-Money Laundering; regulatory compliance program

**Correlation ID** — Unique identifier linking all related events in a settlement lifecycle

**Debit** — Amount removed from an account

**EFT** — Electronic Funds Transfer; Canadian transfer system

**FX** — Foreign Exchange; currency conversion

**KYC** — Know Your Customer; identity verification requirement

**Ledger** — Immutable record of all financial transactions

**Provider** — External service (Plaid, Stripe, Canadian bank network)

**SEV-1/2/3/4** — Incident severity levels

**Settlement** — Process of completing a transfer and moving funds

**Webhook** — HTTP callback sent by provider with transaction updates

---

## 15. Conclusion

This Operations Manual is the authoritative guide for operating Manna safely, compliantly, and reliably. It reflects our operational philosophy:

**Financial correctness first. Customer safety first. Every action auditable. Escalate when uncertain.**

Operations staff are empowered to investigate issues, support customers, and keep the platform running smoothly. Engineering staff are available for issues exceeding Operations authority.

By following these procedures, Manna maintains the trust of its customers and the integrity of their financial data.

---

**Document History:**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | June 2026 | Operations | Initial version |

**For Questions:**

Contact the Operations Manager or escalate to the Engineering team.

**Last Updated:** June 30, 2026  
**Classification:** Internal Use Only  
**Authorized By:** CTO

---
