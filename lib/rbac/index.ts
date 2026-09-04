/**
 * RBAC module index.
 *
 * Central export point for all RBAC and audit components.
 * Services and routes should import from this index.
 */

export * from './types';
export * from './AdminRepository';
export * from './admin-middleware';
export * from './AuditLogRepository';
export * from './AuditLogService';
export * from './audit-middleware';
export * from './AuditExportService';
export * from './AuditQueryService';

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

export {
  getAuditLogRepository,
} from './AuditLogRepository';

export {
  getAuditLogService,
  AuditEventBuilder,
} from './AuditLogService';

export {
  withAuditLog,
  AuditableAction,
  logAuditEvent,
} from './audit-middleware';

export {
  getAuditExportService,
} from './AuditExportService';

export {
  getAuditQueryService,
} from './AuditQueryService';
