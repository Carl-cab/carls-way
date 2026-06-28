/**
 * RBAC module index.
 *
 * Central export point for all RBAC components.
 * Services and routes should import from this index.
 */

export * from './types';
export * from './AdminRepository';
export * from './admin-middleware';

// Common exports
export {
  getAdminRepository,
} from './AdminRepository';

export {
  getAdminContext,
  getCurrentAdmin,
  getCurrentPermissions,
  withAdminAuth,
  checkPermission,
  requirePermission,
  requireSuperAdmin,
  requireOperations,
  forbidReadOnly,
  maskSensitiveFields,
  maskArray,
  auditLogAction,
  UnauthorizedError,
  ForbiddenError,
  handleRbacError,
} from './admin-middleware';
