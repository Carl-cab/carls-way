/**
 * Audit log export service.
 *
 * Handles exporting audit logs in JSON and CSV formats.
 * Requires ComplianceOfficer or SuperAdmin role.
 */

import { getAuditLogRepository } from './AuditLogRepository';
import { getCurrentAdmin, checkPermission } from './admin-middleware';
import type { AdminAuditLog } from './types';

export interface ExportOptions {
  startDate?: Date;
  endDate?: Date;
  adminUserId?: number;
  action?: string;
  resourceType?: string;
  status?: 'success' | 'failed';
}

export class AuditExportService {
  private repo = getAuditLogRepository();

  /**
   * Verify export authorization.
   *
   * Only ComplianceOfficer and SuperAdmin can export.
   *
   * @throws Error if not authorized
   */
  private verifyAuthorization(): void {
    const admin = getCurrentAdmin();

    if (!admin) {
      throw new Error('Not authenticated');
    }

    // Only ComplianceOfficer and SuperAdmin can export
    if (!checkPermission('audit_logs:export')) {
      throw new Error('Insufficient permissions for audit export');
    }
  }

  /**
   * Export audit logs as JSON.
   *
   * @param options Export filters
   * @returns JSON string
   */
  async exportAsJSON(options: ExportOptions): Promise<string> {
    this.verifyAuthorization();

    const logs = await this.repo.getForExport({
      startDate: options.startDate,
      endDate: options.endDate,
      adminUserId: options.adminUserId,
      action: options.action,
      resourceType: options.resourceType,
      status: options.status,
    });

    const data = {
      export_timestamp: new Date().toISOString(),
      exported_by: getCurrentAdmin()?.email,
      total_records: logs.length,
      filters: {
        start_date: options.startDate?.toISOString(),
        end_date: options.endDate?.toISOString(),
        admin_user_id: options.adminUserId,
        action: options.action,
        resource_type: options.resourceType,
        status: options.status,
      },
      audit_logs: logs.map((log) => this.sanitizeForExport(log)),
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * Export audit logs as CSV.
   *
   * @param options Export filters
   * @returns CSV string
   */
  async exportAsCSV(options: ExportOptions): Promise<string> {
    this.verifyAuthorization();

    const logs = await this.repo.getForExport({
      startDate: options.startDate,
      endDate: options.endDate,
      adminUserId: options.adminUserId,
      action: options.action,
      resourceType: options.resourceType,
      status: options.status,
    });

    if (logs.length === 0) {
      return this.getCSVHeader();
    }

    const header = this.getCSVHeader();
    const rows = logs.map((log) => this.auditLogToCSVRow(log));

    return [header, ...rows].join('\n');
  }

  /**
   * Get CSV header row.
   */
  private getCSVHeader(): string {
    const headers = [
      'ID',
      'Timestamp',
      'Admin User ID',
      'Session ID',
      'Admin Role',
      'Action',
      'Resource Type',
      'Resource ID',
      'Status',
      'Error Message',
      'IP Address',
      'User Agent',
      'Correlation ID',
      'Request Duration (ms)',
      'Changes (JSON)',
    ];

    return headers.map((h) => this.escapeCSVField(h)).join(',');
  }

  /**
   * Convert audit log to CSV row.
   */
  private auditLogToCSVRow(log: AdminAuditLog): string {
    const fields = [
      log.id,
      log.created_at.toISOString(),
      log.admin_user_id,
      log.session_id || '',
      log.role || '',
      log.action,
      log.resource_type,
      log.resource_id || '',
      log.status,
      log.error_message || '',
      log.ip_address || '',
      log.user_agent || '',
      log.correlation_id || '',
      log.request_duration_ms || '',
      log.changes ? JSON.stringify(log.changes) : '',
    ];

    return fields.map((f) => this.escapeCSVField(String(f || ''))).join(',');
  }

  /**
   * Escape CSV field (handle quotes, commas, newlines).
   */
  private escapeCSVField(field: string): string {
    if (field.includes(',') || field.includes('"') || field.includes('\n')) {
      return `"${field.replace(/"/g, '""')}"`;
    }
    return field;
  }

  /**
   * Sanitize audit log for export (remove sensitive data if needed).
   */
  private sanitizeForExport(log: AdminAuditLog): Record<string, any> {
    return {
      id: log.id,
      timestamp: log.created_at.toISOString(),
      admin_user_id: log.admin_user_id,
      session_id: log.session_id,
      admin_role: log.role,
      action: log.action,
      resource_type: log.resource_type,
      resource_id: log.resource_id,
      status: log.status,
      error_message: log.error_message,
      ip_address: log.ip_address,
      user_agent: log.user_agent,
      correlation_id: log.correlation_id,
      request_duration_ms: log.request_duration_ms,
      changes: log.changes,
    };
  }

  /**
   * Get export summary (for preview before download).
   *
   * @param options Export filters
   * @returns Summary of what will be exported
   */
  async getExportSummary(options: ExportOptions): Promise<{
    record_count: number;
    date_range: { start: string; end: string };
    actions: Record<string, number>;
    admin_users: Record<number, number>;
  }> {
    this.verifyAuthorization();

    const count = await this.repo.countAuditLogs({
      startDate: options.startDate,
      endDate: options.endDate,
      adminUserId: options.adminUserId,
      action: options.action,
      resourceType: options.resourceType,
      status: options.status,
    });

    const stats = await this.repo.getAuditStats(options.startDate, options.endDate);

    return {
      record_count: count,
      date_range: {
        start: options.startDate?.toISOString() || 'N/A',
        end: options.endDate?.toISOString() || 'N/A',
      },
      actions: stats.actions,
      admin_users: stats.admin_users,
    };
  }
}

/**
 * Get singleton instance of AuditExportService.
 */
let auditExportServiceInstance: AuditExportService | null = null;

export function getAuditExportService(): AuditExportService {
  if (!auditExportServiceInstance) {
    auditExportServiceInstance = new AuditExportService();
  }
  return auditExportServiceInstance;
}
