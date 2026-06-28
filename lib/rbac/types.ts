/**
 * RBAC types and interfaces for admin access control.
 *
 * Defines:
 * - Admin roles and permissions
 * - Admin user data models
 * - Permission checking utilities
 * - Audit log structures
 */

/**
 * Admin roles in the system.
 *
 * Ordered by privilege level:
 * 1. SuperAdmin - Full access (default deny logic does not apply)
 * 2. OperationsAdmin - Run operational actions
 * 3. FinancialInvestigator - Search and investigate, read-only
 * 4. ComplianceOfficer - Read audit logs and export reports
 * 5. ReadOnlyAuditor - View-only access, sensitive data masked
 */
export type AdminRole =
  | 'SuperAdmin'
  | 'OperationsAdmin'
  | 'FinancialInvestigator'
  | 'ComplianceOfficer'
  | 'ReadOnlyAuditor';

/**
 * Permission categories for organization.
 */
export type PermissionCategory =
  | 'admin_management'
  | 'operations'
  | 'investigation'
  | 'compliance'
  | 'audit';

/**
 * Individual permissions (granular).
 *
 * Naming convention: resource:action
 * Examples: users:read, transfers:retry, audit_logs:export
 */
export type Permission =
  // Admin management (SuperAdmin only)
  | 'admins:create'
  | 'admins:read'
  | 'admins:update'
  | 'admins:delete'
  | 'roles:manage'
  | 'permissions:manage'

  // Operations (OperationsAdmin)
  | 'transfers:retry'
  | 'transfers:cancel'
  | 'events:replay'
  | 'settlements:view'
  | 'exceptions:manage'

  // Investigation (FinancialInvestigator)
  | 'users:search'
  | 'users:view_details'
  | 'transfers:view'
  | 'transfers:search'
  | 'wallets:view'
  | 'ledger:view'
  | 'provider_events:view'
  | 'investigations:create_notes'

  // Compliance (ComplianceOfficer)
  | 'audit_logs:read'
  | 'audit_logs:export'
  | 'incidents:review'
  | 'compliance:read'

  // Read-only (ReadOnlyAuditor)
  | 'audit_logs:read_masked'
  | 'data:read_masked';

/**
 * Admin user domain model.
 */
