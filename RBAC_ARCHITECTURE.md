# RBAC Architecture

## Overview

Milestone 4 implements production-grade Role-Based Access Control (RBAC) for Manna's Operations Platform. This provides secure, auditable admin access while maintaining complete separation from customer authentication.

## Architecture Principles

### 1. Complete Separation

**Admin and Customer Authentication are Completely Separate**:

```
Customer Users                          Admin Users
├─ users table                          ├─ admin_users table
├─ Customer JWT auth                    ├─ Admin session tokens
├─ User routes (/api/...)               └─ Admin routes (/api/admin/...)
└─ No admin access                      └─ No customer access
```

- `users` table: Customer accounts (login, KYC, balances)
- `admin_users` table: Admin accounts (roles, permissions, sessions)
- Customer routes do NOT check admin permissions
- Admin routes ONLY accept admin sessions

### 2. Default Deny

**Every permission is explicit, never inferred**:

```typescript
// Default: No permission
checkPermission('users:search') → false

// Explicit: Permission granted by role
role === 'FinancialInvestigator' && hasPermission('users:search') → true
```

- Admins have ONLY the permissions their role grants
- Missing permission = denied
- Adding new features = must explicitly grant permissions to roles

### 3. Minimal Privileges

**Each role has only what it needs**:

| Role | Permissions | Can Mutate | Can View Admin |
|------|------------|-----------|----------------|
| SuperAdmin | All | Yes | Yes |
| OperationsAdmin | Operations | Yes | No |
| FinancialInvestigator | Investigation | No | No |
| ComplianceOfficer | Compliance | No | No |
| ReadOnlyAuditor | Audit (masked) | No | No |

## Core Concepts

### Admin Roles (5 Total)

#### 1. SuperAdmin

- **Purpose**: Full administrative access
- **Permissions**: 40+ permissions across all categories
- **Capabilities**:
  - Manage admins (create, update, delete, change roles)
  - Manage roles and permissions
  - Run operational actions (retry, replay)
  - Investigate and search
  - Export audit logs
  - View unmasked sensitive data
- **Restrictions**: None

#### 2. OperationsAdmin

- **Purpose**: Run approved operational actions
- **Permissions**: ~15 operation-focused permissions
- **Capabilities**:
  - Retry and cancel transfers
  - Replay provider events
  - View settlements
  - Manage exceptions
  - Search and view user/transfer data
  - Read audit logs
- **Restrictions**:
  - Cannot create/delete admins
  - Cannot change RBAC
  - Cannot see unmasked sensitive data

#### 3. FinancialInvestigator

- **Purpose**: Search and investigate without mutation
- **Permissions**: ~10 read-only investigation permissions
- **Capabilities**:
  - Search users, transfers, wallets
  - View ledger and settlement data
  - Search provider events
  - Create investigation notes
  - Read audit logs
- **Restrictions**:
  - Cannot mutate any financial state
  - Cannot run recovery actions
  - Cannot see unmasked phone numbers

#### 4. ComplianceOfficer

- **Purpose**: Read audit logs and export reports
- **Permissions**: ~7 compliance permissions
- **Capabilities**:
  - Read audit logs
  - Export compliance reports
  - Review incidents
  - Search basic user/transfer data
  - Access compliance dashboards
- **Restrictions**:
  - Cannot mutate any state
  - Cannot run recovery actions
  - Cannot create admins
  - Cannot view sensitive KYC data

#### 5. ReadOnlyAuditor

- **Purpose**: View-only access with masked sensitive data
- **Permissions**: 2 masked read permissions
- **Capabilities**:
  - Read audit logs (masked)
  - View basic data (masked)
- **Restrictions**:
  - Cannot mutate any state
  - All sensitive fields masked
  - Cannot see unmasked emails, phones, tokens
  - Cannot investigate

## Permission Model

### Permission Categories

```
admin_management/
├─ admins:create          (SuperAdmin only)
├─ admins:read            (SuperAdmin only)
├─ admins:update          (SuperAdmin only)
├─ admins:delete          (SuperAdmin only)
├─ roles:manage           (SuperAdmin only)
└─ permissions:manage     (SuperAdmin only)

operations/
├─ transfers:retry
├─ transfers:cancel
├─ events:replay
├─ settlements:view
└─ exceptions:manage

investigation/
├─ users:search
├─ users:view_details
├─ transfers:view
├─ transfers:search
├─ wallets:view
├─ ledger:view
├─ provider_events:view
└─ investigations:create_notes

compliance/
├─ audit_logs:read
├─ audit_logs:export
├─ incidents:review
└─ compliance:read

audit/
├─ audit_logs:read_masked
└─ data:read_masked
```

