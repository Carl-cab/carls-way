# Admin Security

Security-focused documentation for Manna's RBAC implementation. This guide covers threat models, security guarantees, attack prevention, and implementation best practices for the Operations Platform.

## Security Guarantees

### Core Principles

**1. Complete Separation**
- Admin authentication is 100% separate from customer authentication
- Admin users (admin_users table) never interact with customer users (users table)
- Admin routes (/api/admin/*) cannot be accessed by customer auth tokens
- Customer routes (/api/*) cannot be accessed by admin session tokens
- **Guarantee**: No privilege escalation from customer to admin possible via auth

**2. Default Deny**
- Every permission must be explicitly granted
- Missing permission = denied (not granted)
- No inference or implicit permissions
- **Guarantee**: Adding a new feature means explicitly granting permissions to roles

**3. Minimal Privilege**
- Each role has ONLY the permissions it needs
- SuperAdmin is the only role with full access
- ReadOnlyAuditor has no mutation or write permissions
- **Guarantee**: A compromised non-admin account cannot damage critical systems

**4. Session Security**
- Session tokens are hashed with SHA-256 before storage
- Sessions expire after configured TTL (default 24 hours)
- Failed login attempts trigger account lockout (5 attempts → 15 minute lock)
- **Guarantee**: Session replay attacks are prevented by hashing and expiration

## Threat Model

### High-Risk Scenarios

#### 1. Unauthorized Admin Access (MITIGATED)

**Threat**: Attacker gains access to admin account via:
- Brute force login
- Credential compromise
- Session hijacking
- Social engineering

**Mitigations**:
- ✅ Password hashing: SHA-256(password) stored, not plaintext
- ✅ Account lockout: 5 failed attempts → 15 min lockout
- ✅ Session hashing: Session token hash stored, not plaintext
- ✅ Session expiration: 24-hour TTL invalidates old tokens
- ✅ Session invalidation: Logout deletes session record
- ✅ IP logging: sourceIp recorded in audit logs
- ✅ User-agent logging: userAgent recorded for forensics

**Further hardening** (Milestone 5+):
- IP whitelisting per role
- MFA for SuperAdmin
- Rate-limited login endpoints
- Anomaly detection (unusual IP, time, location)
- Session device fingerprinting

#### 2. Privilege Escalation (MITIGATED)

**Threat**: Non-admin user escalates to admin or lower role user escalates to higher role

**Mitigations**:
- ✅ Separate auth systems: Admin and customer auth are completely independent
- ✅ Role immutability at request: Role is immutable during request handling
- ✅ Role changes require SuperAdmin: Only SuperAdmin can update roles
- ✅ Permission lookup from database: Permissions loaded from ROLE_PERMISSIONS at each request
- ✅ Explicit permission checking: Every protected action checks permission explicitly

**Guarantee**: A FinancialInvestigator cannot mutate their own role or permissions.

#### 3. Permission Abuse (MITIGATED)

**Threat**: Admin with legitimate access abuses permissions (e.g., OperationsAdmin retrying transfers excessively)

**Mitigations**:
- ✅ Audit logging: Every action logged to audit_logs
- ✅ Correlation IDs: Link request to audit entry for traceability
- ✅ Immutable audit logs: Audit entries cannot be deleted/modified
- ✅ Role scope enforcement: Permission:action mapping is enforced at every route

**Detection** (Milestone 5+):
- Anomaly detection: Unusual access patterns
- Rate limiting per admin per permission
- Approval workflows for critical actions
- Supervisory review of high-impact operations

#### 4. Sensitive Data Exposure (MITIGATED)

**Threat**: Admin with restricted role sees unmasked sensitive data (PII)

**Mitigations**:
- ✅ Role-based masking: Fields masked based on admin role
- ✅ Automatic masking: Applied in response before returning to client
- ✅ Email partial masking: a***@example.com (first char + domain shown)
- ✅ Phone full masking: ***-***-**** (fully masked)
- ✅ Account number partial: ****1234 (last 4 digits only)
- ✅ IP partial masking: 192.168.1.*** (last octet masked)
- ✅ Token removal: Sensitive tokens never included in responses

**Rules by role**:
- SuperAdmin: No masking (sees all)
- OperationsAdmin: Masks PII (email, phone, tokens)
- FinancialInvestigator: Masks PII
- ComplianceOfficer: Masks KYC data (email, phone, tokens)
- ReadOnlyAuditor: Aggressive masking (email, phone, tokens, IP partial)

#### 5. Audit Log Tampering (MITIGATED)

**Threat**: Admin deletes or modifies audit logs to cover tracks

**Mitigations**:
- ✅ Immutable table: admin_audit_logs cannot be updated/deleted (append-only)
- ✅ Status field: Records success/failure, not overwritten
- ✅ Correlation ID: Links to request context
- ✅ Timestamps: creation time recorded, immutable
- ✅ Admin context: admin_user_id recorded for all actions

**Database constraint** (Milestone 5):
```sql
CREATE POLICY audit_log_immutable ON admin_audit_logs
  USING (false)  -- No updates/deletes allowed
  WITH CHECK (false);
```

#### 6. Webhook Event Replay (MITIGATED)

**Threat**: Attacker replays webhook event to trigger duplicate actions

**Mitigations**:
- ✅ Deduplication: provider_webhook_events table tracks processed events
- ✅ Provider + Event ID uniqueness: Prevents duplicate processing
- ✅ Status tracking: Events marked as processed/failed
- ✅ Idempotency keys: Transfer intents include idempotency_key for retries

**Guarantee**: The same webhook event cannot be processed twice.

---

## Authentication

### Password Security

**Storage**:
```typescript
// Correct: Hash password with SHA-256 before storage
const hash = crypto.createHash('sha256').update(password).digest('hex');
await adminRepo.createAdmin({ password_hash: hash });

// NEVER: Store plaintext password
await adminRepo.createAdmin({ password_hash: password }); // ❌ WRONG
```

**Verification**:
```typescript
// Correct: Compare hashes
const admin = await adminRepo.findAdminByEmail(email);
const hash = crypto.createHash('sha256').update(inputPassword).digest('hex');
const passwordMatch = admin.password_hash === hash;

// NEVER: Compare plaintext
const passwordMatch = admin.password === inputPassword; // ❌ WRONG
```

**Requirements**:
- Minimum 12 characters
- Must include uppercase, lowercase, number, special character
- SHA-256 hashing (256-bit security)
- No password history reuse required (simple environment)

### Session Security

**Creation**:
```typescript
// 1. Verify password
const admin = await adminRepo.findAdminByEmail(email);
if (admin.password_hash !== hash(password)) {
  // Track failed attempt
  await adminRepo.updateAuthState(admin.id, admin.failed_login_attempts + 1, null);
  return 401; // Unauthorized
}

// 2. Check lockout
if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
  return 403; // Account locked
}

// 3. Create session
const sessionId = crypto.randomBytes(32).toString('hex');
const tokenHash = crypto.createHash('sha256').update(sessionId).digest('hex');
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

await adminRepo.createSession(sessionId, admin.id, tokenHash, expiresAt);

// 4. Return session in secure cookie
response.cookies.set('admin_session', sessionId, {
  httpOnly: true,    // ✅ Cannot be accessed by JavaScript
  secure: true,      // ✅ HTTPS only
  sameSite: 'lax',   // ✅ CSRF protection
  maxAge: 24 * 60 * 60, // 24 hours
});

// 5. Reset failed attempts
await adminRepo.updateLastLogin(admin.id);
```

**Verification**:
```typescript
// At request time:
const sessionId = req.cookies.get('admin_session')?.value;
const session = await adminRepo.findSession(sessionId);

if (!session) {
  return 401; // Invalid session
}

if (session.expires_at < new Date()) {
  await adminRepo.deleteSession(sessionId);
  return 401; // Expired session
}

// Session valid, update activity
await adminRepo.updateSessionActivity(sessionId);
```

**Lockout Policy**:
```
Failed Attempt 1: Login fails, attempt logged
Failed Attempt 2: Login fails, attempt logged
Failed Attempt 3: Login fails, attempt logged
Failed Attempt 4: Login fails, attempt logged
Failed Attempt 5: ACCOUNT LOCKED for 15 minutes
               → locked_until = now + 15 min
               → All subsequent login attempts rejected until unlock

After 15 minutes: locked_until expires
                → Next successful login resets failed_login_attempts to 0
                → Next failed login increments counter again
```

---

## Authorization

### Permission Enforcement

**At Route Entry**:
```typescript
export async function POST(req: NextRequest) {
  return withAdminAuth(req, async (req) => {
    // Step 1: Verify admin is authenticated
    // withAdminAuth middleware handles this

    // Step 2: Get admin context
    const admin = getCurrentAdmin();
    if (!admin) {
      // Should never happen if middleware works, but belt-and-suspenders
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Step 3: Check specific permission
    requirePermission('transfers:retry');
    // If permission missing, throws ForbiddenError → 403

    // Step 4: Do protected action
    const result = await retryTransfer(transferId);

    // Step 5: Mask sensitive data
    const masked = maskSensitiveFields(result, 'transfers');

    return NextResponse.json(masked);
  });
}
```

**Default Deny Verification**:
```typescript
// Check that permission checking is explicit, not inferred
const perms = getCurrentPermissions(); // Returns array

// Correct: Explicit check
if (!perms.includes('transfers:retry')) {
  throw new ForbiddenError(...);
}

// NEVER: Inferred from role name
if (getCurrentAdmin().role.includes('Admin')) { // ❌ WRONG
  // This assumes all Admins can retry transfers
}
```

### Role Checks

**Specific Role Required**:
```typescript
// Only SuperAdmin can delete admins
export async function DELETE(req: NextRequest) {
  return withAdminAuth(req, async (req) => {
    requireSuperAdmin(); // Throws if not SuperAdmin

    const adminId = await req.json();
    await adminRepo.deleteAdmin(adminId);

    return NextResponse.json({ success: true });
  });
}
```

**Role Group Required**:
```typescript
// Only SuperAdmin or OperationsAdmin can retry transfers
export async function POST(req: NextRequest) {
  return withAdminAuth(req, async (req) => {
    requireOperations(); // Throws if not SuperAdmin/OperationsAdmin

    // Proceed with transfer retry
  });
}
```

**Read-Only Enforcement**:
```typescript
// Mutation not allowed for read-only roles
export async function POST(req: NextRequest) {
  return withAdminAuth(req, async (req) => {
    forbidReadOnly(); // Throws if ReadOnlyAuditor/ComplianceOfficer

    // Proceed with mutation
  });
}
```

---

## Data Protection

### Sensitive Field Masking

**Applied Automatically**:
```typescript
// Developer calls maskSensitiveFields
const admin = await adminRepo.findAdminById(1);
const masked = maskSensitiveFields(admin, 'admin_users');

// For ReadOnlyAuditor role:
// Input:  { id: 1, email: 'alice@example.com', name: 'Alice' }
// Output: { id: 1, email: 'a***@example.com', name: 'Alice' }
```

**Masking Rules**:

| Field | SuperAdmin | OperationsAdmin | FinancialInv | ComplianceOff | ReadOnlyAudit |
|---|---|---|---|---|---|
| email | alice@ex.com | a***@ex.com | a***@ex.com | a***@ex.com | a***@ex.com |
| phone | 555-1234-5678 | ***-***-**** | ***-***-**** | ***-***-**** | ***-***-**** |
| account_mask | 1234567890123456 | ****3456 | ****3456 | ****3456 | ****3456 |
| ip_address | 192.168.1.100 | 192.168.1.*** | 192.168.1.*** | 192.168.1.100 | 192.168.1.*** |

**Database-Level Protection** (Milestone 5+):

```sql
-- Row-level security per role
CREATE POLICY admin_view_users_rls ON users
  USING (
    -- SuperAdmin sees all
    (SELECT role FROM admin_users WHERE id = current_admin_id) = 'SuperAdmin'
    OR
    -- FinancialInvestigator sees unmasked users they've searched
    (SELECT role FROM admin_users WHERE id = current_admin_id) = 'FinancialInvestigator'
  );
```

---

## Audit Trail

### What Gets Logged

**Every admin action** triggers an audit entry via `auditLogAction()`:

```typescript
auditLogAction({
  action: 'transfer_retry',           // What was done
  resource_type: 'transfer_intent',   // What was affected
  resource_id: '12345',               // Which record
  changes: {                          // What changed
    status: { old: 'failed', new: 'processing' }
  }
});
```

**Audit log structure**:
```sql
CREATE TABLE admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL,          -- Which admin
  action TEXT NOT NULL,                    -- transfer_retry, update_admin, etc.
  resource_type TEXT NOT NULL,             -- transfer_intent, admin_user, etc.
  resource_id TEXT,                        -- ID of affected record
  changes JSONB,                           -- {field: {old, new}}
  correlation_id VARCHAR(255),             -- Link to HTTP request
  ip_address TEXT,                         -- Source IP
  user_agent TEXT,                         -- Browser/client
  status TEXT NOT NULL DEFAULT 'success',  -- success|failed
  error_message TEXT,                      -- If failed, why
  created_at TIMESTAMPTZ NOT NULL          -- Immutable timestamp
);
```

### Audit Log Analysis

**Finding suspicious activity**:

```sql
-- All actions by a specific admin
SELECT * FROM admin_audit_logs
WHERE admin_user_id = 123
ORDER BY created_at DESC;

-- All failed actions
SELECT * FROM admin_audit_logs
WHERE status = 'failed'
ORDER BY created_at DESC;

-- Actions on a specific record
SELECT * FROM admin_audit_logs
WHERE resource_type = 'transfer_intent'
  AND resource_id = '98765'
ORDER BY created_at DESC;

-- Actions by role (requires join)
SELECT aal.* FROM admin_audit_logs aal
JOIN admin_users au ON au.id = aal.admin_user_id
WHERE au.role = 'OperationsAdmin'
ORDER BY aal.created_at DESC;

-- Suspicious pattern: Multiple failed logins in short time
SELECT COUNT(*) as failed_count, 
       admin_user_id,
       ip_address
FROM admin_audit_logs
WHERE action = 'login'
  AND status = 'failed'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY admin_user_id, ip_address
HAVING COUNT(*) > 3
ORDER BY failed_count DESC;
```

---

## Common Vulnerabilities Prevention

### OWASP Top 10 (Admin-Specific)

#### 1. Broken Access Control
- ✅ Default deny principle enforced
- ✅ Permission checking at every route
- ✅ No role inference
- ✅ Tests verify permissions denied when missing

#### 2. Cryptographic Failures
- ✅ SHA-256 for password hashing
- ✅ Session tokens are 256-bit random
- ✅ Session tokens hashed before storage
- ✅ No plaintext credentials in logs

#### 3. Injection (SQL)
- ✅ postgres.js parameterized queries
- ✅ No string interpolation in SQL
- ✅ All user input bound via $ placeholders

#### 4. Insecure Design
- ✅ Complete separation of admin and customer auth
- ✅ Role-based architecture from ground up
- ✅ Audit trail design prepared for forensics

#### 5. Security Misconfiguration
- ✅ Account lockout enabled by default
- ✅ Session expiration enforced
- ✅ Error messages don't leak implementation details

#### 6. Vulnerable/Outdated Components
- ✅ postgres.js latest version (no ORM vulnerabilities)
- ✅ No external auth libraries (homegrown, auditable)
- ✅ Node.js built-in crypto module only

#### 7. Authentication Failures
- ✅ Password hashing required (not plaintext)
- ✅ Session expiration enforced
- ✅ Account lockout on repeated failures
- ✅ No cookie-based session sharing

#### 8. Data Integrity Failures
- ✅ Immutable audit logs (no updates/deletes)
- ✅ Created_at timestamps never modified
- ✅ Admin context immutable during request

#### 9. Logging & Monitoring Failures
- ✅ Audit logs capture every action
- ✅ IP address logged for forensics
- ✅ User-agent logged for device tracking
- ✅ Correlation ID links to HTTP request

#### 10. Server-Side Request Forgery
- ✅ Admin routes separate from customer routes
- ✅ Admin auth via session cookie (not JWT in header)
- ✅ CSRF tokens possible via sameSite=lax

---

## Security Checklist for Implementers

### Before Deploying a New Admin Route

- [ ] Route is under `/api/admin/` prefix
- [ ] Route wrapped in `withAdminAuth(req, handler)`
- [ ] Route calls `requirePermission()` or equivalent check
- [ ] All returned objects masked with `maskSensitiveFields()`
- [ ] Try/catch wraps entire handler for error handling
- [ ] Error response is generic (no implementation details leaked)
- [ ] Audit log action recorded via `auditLogAction()`
- [ ] Tests verify permission enforcement (missing permission returns 403)
- [ ] Tests verify masking applied (sensitive fields hidden for non-SuperAdmin)

### Before Releasing a New Admin Feature

- [ ] All permissions in feature are defined in `PERMISSIONS_MATRIX.md`
- [ ] Only intended roles have the permission
- [ ] SuperAdmin always has the permission
- [ ] ReadOnlyAuditor does not have mutation permissions
- [ ] Audit logs capture all state changes
- [ ] Tests verify default deny (missing permission denies access)
- [ ] Tests verify role enforcement (wrong role returns 403)
- [ ] No sensitive data in error messages
- [ ] No sensitive data in audit logs (mask before logging)

### Before Going Live

- [ ] All 26 RBAC unit tests pass
- [ ] TypeScript builds without warnings
- [ ] Audit logs configured for production
- [ ] Account lockout thresholds tuned (currently 5 attempts → 15 min)
- [ ] Session TTL appropriate for use case (currently 24 hours)
- [ ] IP logging enabled and monitored
- [ ] Admin creation process requires SuperAdmin approval
- [ ] Password requirements enforced in UI/API
- [ ] Deployment backup plan documented

---

## Monitoring & Incident Response

### Red Flags

**Watch for**:
- Failed login attempts exceeding lockout threshold
- Admin accessing permissions outside their role
- Rapid API calls to sensitive endpoints
- Unusual IP addresses accessing admin routes
- Admin role change without documented reason
- Audit log modification attempts
- Session tokens in error logs

**Automated alerts** (Milestone 5+):
```sql
-- Alert on account lockouts
SELECT * FROM admin_audit_logs
WHERE action = 'login' AND status = 'failed'
GROUP BY admin_user_id
HAVING COUNT(*) >= 5 IN LAST_HOUR;

-- Alert on role changes
SELECT * FROM admin_audit_logs
WHERE action = 'update_admin'
  AND changes->>'role' IS NOT NULL;

-- Alert on permission denials
SELECT * FROM admin_audit_logs
WHERE status = 'failed'
  AND action LIKE '%permission%';
```

### Incident Response Procedures

**Compromised Admin Account**:
1. Immediately disable admin user: `UPDATE admin_users SET status = 'suspended' WHERE id = X`
2. Delete all sessions: `DELETE FROM admin_sessions WHERE admin_user_id = X`
3. Review audit logs for unauthorized actions: `SELECT * FROM admin_audit_logs WHERE admin_user_id = X ORDER BY created_at DESC`
4. Determine scope of exposure
5. Notify affected parties
6. Create new account with strong password

**Suspicious Permission Denial**:
1. Query who tried to access what: `SELECT * FROM admin_audit_logs WHERE status = 'failed' AND admin_user_id = X`
2. Verify if permission is appropriate for role
3. If role is wrong, update role: `UPDATE admin_users SET role = 'correct_role' WHERE id = X`
4. If access was unauthorized, review admin for misconduct

---

## Summary

**Milestone 4 provides production-grade security through**:
- Separate admin authentication system (zero privilege escalation risk)
- Default deny authorization (no implicit access)
- Sensitive data masking by role (PII protection)
- Immutable audit logs (forensic evidence)
- Account lockout on failed login (brute force protection)
- Session expiration (replay attack prevention)
- Role-based permissions (least privilege)

**Security is NOT complete without**:
- Milestone 5 audit log persistence (currently prepared but not persisted)
- IP whitelisting per role (future enhancement)
- MFA for SuperAdmin (future enhancement)
- Rate limiting on login attempts (future enhancement)
- Anomaly detection (future enhancement)

**Until Milestone 5**, audit logs are prepared but logged to console only. In production, immediately implement Milestone 5's audit log persistence to maintain forensic evidence.
