# Permissions Matrix

## Quick Reference

Complete mapping of permissions by role. This is the source of truth for RBAC.

| Permission | SuperAdmin | OpsAdmin | FinancialInv | Compliance | ReadOnly |
|---|---|---|---|---|---|
| **Admin Management** | | | | | |
| admins:create | ✅ | ❌ | ❌ | ❌ | ❌ |
| admins:read | ✅ | ❌ | ❌ | ❌ | ❌ |
| admins:update | ✅ | ❌ | ❌ | ❌ | ❌ |
| admins:delete | ✅ | ❌ | ❌ | ❌ | ❌ |
| roles:manage | ✅ | ❌ | ❌ | ❌ | ❌ |
| permissions:manage | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Operations** | | | | | |
| transfers:retry | ✅ | ✅ | ❌ | ❌ | ❌ |
| transfers:cancel | ✅ | ✅ | ❌ | ❌ | ❌ |
| events:replay | ✅ | ✅ | ❌ | ❌ | ❌ |
| settlements:view | ✅ | ✅ | ❌ | ❌ | ✅ |
| exceptions:manage | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Investigation** | | | | | |
| users:search | ✅ | ✅ | ✅ | ✅ | ❌ |
| users:view_details | ✅ | ✅ | ✅ | ❌ | ❌ |
| transfers:view | ✅ | ✅ | ✅ | ✅ | ✅ |
| transfers:search | ✅ | ✅ | ✅ | ❌ | ❌ |
| wallets:view | ✅ | ❌ | ✅ | ❌ | ❌ |
| ledger:view | ✅ | ❌ | ✅ | ❌ | ❌ |
| provider_events:view | ✅ | ✅ | ✅ | ✅ | ❌ |
| investigations:create_notes | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Compliance** | | | | | |
| audit_logs:read | ✅ | ✅ | ✅ | ✅ | ❌ |
| audit_logs:export | ✅ | ❌ | ❌ | ✅ | ❌ |
| incidents:review | ✅ | ❌ | ❌ | ✅ | ❌ |
| compliance:read | ✅ | ❌ | ❌ | ✅ | ❌ |
| **Masked Read** | | | | | |
| audit_logs:read_masked | ✅ | ❌ | ❌ | ❌ | ✅ |
| data:read_masked | ✅ | ❌ | ❌ | ❌ | ✅ |

## Summary by Role

### SuperAdmin

**Total Permissions**: 40+

**Category Breakdown**:
- Admin Management: 6 ✅ (create, read, update, delete, manage roles, manage permissions)
- Operations: 5 ✅ (retry, cancel, replay, view settlements, manage exceptions)
- Investigation: 8 ✅ (all search/view permissions)
- Compliance: 4 ✅ (read logs, export, review incidents, read compliance)
- Masked Read: 2 ✅ (all masked reads)

**Can Mutate**: Yes (all operations)
**Can View Unmasked**: Yes (sensitive data not masked)
**Can Manage Admins**: Yes
**Can Manage RBAC**: Yes

**Use Case**: Full administrative access for platform managers

---

### OperationsAdmin

**Total Permissions**: 15

**Category Breakdown**:
- Admin Management: 0 ❌
- Operations: 5 ✅ (retry, cancel, replay, view settlements, manage exceptions)
- Investigation: 5 ✅ (search users, view transfers, search transfers, view events, read audit logs)
- Compliance: 0 ❌
- Masked Read: 0 ❌

**Can Mutate**: Yes (operations only, no admin/RBAC)
**Can View Unmasked**: Partial (operations data not masked)
**Can Manage Admins**: No
**Can Manage RBAC**: No

**Use Case**: Run operational fixes like transfer retries, replay events

---

### FinancialInvestigator

**Total Permissions**: 10

**Category Breakdown**:
- Admin Management: 0 ❌
- Operations: 0 ❌
- Investigation: 8 ✅ (all search/view + create notes)
- Compliance: 1 ✅ (read audit logs)
- Masked Read: 0 ❌

**Can Mutate**: No (investigation notes only, read-only)
**Can View Unmasked**: Partial (phone numbers masked)
**Can Manage Admins**: No
**Can Manage RBAC**: No

