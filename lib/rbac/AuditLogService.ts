/**
 * Audit log service layer.
 *
 * Handles audit log creation and retrieval.
 * Services automatically record actions in admin_audit_logs.
 */

import { getAuditLogRepository } from './AuditLogRepository';
import type { AdminAuditLog, AdminAuditLogInput } from './types';
import { getAdminContext } from './admin-middleware';

/**
 * Event builder for constructing audit log entries.
 */
export class AuditEventBuilder {
  private event: AdminAuditLogInput = {
    admin_user_id: 0,
    action: '',
    resource_type: '',
    status: 'success',
  };

  /**
   * Set admin user ID.
   */
  withAdminUserId(id: number): this {
    this.event.admin_user_id = id;
    return this;
  }

  /**
   * Set session ID.
   */
  withSessionId(sessionId: string): this {
    this.event.session_id = sessionId;
    return this;
  }

  /**
   * Set action (e.g., 'transfer_retry', 'admin_created', 'permission_denied').
   */
  withAction(action: string): this {
    this.event.action = action;
    return this;
  }

  /**
   * Set resource type (e.g., 'transfer_intent', 'admin_user').
   */
  withResourceType(resourceType: string): this {
    this.event.resource_type = resourceType;
    return this;
  }

  /**
   * Set resource ID (e.g., transfer ID, user ID).
   */
  withResourceId(resourceId: string | number): this {
    this.event.resource_id = String(resourceId);
    return this;
  }

  /**
   * Set state changes (before/after).
   */
  withChanges(changes: Record<string, unknown>): this {
    this.event.changes = changes;
    return this;
  }

  /**
   * Set correlation ID for request tracing.
   */
  withCorrelationId(correlationId: string): this {
    this.event.correlation_id = correlationId;
    return this;
  }

  /**
   * Set source IP address.
   */
  withIpAddress(ipAddress: string): this {
    this.event.ip_address = ipAddress;
    return this;
  }

  /**
   * Set user agent.
   */
  withUserAgent(userAgent: string): this {
    this.event.user_agent = userAgent;
    return this;
  }

  /**
   * Set admin role.
   */
  withRole(role: string): this {
    this.event.role = role;
    return this;
  }

  /**
   * Mark as successful.
   */
  success(): this {
    this.event.status = 'success';
    this.event.error_message = undefined;
    return this;
  }

  /**
   * Mark as failed with error message.
   */
  failed(errorMessage: string): this {
    this.event.status = 'failed';
    this.event.error_message = errorMessage;
    return this;
  }

  /**
   * Set request duration.
   */
  withRequestDuration(durationMs: number): this {
    this.event.request_duration_ms = durationMs;
    return this;
  }

  /**
   * Build and return event.
   */
  build(): AdminAuditLogInput {
    if (!this.event.admin_user_id) {
      throw new Error('admin_user_id is required');
    }
    if (!this.event.action) {
      throw new Error('action is required');
    }
    if (!this.event.resource_type) {
      throw new Error('resource_type is required');
    }

    return this.event;
  }
}

/**
 * Audit log service.
 *
 * Handles creating and querying audit logs.
 */
export class AuditLogService {
  private repo = getAuditLogRepository();

  /**
   * Create audit log entry.
   *
   * @param input Audit log data
   * @returns Created audit log
   */
  async createAuditLog(input: AdminAuditLogInput): Promise<AdminAuditLog> {
    return this.repo.createAuditLog(input);
  }

  /**
   * Create audit log with builder pattern.
   *
   * @param builder Configured event builder
   * @returns Created audit log
   */
  async createAuditLogFromBuilder(builder: AuditEventBuilder): Promise<AdminAuditLog> {
    const input = builder.build();
    return this.repo.createAuditLog(input);
  }

  /**
   * Get audit log by ID.
   *
   * @param id Audit log ID
   * @returns Audit log or null
   */
  async getAuditLog(id: number): Promise<AdminAuditLog | null> {
    return this.repo.findAuditLogById(id);
  }

