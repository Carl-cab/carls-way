/**
 * Admin authentication and authorization middleware.
 *
 * Provides:
 * - Admin session verification
 * - Permission checking
 * - Admin context propagation
 * - Sensitive data masking
 */

import { NextRequest, NextResponse } from 'next/server';
import { AsyncLocalStorage } from 'async_hooks';
import { getAdminRepository } from './AdminRepository';
import type { AdminContext, AdminUser, Permission, AdminRole } from './types';
import { ROLE_PERMISSIONS, getFieldsToMask } from './types';

/**
 * AsyncLocalStorage for admin context (similar to request context).
 *
 * Allows any function in the admin request to access admin context
 * without passing it as a parameter.
 */
export const adminContextStorage = new AsyncLocalStorage<AdminContext>();

/**
 * Get current admin context.
 *
 * @returns Admin context or undefined if not authenticated
 */
export function getAdminContext(): AdminContext | undefined {
  return adminContextStorage.getStore();
}

/**
 * Get current authenticated admin user.
 *
 * @returns Admin user or undefined if not authenticated
 */
export function getCurrentAdmin(): AdminUser | undefined {
  return getAdminContext()?.adminUser;
}

/**
 * Get current admin permissions.
 *
 * @returns Array of permissions or empty array
 */
export function getCurrentPermissions(): Permission[] {
  return getAdminContext()?.permissions || [];
}

/**
 * Verify admin session from request cookie or header.
 *
 * @param req NextRequest
 * @returns Admin context or null if invalid
 */
async function verifyAdminSession(req: NextRequest): Promise<AdminContext | null> {
  // Look for admin session in cookie or Authorization header
  const sessionId =
    req.cookies.get('admin_session')?.value ||
    req.headers.get('authorization')?.replace('Bearer ', '');

  if (!sessionId) {
    return null;
  }

  try {
    const adminRepo = getAdminRepository();

    // Verify session exists and is not expired
    const session = await adminRepo.findSession(sessionId);
    if (!session) {
      return null;
    }

    // Get admin user
    const adminUser = await adminRepo.findAdminById(session.admin_user_id);
    if (!adminUser || adminUser.status !== 'active') {
      return null;
    }

    // Check if admin is locked
    if (adminUser.locked_until && new Date(adminUser.locked_until) > new Date()) {
      return null;
    }

    // Get permissions for this role
    const permissions = ROLE_PERMISSIONS[adminUser.role] || [];

    // Update session activity
    await adminRepo.updateSessionActivity(sessionId);

    return {
      adminUser,
      sessionId,
      permissions,
      correlationId: req.headers.get('x-correlation-id') || undefined,
      sourceIp: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown',
      userAgent: req.headers.get('user-agent') || 'unknown',
    };
  } catch (err) {
    console.error('Error verifying admin session:', err);
    return null;
  }
}

/**
 * Middleware to verify admin authentication.
 *
 * Call this in admin routes to require authentication.
 *
 * @param req NextRequest
 * @param handler Route handler
 * @returns Response
 */