### Permission Checking

```typescript
// In route handler
import { requirePermission, checkPermission } from '@/lib/rbac';

// Option 1: Explicit check
if (!checkPermission('transfers:retry')) {
  return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
}

// Option 2: Throw on deny
requirePermission('transfers:retry'); // Throws ForbiddenError if denied

// Role-specific checks
requireSuperAdmin();      // Only SuperAdmin
requireOperations();      // SuperAdmin or OperationsAdmin
forbidReadOnly();         // Not ReadOnlyAuditor or ComplianceOfficer
```

## Database Schema

### admin_users Table

```sql
CREATE TABLE admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,        -- SHA-256
  role TEXT NOT NULL,                  -- SuperAdmin, OperationsAdmin, etc.
  status TEXT NOT NULL DEFAULT 'active', -- active|inactive|suspended
  last_login_at TIMESTAMPTZ,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,           -- Account lockout timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### admin_roles Table

```sql
CREATE TABLE admin_roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- SuperAdmin, OperationsAdmin, etc.
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### admin_permissions Table

```sql
CREATE TABLE admin_permissions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,          -- admins:create, transfers:retry, etc.
  description TEXT,
  category TEXT NOT NULL,             -- admin_management, operations, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### role_permissions Table

```sql
CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES admin_roles(id),
  permission_id INTEGER NOT NULL REFERENCES admin_permissions(id),
  PRIMARY KEY (role_id, permission_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### admin_sessions Table

```sql
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,                -- Random session ID
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
  token_hash TEXT NOT NULL,           -- SHA-256 hash of session token
  expires_at TIMESTAMPTZ NOT NULL,    -- Session expiration
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### admin_audit_logs Table

```sql
-- Prepared for Milestone 5 (hooks in place, not yet populated)
CREATE TABLE admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
  action TEXT NOT NULL,               -- create_transfer, retry_event, etc.
  resource_type TEXT NOT NULL,        -- transfer_intent, provider_event, etc.
  resource_id TEXT,
  changes JSONB,                      -- What changed {field: {old, new}}
  correlation_id VARCHAR(255),        -- Link to request
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Sensitive Data Masking

### Fields That Are Masked

For non-SuperAdmin roles:

```typescript
users:
- email (a***@example.com)
- phone (***-***-****)
- kyc_session_id (full mask)
- kyc_provider (full mask)

bank_accounts:
- plaid_access_token_enc (full mask)
- plaid_item_id (full mask)
- account_mask (****1234 - last 4 digits only)

admin_audit_logs:
- ip_address (192.168.1.*** - last octet masked)
- user_agent (full mask)
```

### Masking Rules

```typescript
// By role
SuperAdmin      → No masking
OperationsAdmin → Mask sensitive
FinancialInv.   → Mask sensitive
ComplianceOff.  → Mask sensitive
ReadOnlyAuditor → Aggressive masking

// Email masking
alice@example.com → a***@example.com

// Phone masking
555-123-4567 → ***-***-****

// IP masking
192.168.1.100 → 192.168.1.***

// Account number
1234567890123456 → ****3456
```

## Authentication Flow

### Admin Login

```
1. POST /api/admin/login
   - Email & password
   ↓
2. AdminRepository.findAdminByEmail(email)
   - Get admin user from admin_users table
   ↓
3. Verify password
   - Check: SHA-256(password) === password_hash
   ↓
4. Check status
   - Status must be 'active'
   - Not locked (locked_until < now)
   ↓
5. Create session
   - Generate random session ID
   - Create admin_sessions record
   - Return session token in cookie
```

### Request Authentication

```
1. Client sends request with admin_session cookie
2. withAdminAuth middleware intercepts
3. Extract session ID from cookie
4. AdminRepository.findSession(sessionId)
   - Verify session exists
   - Verify not expired
5. Get admin user
6. Load permissions from ROLE_PERMISSIONS
7. Store in adminContextStorage
8. Handler can call getAdminContext()
```

## Usage in Routes

### Protected Admin Route

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { 
  withAdminAuth, 
  requirePermission, 
  getCurrentAdmin,
  maskSensitiveFields 
} from '@/lib/rbac';

export async function POST(req: NextRequest) {
  return withAdminAuth(req, async (req) => {
    // Admin authenticated at this point
    const admin = getCurrentAdmin();

    // Check permission (explicit deny if not present)
    requirePermission('transfers:retry');

    // Do work...
    const transfer = await getTransferIntentRepository().findById(id);

    // Mask sensitive fields in response
    const masked = maskSensitiveFields(transfer, 'transfers');

    return NextResponse.json(masked);
  });
}
```

### Role-Specific Route

```typescript
import { requireSuperAdmin, requireOperations } from '@/lib/rbac';

export async function POST(req: NextRequest) {
  return withAdminAuth(req, async (req) => {
    // Only SuperAdmin can delete admins
    requireSuperAdmin();

    const adminId = await req.json();
    await getAdminRepository().deleteAdmin(adminId);

    return NextResponse.json({ success: true });
  });
}
```

## Audit Hooks (Milestone 5 Preparation)

### Current State (Milestone 4)

RBAC provides hooks for audit logging but does NOT persist logs:

```typescript
import { auditLogAction } from '@/lib/rbac';

// Called but not persisted
auditLogAction({
  action: 'transfer_retry',
  resource_type: 'transfer_intent',
  resource_id: '123',
  changes: {
    status: { old: 'failed', new: 'processing' }
  }
});
```

Logs appear in console but are not saved to `admin_audit_logs` table.

### Milestone 5 Implementation

In Milestone 5, `auditLogAction` will:

1. Get admin context (user, IP, user agent, correlation_id)
2. Hash sensitive data if needed
3. Insert into admin_audit_logs table
4. Return audit log ID

```typescript
// Milestone 5: This will persist
const logId = await auditLogAction({...});
```

## Backward Compatibility

**✅ ZERO BREAKING CHANGES**

- Existing customer auth continues unchanged
- Existing settlement flows continue unchanged
- Existing webhook flows continue unchanged
- No changes to user/transaction/ledger tables
- Admin and customer systems are completely separate

## Security Guarantees

### Access Control

- ✅ Admin access separate from customer
- ✅ Default deny (must have explicit permission)
- ✅ Minimal privilege per role
- ✅ Session tokens are hashed (SHA-256)
- ✅ Sessions expire (configurable TTL)
- ✅ Failed login attempts tracked and lockout enforced

### Data Protection

- ✅ Sensitive fields masked for non-SuperAdmin
- ✅ Email partially masked (a***)
- ✅ Phone fully masked (***-***-****)
- ✅ Tokens/IDs removed from responses
- ✅ IP addresses partially masked

### Audit Trail

- ✅ Admin audit logs table prepared
- ✅ Audit hooks in place
- ✅ Correlation IDs link to requests
- ✅ Ready for Milestone 5 implementation

## Known Limitations & Future Work

### Current (Milestone 4)

- ✅ RBAC implemented
- ✅ Permissions enforced
- ✅ Sensitive data masking
- ✗ Audit logs not persisted (Milestone 5)
- ✗ No admin UI (future)
- ✗ No recovery APIs (Milestone 5+)
- ✗ No admin dashboard (future)

### Future

- Implement audit logging (Milestone 5)
- Add role change audit trails
- Implement session audit logs
- Build admin dashboard
- Add IP whitelisting per role
- Add MFA for SuperAdmin

## Testing Strategy

### Unit Tests (26 tests covering)

- ✅ SuperAdmin permissions (full access)
- ✅ OperationsAdmin permissions (operations only)
- ✅ FinancialInvestigator permissions (read-only investigation)
- ✅ ComplianceOfficer permissions (audit logs only)
- ✅ ReadOnlyAuditor permissions (masked read-only)
- ✅ Default deny behavior
- ✅ Sensitive data masking
- ✅ Role capability checks
- ✅ Permission hierarchy

### Integration Tests (Future)

- Admin login/logout flow
- Session expiration
- Failed login lockout
- Permission enforcement at route level
- Audit log creation

## Conclusion

Milestone 4 provides a secure, auditable RBAC foundation for admin operations. The system enforces default deny, maintains clear separation from customer auth, and masks sensitive data appropriately. Audit hooks are prepared for Milestone 5.