**Use Case**: Search and investigate transfers, users, ledger entries

---

### ComplianceOfficer

**Total Permissions**: 7

**Category Breakdown**:
- Admin Management: 0 ❌
- Operations: 0 ❌
- Investigation: 3 ✅ (search users, view transfers, view events)
- Compliance: 4 ✅ (all compliance permissions)
- Masked Read: 0 ❌

**Can Mutate**: No
**Can View Unmasked**: Partial (KYC data masked)
**Can Manage Admins**: No
**Can Manage RBAC**: No

**Use Case**: Review audit logs, export compliance reports

---

### ReadOnlyAuditor

**Total Permissions**: 3

**Category Breakdown**:
- Admin Management: 0 ❌
- Operations: 0 ❌
- Investigation: 0 ❌
- Compliance: 0 ❌
- Masked Read: 2 ✅ (read masked audit logs, read masked data)
- Other: 1 ✅ (view settlements - basic)

**Can Mutate**: No
**Can View Unmasked**: No (all sensitive data masked)
**Can Manage Admins**: No
**Can Manage RBAC**: No

**Use Case**: View-only audit access with no access to sensitive data

---

## Permission Categories

### Admin Management (6 permissions)

Control who has access to what. Only SuperAdmin.

| Permission | Purpose |
|---|---|
| admins:create | Create new admin user |
| admins:read | View admin user details |
| admins:update | Update admin user info/role |
| admins:delete | Delete admin user |
| roles:manage | Create/update/delete roles (future) |
| permissions:manage | Assign permissions to roles (future) |

---

### Operations (5 permissions)

Run operational actions on financial transfers and events.

| Permission | Purpose | Scope |
|---|---|---|
| transfers:retry | Retry a failed transfer | OperationsAdmin+ |
| transfers:cancel | Cancel a pending transfer | OperationsAdmin+ |
| events:replay | Replay a webhook event | OperationsAdmin+ |
| settlements:view | View settlement history | OperationsAdmin+ |
| exceptions:manage | Create/update exceptions | OperationsAdmin+ |

---

### Investigation (8 permissions)

Search and view financial data for investigation.

| Permission | Purpose | Scope |
|---|---|---|
| users:search | Search by username/email | FinancialInv+ |
| users:view_details | View user KYC/profile | FinancialInv+ |
| transfers:view | View single transfer | FinancialInv+ |
| transfers:search | Search transfers by criteria | FinancialInv+ |
| wallets:view | View wallet balances | FinancialInv+ |
| ledger:view | View ledger entries | FinancialInv+ |
| provider_events:view | View webhook events | FinancialInv+ |
| investigations:create_notes | Create investigation notes | FinancialInv+ |

---

### Compliance (4 permissions)

Read audit logs and compliance data.

| Permission | Purpose | Scope |
|---|---|---|
| audit_logs:read | Read admin audit logs | Compliance+ |
| audit_logs:export | Export audit logs | ComplianceOfficer+ |
| incidents:review | Review compliance incidents | ComplianceOfficer+ |
| compliance:read | Read compliance data/reports | ComplianceOfficer+ |

---

### Masked Read (2 permissions)

Read-only access with sensitive data masked.

| Permission | Purpose | Scope |
|---|---|---|
| audit_logs:read_masked | Read audit logs (masked) | ReadOnlyAuditor+ |
| data:read_masked | Read any data (masked) | ReadOnlyAuditor+ |

---

## Role Hierarchy

```
SuperAdmin
    ↓ (has all permissions from below)
OperationsAdmin
    ↓ (some overlap)
FinancialInvestigator
    ↓ (overlaps with ComplianceOfficer in audit logs)
ReadOnlyAuditor

ComplianceOfficer
    ↓ (parallel to Investigator, has audit logs)
ReadOnlyAuditor
```

**Not a strict hierarchy**: Each role is designed for a specific function. Some permissions overlap (e.g., both OperationsAdmin and FinancialInvestigator can view transfers), but they're not interchangeable.

---

## Adding Permissions

### When to Add a New Permission