  /**
   * Get audit logs by correlation ID (trace full request flow).
   *
   * @param correlationId Correlation ID
   * @returns Audit logs in chronological order
   */
  async getByCorrelationId(correlationId: string): Promise<AdminAuditLog[]> {
    return this.repo.findByCorrelationId(correlationId);
  }

  /**
   * Get audit logs for specific admin.
   *
   * @param adminUserId Admin user ID
   * @param limit Max records
   * @returns Recent audit logs
   */
  async getByAdminUserId(adminUserId: number, limit?: number): Promise<AdminAuditLog[]> {
    return this.repo.findByAdminUserId(adminUserId, limit);
  }

  /**
   * Query audit logs with filters.
   *
   * @param options Query filters
   * @returns Paginated audit logs
   */
  async queryAuditLogs(options: {
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
    adminUserId?: number;
    correlationId?: string;
    action?: string;
    resourceType?: string;
    status?: 'success' | 'failed';
  }): Promise<AdminAuditLog[]> {
    return this.repo.queryAuditLogs(options);
  }

  /**
   * Count audit logs matching filters.
   *
   * @param options Query filters
   * @returns Count
   */
  async countAuditLogs(options: {
    startDate?: Date;
    endDate?: Date;
    adminUserId?: number;
    action?: string;
    resourceType?: string;
    status?: 'success' | 'failed';
  }): Promise<number> {
    return this.repo.countAuditLogs(options);
  }

  /**
   * Get audit statistics.
   *
   * @param startDate Optional start filter
   * @param endDate Optional end filter
   * @returns Stats object
   */
  async getStats(startDate?: Date, endDate?: Date): Promise<{
    total_count: number;
    success_count: number;
    failed_count: number;
    actions: Record<string, number>;
    admin_users: Record<number, number>;
  }> {
    return this.repo.getAuditStats(startDate, endDate);
  }

  /**
   * Get all audit logs for export (no pagination).
   *
   * @param options Query filters
   * @returns All matching audit logs
   */
  async getForExport(options: {
    startDate?: Date;
    endDate?: Date;
    adminUserId?: number;
    action?: string;
    resourceType?: string;
    status?: 'success' | 'failed';
  }): Promise<AdminAuditLog[]> {
    return this.repo.getForExport(options);
  }

  /**
   * Verify audit logs are immutable (append-only).
   *
   * @returns Boolean indicating integrity
   */
  async verifyImmutability(): Promise<boolean> {
    return this.repo.verifyImmutability();
  }

  /**
   * Create audit log from current request context.
   *
   * Extracts admin, IP, correlation ID from AsyncLocalStorage.
   */
  async logFromContext(
    action: string,
    resourceType: string,
    resourceId?: string,
    changes?: Record<string, unknown>,
    status: 'success' | 'failed' = 'success',
    errorMessage?: string
  ): Promise<AdminAuditLog> {
    const context = getAdminContext();

    if (!context) {
      throw new Error('No admin context available for audit logging');
    }

    const event = new AuditEventBuilder()
      .withAdminUserId(context.adminUser.id)
      .withSessionId(context.sessionId) // May not be available in all contexts
      .withAction(action)
      .withResourceType(resourceType);

    if (resourceId) {
      event.withResourceId(resourceId);
    }

    if (changes) {
      event.withChanges(changes);
    }

    if (context.correlationId) {
      event.withCorrelationId(context.correlationId);
    }

    if (context.sourceIp) {
      event.withIpAddress(context.sourceIp);
    }

    if (context.userAgent) {
      event.withUserAgent(context.userAgent);
    }

    event.withRole(context.adminUser.role);

    if (status === 'failed' && errorMessage) {
      event.failed(errorMessage);
    } else {
      event.success();
    }

    return this.createAuditLogFromBuilder(event);
  }
}

/**
 * Get singleton instance of AuditLogService.
 */
let auditLogServiceInstance: AuditLogService | null = null;

export function getAuditLogService(): AuditLogService {
  if (!auditLogServiceInstance) {
    auditLogServiceInstance = new AuditLogService();
  }
  return auditLogServiceInstance;
}