export async function withAdminAuth(
  req: NextRequest,
  handler: (req: NextRequest) => Promise<NextResponse>
): Promise<NextResponse> {
  const context = await verifyAdminSession(req);

  if (!context) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return adminContextStorage.run(context, async () => {
    try {
      return await handler(req);
    } catch (err) {
      console.error('Admin route error:', err);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}

/**
 * Check if current admin has a specific permission.
 *
 * Default deny: must have explicit permission.
 *
 * @param permission Permission to check
 * @returns true if admin has permission
 */
export function checkPermission(permission: Permission): boolean {
  const context = getAdminContext();
  if (!context) {
    return false;
  }

  return context.permissions.includes(permission);
}

/**
 * Require a specific permission.
 *
 * Use in route handlers to enforce permissions.
 *
 * @param permission Permission required
 * @throws 403 if admin doesn't have permission
 */
export function requirePermission(permission: Permission): void {
  if (!checkPermission(permission)) {
    throw new ForbiddenError(
      `This action requires the "${permission}" permission`,
      { requiredPermission: permission }
    );
  }
}

/**
 * Require the SuperAdmin role.
 *
 * @throws 403 if admin is not SuperAdmin
 */
export function requireSuperAdmin(): void {
  const admin = getCurrentAdmin();
  if (!admin || admin.role !== 'SuperAdmin') {
    throw new ForbiddenError('This action requires SuperAdmin role');
  }
}

/**
 * Require that the admin can run operations.
 *
 * @throws 403 if admin cannot run operations
 */
export function requireOperations(): void {
  const admin = getCurrentAdmin();
  if (!admin || (admin.role !== 'SuperAdmin' && admin.role !== 'OperationsAdmin')) {
    throw new ForbiddenError('This action requires OperationsAdmin role or higher');
  }
}

/**
 * Require that the admin is NOT read-only.
 *
 * @throws 403 if admin is read-only
 */
export function forbidReadOnly(): void {
  const admin = getCurrentAdmin();
  if (!admin || (admin.role === 'ReadOnlyAuditor' || admin.role === 'ComplianceOfficer')) {
    throw new ForbiddenError('This action is not available for read-only roles');
  }
}

/**
 * Mask sensitive fields in an object based on admin role.
 *
 * @param data Object to mask
 * @param entityType Type of entity (users, bank_accounts, etc)
 * @param role Admin role (if not provided, uses current context)
 * @returns Masked object
 */
export function maskSensitiveFields(
  data: Record<string, any>,
  entityType: string,
  role?: AdminRole
): Record<string, any> {
  const adminRole = role || getCurrentAdmin()?.role;
  if (!adminRole) {
    return {}; // Not authenticated
  }

  const fieldsToMask = getFieldsToMask(adminRole, entityType);
  const masked = { ...data };

  for (const field of fieldsToMask) {
    if (field in masked) {
      const value = masked[field];

      if (typeof value === 'string') {
        if (field === 'email') {
          // Partially mask email: a***@example.com
          const [local] = value.split('@');
          masked[field] = `${local.charAt(0)}***@${value.split('@')[1]}`;
        } else if (field === 'phone') {
          // Fully mask phone: ***-***-****
          masked[field] = '***-***-****';
        } else if (field === 'account_mask') {
          // Partially mask account: ****1234
          masked[field] = `****${value.slice(-4)}`;
        } else if (field === 'ip_address') {
          // Partially mask IP: 192.168.1.***
          const parts = value.split('.');
          masked[field] = parts.slice(0, -1).join('.') + '.***';
        } else {
          // Default: fully mask
          masked[field] = '***';
        }
      } else {
        // Non-string values: null
        masked[field] = null;
      }
    }
  }

  return masked;
}

/**
 * Mask an array of objects.
 *
 * @param data Array of objects
 * @param entityType Entity type
 * @param role Admin role (if not provided, uses current context)
 * @returns Masked array
 */
export function maskArray(
  data: Record<string, any>[],
  entityType: string,
  role?: AdminRole
): Record<string, any>[] {
  return data.map((item) => maskSensitiveFields(item, entityType, role));
}

/**
 * Audit log context for Milestone 5.
 *
 * Prepares data that will be logged in Milestone 5.
 * Currently just creates the structure, doesn't persist.
 */
export interface AuditLogData {
  action: string;
  resource_type: string;
  resource_id?: string;
  changes?: Record<string, any>;
}

/**
 * Create audit log entry (hook for Milestone 5).
 *
 * @param data Audit log data
 *
 * Milestone 5 will implement persistence.
 */
export function auditLogAction(data: AuditLogData): void {
  const context = getAdminContext();

  // Prepare audit log data structure
  const auditEntry = {
    admin_user_id: context?.adminUser.id,
    action: data.action,
    resource_type: data.resource_type,
    resource_id: data.resource_id,
    changes: data.changes,
    correlation_id: context?.correlationId,
    ip_address: context?.sourceIp,
    user_agent: context?.userAgent,
    status: 'success' as const,
    created_at: new Date().toISOString(),
  };

  // Milestone 5: Persist this to admin_audit_logs table
  // For now, just log to console
  console.log('[AUDIT]', auditEntry);
}

/**
 * Custom errors for RBAC.
 */

export class UnauthorizedError extends Error {
  constructor(message: string = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(
    message: string = 'Forbidden',
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Convert RBAC errors to HTTP responses.
 *
 * @param err Error to convert
 * @returns NextResponse or null if not an RBAC error
 */
export function handleRbacError(err: unknown): NextResponse | null {
  if (err instanceof UnauthorizedError) {
    return NextResponse.json({ error: err.message }, { status: 401 });
  }

  if (err instanceof ForbiddenError) {
    return NextResponse.json(
      { error: err.message, details: err.details },
      { status: 403 }
    );
  }

  return null;
}