export interface AdminUser {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: AdminRole;
  status: 'active' | 'inactive' | 'suspended';
  last_login_at?: string;
  failed_login_attempts: number;
  locked_until?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Admin role definition.
 */
export interface AdminRoleEntity {
  id: number;
  name: AdminRole;
  description?: string;
  created_at: string;
}

/**
 * Permission definition.
 */
export interface PermissionEntity {
  id: number;
  name: Permission;
  description?: string;
  category: PermissionCategory;
  created_at: string;
}

/**
 * Admin session (authentication token).
 */
export interface AdminSession {
  id: string;
  admin_user_id: number;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_activity_at: string;
}

/**
 * Audit log entry (immutable, append-only).
 */
export interface AdminAuditLog {
  id: number;
  admin_user_id: number;
  session_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  changes?: Record<string, unknown>;
  correlation_id?: string;
  ip_address?: string;
  user_agent?: string;
  role?: string;
  status: 'success' | 'failed';
  error_message?: string;
  request_duration_ms?: number;
  created_at: Date;
}

/**
 * Input for creating audit log entry.
 */
export interface AdminAuditLogInput {
  admin_user_id: number;
  session_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  changes?: Record<string, unknown>;
  correlation_id?: string;
  ip_address?: string;
  user_agent?: string;
  role?: string;
  status?: 'success' | 'failed';
  error_message?: string;
  request_duration_ms?: number;
}

/**
 * Authenticated admin context (from request).
 *
 * Available in middleware for permission checking.
 */
export interface AdminContext {
  adminUser: AdminUser;
  sessionId: string;
  permissions: Permission[];
  correlationId?: string;
  sourceIp?: string;
  userAgent?: string;
}

/**
 * Input types for mutations.
 */

export interface CreateAdminUserInput {
  email: string;
  name: string;
  password: string; // Plain text, will be hashed
  role: AdminRole;
}

export interface UpdateAdminUserInput {
  name?: string;
  role?: AdminRole;
  status?: 'active' | 'inactive' | 'suspended';
}

export interface CreateAdminSessionInput {
  email: string;
  password: string;
}

/**
 * Role-to-permissions mapping.
 *
 * Defines which permissions each role has.
 * This is the source of truth for RBAC.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  SuperAdmin: [
    // Full access
    'admins:create',
    'admins:read',
    'admins:update',
    'admins:delete',
    'roles:manage',
    'permissions:manage',
    'transfers:retry',
    'transfers:cancel',
    'events:replay',
    'settlements:view',
    'exceptions:manage',
    'users:search',
    'users:view_details',
    'transfers:view',
    'transfers:search',
    'wallets:view',
    'ledger:view',
    'provider_events:view',
    'investigations:create_notes',
    'audit_logs:read',
    'audit_logs:export',
    'incidents:review',
    'compliance:read',
  ],

  OperationsAdmin: [
    // Run approved operational actions
    'transfers:retry',
    'transfers:cancel',
    'events:replay',
    'settlements:view',
    'exceptions:manage',
    'users:search',
    'users:view_details',
    'transfers:view',
    'transfers:search',
    'provider_events:view',
    'audit_logs:read',
  ],

  FinancialInvestigator: [
    // Search and investigate, read-only
    'users:search',
    'users:view_details',
    'transfers:view',
    'transfers:search',
    'wallets:view',
    'ledger:view',
    'provider_events:view',
    'investigations:create_notes',
    'audit_logs:read',
  ],

  ComplianceOfficer: [
    // Read audit logs and export reports
    'audit_logs:read',
    'audit_logs:export',
    'incidents:review',
    'compliance:read',
    'users:search',
    'transfers:view',
    'provider_events:view',
  ],

  ReadOnlyAuditor: [
    // View-only access with masked sensitive data
    'audit_logs:read_masked',
    'data:read_masked',
    'transfers:view',
    'settlements:view',
  ],
};

/**
 * Sensitive fields that should be masked for non-SuperAdmin roles.
 *
 * Used to strip sensitive data from responses.
 */
export const MASKED_FIELDS: Record<string, string[]> = {
  users: [
    'password_hash',
    'email', // Partially masked: a***@example.com
    'phone', // Fully masked unless explicitly authorized
    'kyc_session_id',
    'kyc_provider',
  ],
  bank_accounts: [
    'plaid_access_token_enc',
    'plaid_item_id',
    'account_mask', // Partially masked
  ],
  transactions: [
    // No highly sensitive fields, but PII if needed
  ],
  admin_audit_logs: [
    'ip_address', // Partially masked
    'user_agent',
  ],
};

/**
 * Check if a role has a specific permission.
 *
 * @param role Admin role
 * @param permission Permission to check
 * @returns true if role has permission
 */
export function hasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Check if a role can read admin data (requires explicit permission).
 *
 * Default deny: must have explicit permission.
 *
 * @param role Admin role
 * @returns true if role can read admin data
 */
export function canReadAdminData(role: AdminRole): boolean {
  return role === 'SuperAdmin';
}

/**
 * Check if a role can manage admins.
 *
 * @param role Admin role
 * @returns true if role can create/update/delete admins
 */
export function canManageAdmins(role: AdminRole): boolean {
  return role === 'SuperAdmin';
}

/**
 * Check if a role can run operational actions.
 *
 * @param role Admin role
 * @returns true if role can retry, replay, etc.
 */
export function canRunOperations(role: AdminRole): boolean {
  return role === 'SuperAdmin' || role === 'OperationsAdmin';
}

/**
 * Check if a role can investigate and search.
 *
 * @param role Admin role
 * @returns true if role can search and view details
 */
export function canInvestigate(role: AdminRole): boolean {
  return role !== 'ReadOnlyAuditor';
}

/**
 * Check if a role is read-only.
 *
 * @param role Admin role
 * @returns true if role cannot mutate any state
 */
export function isReadOnly(role: AdminRole): boolean {
  return role === 'ReadOnlyAuditor' || role === 'ComplianceOfficer';
}

/**
 * Get fields that should be masked for a role.
 *
 * SuperAdmin sees unmasked. Others see masked.
 *
 * @param role Admin role
 * @param entity Entity type (users, bank_accounts, etc)
 * @returns Array of fields to mask
 */
export function getFieldsToMask(role: AdminRole, entity: string): string[] {
  if (role === 'SuperAdmin') {
    return []; // No masking
  }

  if (role === 'ReadOnlyAuditor') {
    // Auditors see masked sensitive data
    return MASKED_FIELDS[entity] || [];
  }

  // Other roles: less aggressive masking depending on role
  if (role === 'ComplianceOfficer') {
    return MASKED_FIELDS[entity]?.filter((f) => f !== 'phone') || [];
  }

  return MASKED_FIELDS[entity] || [];
}