1. New operational feature (new mutation)
2. New investigation capability (new read)
3. New admin function (RBAC changes)

### How to Add a Permission

1. Add to `Permission` type in `lib/rbac/types.ts`
2. Add to `ROLE_PERMISSIONS` for appropriate roles
3. Add to this matrix
4. Add unit test verifying role has/doesn't have permission
5. Update route handlers to check permission
6. Document in RBAC_ARCHITECTURE.md

### Example: Adding "transfers:export"

```typescript
// 1. Add to type
export type Permission =
  | ...existing...
  | 'transfers:export';  // NEW

// 2. Add to roles
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  SuperAdmin: [..., 'transfers:export'],           // ✅
  OperationsAdmin: [..., 'transfers:export'],      // ✅ (they need this)
  FinancialInvestigator: [...],                     // ❌ (not for them)
  ComplianceOfficer: [...],                         // ❌
  ReadOnlyAuditor: [...],                           // ❌
};

// 3. Update this matrix (PERMISSIONS_MATRIX.md)
// 4. Add test
// 5. Use in route
//    requirePermission('transfers:export');
// 6. Document
```

---

## Masking Rules by Role

### What Gets Masked

```
SuperAdmin        → NONE (sees all)
OperationsAdmin   → Phone, Tokens, KYC IDs (sees operations data)
FinancialInv.     → Phone, Tokens, Provider IDs
ComplianceOfficer → Phone, Tokens, KYC data, Provider details
ReadOnlyAuditor   → Email (partial), Phone, Tokens, KYC data, IPs (partial)
```

### Examples

**Email Address**
- SuperAdmin:        `alice@example.com` (unmasked)
- Others:            `a***@example.com` (first letter + ***, domain shown)

**Phone Number**
- SuperAdmin:        `555-123-4567` (unmasked)
- Others:            `***-***-****` (fully masked)

**IP Address**
- SuperAdmin:        `192.168.1.100` (unmasked)
- ComplianceOff.:    `192.168.1.100` (full - they need it for audit)
- ReadOnlyAuditor:   `192.168.1.***` (last octet masked)

**Account Number**
- SuperAdmin:        `1234567890123456` (unmasked)
- OperationsAdmin:   `****7890123456` (last 8 digits)
- FinancialInv.:     `****3456` (last 4 digits)

---

## Validation Rules

### Default Deny

If a permission is not in a role's array, it's denied:

```typescript
// If 'transfers:retry' is not in OperationsAdmin's permissions array
checkPermission('transfers:retry')
// Returns: false (denied)

// Must have explicit permission
ROLE_PERMISSIONS['OperationsAdmin'].includes('transfers:retry')
// Must be: true (for access)
```

### SuperAdmin Override

SuperAdmin cannot be denied (has all permissions):

```typescript
// These all return true for SuperAdmin
checkPermission('admins:create')           // true
checkPermission('transfers:retry')         // true
checkPermission('audit_logs:read_masked')  // true
```

### Read-Only Enforcement

ReadOnlyAuditor and ComplianceOfficer have zero write permissions:

```typescript
ROLE_PERMISSIONS['ReadOnlyAuditor']      // No 'transfers:*' operations
ROLE_PERMISSIONS['ComplianceOfficer']    // No 'transfers:retry', 'transfers:cancel', etc.
```

---

## Testing Checklist

- ✅ SuperAdmin has all permissions
- ✅ OperationsAdmin has operations only
- ✅ FinancialInvestigator has read-only + notes
- ✅ ComplianceOfficer has audit logs + compliance
- ✅ ReadOnlyAuditor has only masked reads
- ✅ Default deny (missing permission = false)
- ✅ Each role cannot do what it shouldn't
- ✅ Masking applied correctly per role
- ✅ Hierarchy respected (SuperAdmin ⊇ all others)

---

## Summary

- **40+ permissions** across 5 categories
- **5 roles** with different capabilities
- **Default deny**: No permission = access denied
- **Minimal privilege**: Each role has only what it needs
- **Complete separation**: Admin and customer auth are separate
- **Audit ready**: Hooks prepared for Milestone 5

This matrix is the source of truth for all RBAC in Manna.
