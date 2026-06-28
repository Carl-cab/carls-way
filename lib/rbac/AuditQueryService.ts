/**
 * Audit log query service.
 *
 * Provides high-level query and analysis capabilities for audit logs.
 */

import { getAuditLogRepository } from './AuditLogRepository';
import { getCurrentAdmin, checkPermission } from './admin-middleware';
import type { AdminAuditLog } from './types';

export interface QueryResult {
  records: AdminAuditLog[];
  total_count: number;
  page_number: number;
  page_size: number;
  has_more: boolean;
}

export interface AuditSummary {
  total_actions: number;
  successful_actions: number;
  failed_actions: number;
  failure_rate: number;
  most_common_actions: Array<{ action: string; count: number }>;
  most_active_admins: Array<{ admin_id: number; count: number }>;
  date_range: { start: Date; end: Date };
}

export class AuditQueryService {
  private repo = getAuditLogRepository();

  /**
   * Verify audit read authorization.
   *
   * Only roles with audit_logs:read can query.
   */
  private verifyAuthorization(): void {
    if (!checkPermission('audit_logs:read')) {
      throw new Error('Insufficient permissions to read audit logs');
    }
  }

  /**
   * Query audit logs with pagination.
   *
   * @param page Page number (1-indexed)
   * @param pageSize Records per page
   * @param filters Query filters
   * @returns Paginated results
   */
  async queryPage(
    page: number = 1,
    pageSize: number = 50,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      adminUserId?: number;
      action?: string;
      resourceType?: string;
      status?: 'success' | 'failed';
    }
  ): Promise<QueryResult> {
    this.verifyAuthorization();

    if (pageSize > 1000) {
      throw new Error('Page size cannot exceed 1000');
    }

    const offset = (page - 1) * pageSize;

    const logs = await this.repo.queryAuditLogs({
      ...filters,
      limit: pageSize + 1, // Get one extra to check if there are more
      offset,
    });

    const hasMore = logs.length > pageSize;
    const records = logs.slice(0, pageSize);

    const totalCount = await this.repo.countAuditLogs(filters || {});

    return {
      records,
      total_count: totalCount,
      page_number: page,
      page_size: pageSize,
      has_more: hasMore,
    };
  }

  /**
   * Get audit logs by correlation ID (trace full request flow).
   *
   * @param correlationId Correlation ID
   * @returns Logs in chronological order
   */
  async traceByCorrelationId(correlationId: string): Promise<AdminAuditLog[]> {
    this.verifyAuthorization();
    return this.repo.findByCorrelationId(correlationId);
  }

  /**
   * Get recent actions by admin.
   *
   * @param adminUserId Admin user ID
   * @param limit Max records
   * @returns Recent audit logs
   */
  async getAdminActivity(adminUserId: number, limit: number = 100): Promise<AdminAuditLog[]> {
    this.verifyAuthorization();
    return this.repo.findByAdminUserId(adminUserId, limit);
  }

  /**
   * Get current admin's recent actions.
   *
   * @param limit Max records
   * @returns Recent audit logs
   */
  async getMyActivity(limit: number = 50): Promise<AdminAuditLog[]> {
    this.verifyAuthorization();

    const admin = getCurrentAdmin();
    if (!admin) {
      throw new Error('Not authenticated');
    }

    return this.repo.findByAdminUserId(admin.id, limit);
  }

  /**
   * Get audit summary (high-level overview).
   *
   * @param startDate Start date filter
   * @param endDate End date filter
   * @returns Summary statistics
   */
  async getSummary(startDate?: Date, endDate?: Date): Promise<AuditSummary> {
    this.verifyAuthorization();

    const stats = await this.repo.getAuditStats(startDate, endDate);

    const totalActions = stats.total_count;
    const successfulActions = stats.success_count;
    const failedActions = stats.failed_count;
    const failureRate =
      totalActions > 0 ? Number(((failedActions / totalActions) * 100).toFixed(2)) : 0;

    // Get top actions
    const topActions = Object.entries(stats.actions)
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Get top admins
    const topAdmins = Object.entries(stats.admin_users)
      .map(([admin_id, count]) => ({ admin_id: Number(admin_id), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total_actions: totalActions,
      successful_actions: successfulActions,
      failed_actions: failedActions,
      failure_rate: failureRate,
      most_common_actions: topActions,
      most_active_admins: topAdmins,
      date_range: {
        start: startDate || new Date(0),
        end: endDate || new Date(),
      },
    };
  }

  /**
   * Find suspicious activity patterns.
   *
   * Identifies:
   * - Failed action streaks
   * - Unusual access patterns
   * - Permission denials
   *
   * @param startDate Start date filter
   * @param endDate End date filter
   * @returns Array of suspicious activities
   */
  async findSuspiciousActivity(
    startDate?: Date,
    endDate?: Date
  ): Promise<
    Array<{
      type: 'failed_streak' | 'permission_denial' | 'unusual_pattern';
      severity: 'low' | 'medium' | 'high';
      description: string;
      evidence: AdminAuditLog[];
    }>
  > {
    this.verifyAuthorization();

    const logs = await this.repo.getForExport({
      startDate,
      endDate,
    });

    const suspiciousActivities: Array<{
      type: 'failed_streak' | 'permission_denial' | 'unusual_pattern';
      severity: 'low' | 'medium' | 'high';
      description: string;
      evidence: AdminAuditLog[];
    }> = [];

    // Find failed action streaks
    const failedByAdmin: Record<number, AdminAuditLog[]> = {};
    logs.forEach((log) => {
      if (log.status === 'failed') {
        if (!failedByAdmin[log.admin_user_id]) {
          failedByAdmin[log.admin_user_id] = [];
        }
        failedByAdmin[log.admin_user_id].push(log);
      }
    });

    Object.entries(failedByAdmin).forEach(([adminId, failedLogs]) => {
      if (failedLogs.length >= 5) {
        suspiciousActivities.push({
          type: 'failed_streak',
          severity: failedLogs.length >= 10 ? 'high' : 'medium',
          description: `Admin ${adminId} had ${failedLogs.length} failed actions`,
          evidence: failedLogs.slice(0, 5),
        });
      }
    });

    // Find permission denials
    const permissionDenials = logs.filter((log) =>
      log.action.includes('permission') && log.status === 'failed'
    );

    if (permissionDenials.length >= 3) {
      suspiciousActivities.push({
        type: 'permission_denial',
        severity: 'medium',
        description: `${permissionDenials.length} permission denials detected`,
        evidence: permissionDenials.slice(0, 5),
      });
    }

    return suspiciousActivities;
  }

  /**
   * Get action timeline for debugging/forensics.
   *
   * @param correlationId Correlation ID
   * @returns Timeline of events
   */
  async getTimeline(correlationId: string): Promise<
    Array<{
      timestamp: Date;
      admin_id: number;
      admin_role: string;
      action: string;
      resource_type: string;
      status: 'success' | 'failed';
      duration_ms: number;
      error?: string;
    }>
  > {
    this.verifyAuthorization();

    const logs = await this.repo.findByCorrelationId(correlationId);

    return logs.map((log) => ({
      timestamp: log.created_at,
      admin_id: log.admin_user_id,
      admin_role: log.role || 'unknown',
      action: log.action,
      resource_type: log.resource_type,
      status: log.status,
      duration_ms: log.request_duration_ms || 0,
      error: log.error_message,
    }));
  }

  /**
   * Get performance statistics.
   *
   * @param startDate Start date filter
   * @param endDate End date filter
   * @returns Performance metrics
   */
  async getPerformanceStats(startDate?: Date, endDate?: Date): Promise<{
    average_request_duration_ms: number;
    min_request_duration_ms: number;
    max_request_duration_ms: number;
    median_request_duration_ms: number;
    p95_request_duration_ms: number;
    p99_request_duration_ms: number;
  }> {
    this.verifyAuthorization();

    const logs = await this.repo.getForExport({
      startDate,
      endDate,
    });

    const durations = logs
      .filter((log) => log.request_duration_ms !== undefined && log.request_duration_ms !== null)
      .map((log) => log.request_duration_ms as number)
      .sort((a, b) => a - b);

    if (durations.length === 0) {
      return {
        average_request_duration_ms: 0,
        min_request_duration_ms: 0,
        max_request_duration_ms: 0,
        median_request_duration_ms: 0,
        p95_request_duration_ms: 0,
        p99_request_duration_ms: 0,
      };
    }

    const sum = durations.reduce((a, b) => a + b, 0);
    const avg = sum / durations.length;

    const median = durations[Math.floor(durations.length / 2)];
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const p99 = durations[Math.floor(durations.length * 0.99)];

    return {
      average_request_duration_ms: Math.round(avg),
      min_request_duration_ms: Math.min(...durations),
      max_request_duration_ms: Math.max(...durations),
      median_request_duration_ms: median,
      p95_request_duration_ms: p95,
      p99_request_duration_ms: p99,
    };
  }
}

/**
 * Get singleton instance of AuditQueryService.
 */
let auditQueryServiceInstance: AuditQueryService | null = null;

export function getAuditQueryService(): AuditQueryService {
  if (!auditQueryServiceInstance) {
    auditQueryServiceInstance = new AuditQueryService();
  }
  return auditQueryServiceInstance;
}
