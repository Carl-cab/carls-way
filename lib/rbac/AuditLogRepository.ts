/**
 * Audit log data access layer.
 *
 * Provides immutable, append-only audit log operations.
 * All audit records are immutable - no updates or deletes allowed.
 */

import { BaseRepository } from '@/lib/repositories/BaseRepository';
import { RepositoryError } from '@/lib/repositories/types';
import { getSql } from '@/lib/db';
import type { AdminAuditLog, AdminAuditLogInput } from './types';

export interface AuditLogQueryOptions {
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
  adminUserId?: number;
  correlationId?: string;
  action?: string;
  resourceType?: string;
  status?: 'success' | 'failed';
}

export interface AuditLogStats {
  total_count: number;
  success_count: number;
  failed_count: number;
  actions: Record<string, number>;
  admin_users: Record<number, number>;
}

export class AuditLogRepository extends BaseRepository {
  protected tableName = 'admin_audit_logs';

  /**
   * Create an immutable audit log entry.
   *
   * @param input Audit log data
   * @returns Created audit log record
   */
  async createAuditLog(input: AdminAuditLogInput): Promise<AdminAuditLog> {
    const sql = getSql();

    try {
      const rows = await sql`
        INSERT INTO admin_audit_logs (
          admin_user_id,
          session_id,
          action,
          resource_type,
          resource_id,
          changes,
          correlation_id,
          ip_address,
          user_agent,
          role,
          status,
          error_message,
          request_duration_ms
        ) VALUES (
          ${input.admin_user_id},
          ${input.session_id || null},
          ${input.action},
          ${input.resource_type},
          ${input.resource_id || null},
          ${input.changes ? JSON.stringify(input.changes) : null},
          ${input.correlation_id || null},
          ${input.ip_address || null},
          ${input.user_agent || null},
          ${input.role || null},
          ${input.status || 'success'},
          ${input.error_message || null},
          ${input.request_duration_ms || null}
        )
        RETURNING *
      `;

      if (!rows.length) {
        throw new RepositoryError('AUDIT_CREATE_FAILED', 'Failed to create audit log');
      }

      return this.mapToAuditLog(rows[0]);
    } catch (err) {
      if (err instanceof RepositoryError) throw err;
      throw new RepositoryError('AUDIT_CREATE_FAILED', `Failed to create audit log: ${String(err)}`);
    }
  }

  /**
   * Get audit log by ID.
   *
   * @param id Audit log ID
   * @returns Audit log record or null
   */
  async findAuditLogById(id: number): Promise<AdminAuditLog | null> {
    const sql = getSql();

    try {
      const rows = await sql`SELECT * FROM admin_audit_logs WHERE id = ${id}`;
      return rows.length ? this.mapToAuditLog(rows[0]) : null;
    } catch (err) {
      throw new RepositoryError('AUDIT_FIND_FAILED', `Failed to find audit log: ${String(err)}`);
    }
  }

  /**
   * Query audit logs with filters.
   *
   * @param options Query filters
   * @returns Paginated audit log records
   */
  async queryAuditLogs(options: AuditLogQueryOptions): Promise<AdminAuditLog[]> {
    const sql = getSql();
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    try {
      let query = sql`SELECT * FROM admin_audit_logs WHERE 1=1`;

      if (options.adminUserId) {
        query = sql`${query} AND admin_user_id = ${options.adminUserId}`;
      }

      if (options.correlationId) {
        query = sql`${query} AND correlation_id = ${options.correlationId}`;
      }

      if (options.action) {
        query = sql`${query} AND action = ${options.action}`;
      }

      if (options.resourceType) {
        query = sql`${query} AND resource_type = ${options.resourceType}`;
      }

      if (options.status) {
        query = sql`${query} AND status = ${options.status}`;
      }

      if (options.startDate) {
        query = sql`${query} AND created_at >= ${options.startDate}`;
      }

      if (options.endDate) {
        query = sql`${query} AND created_at <= ${options.endDate}`;
      }

      query = sql`${query} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

      const rows = await query;
      return rows.map((row: any) => this.mapToAuditLog(row));
    } catch (err) {
      throw new RepositoryError('AUDIT_QUERY_FAILED', `Failed to query audit logs: ${String(err)}`);
    }
  }

  /**
   * Count audit logs matching criteria.
   *
   * @param options Query filters
   * @returns Count of matching records
   */
  async countAuditLogs(options: AuditLogQueryOptions): Promise<number> {
    const sql = getSql();

    try {
      let query = sql`SELECT COUNT(*) as count FROM admin_audit_logs WHERE 1=1`;

      if (options.adminUserId) {
        query = sql`${query} AND admin_user_id = ${options.adminUserId}`;
      }

      if (options.correlationId) {
        query = sql`${query} AND correlation_id = ${options.correlationId}`;
      }

      if (options.action) {
        query = sql`${query} AND action = ${options.action}`;
      }

      if (options.resourceType) {
        query = sql`${query} AND resource_type = ${options.resourceType}`;
      }

      if (options.status) {
        query = sql`${query} AND status = ${options.status}`;
      }

      if (options.startDate) {
        query = sql`${query} AND created_at >= ${options.startDate}`;
      }

      if (options.endDate) {
        query = sql`${query} AND created_at <= ${options.endDate}`;
      }

      const rows = await query;
      return rows[0]?.count || 0;
    } catch (err) {
      throw new RepositoryError('AUDIT_COUNT_FAILED', `Failed to count audit logs: ${String(err)}`);
    }
  }

  /**
   * Get audit logs by correlation ID (trace entire request flow).
   *
   * @param correlationId Correlation ID
   * @returns Audit log records in chronological order
   */
  async findByCorrelationId(correlationId: string): Promise<AdminAuditLog[]> {
    const sql = getSql();

    try {
      const rows = await sql`
        SELECT * FROM admin_audit_logs
        WHERE correlation_id = ${correlationId}
        ORDER BY created_at ASC
      `;

      return rows.map((row: any) => this.mapToAuditLog(row));
    } catch (err) {
      throw new RepositoryError('AUDIT_CORRELATION_FAILED', `Failed to find logs by correlation ID: ${String(err)}`);
    }
  }

  /**
   * Get audit logs by admin user ID.
   *
   * @param adminUserId Admin user ID
   * @param limit Maximum records
   * @returns Audit log records for the admin
   */
  async findByAdminUserId(
    adminUserId: number,
    limit: number = 100
  ): Promise<AdminAuditLog[]> {
    const sql = getSql();

    try {
      const rows = await sql`
        SELECT * FROM admin_audit_logs
        WHERE admin_user_id = ${adminUserId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      return rows.map((row: any) => this.mapToAuditLog(row));
    } catch (err) {
      throw new RepositoryError('AUDIT_ADMIN_FAILED', `Failed to find logs by admin user ID: ${String(err)}`);
    }
  }

  /**
   * Get audit statistics.
   *
   * @param startDate Optional start date filter
   * @param endDate Optional end date filter
   * @returns Audit log statistics
   */
  async getAuditStats(startDate?: Date, endDate?: Date): Promise<AuditLogStats> {
    const sql = getSql();

    try {
      let countQuery = sql`SELECT COUNT(*) as count FROM admin_audit_logs WHERE 1=1`;
      let successQuery = sql`SELECT COUNT(*) as count FROM admin_audit_logs WHERE status = 'success'`;
      let failedQuery = sql`SELECT COUNT(*) as count FROM admin_audit_logs WHERE status = 'failed'`;

      if (startDate) {
        countQuery = sql`${countQuery} AND created_at >= ${startDate}`;
        successQuery = sql`${successQuery} AND created_at >= ${startDate}`;
        failedQuery = sql`${failedQuery} AND created_at >= ${startDate}`;
      }

      if (endDate) {
        countQuery = sql`${countQuery} AND created_at <= ${endDate}`;
        successQuery = sql`${successQuery} AND created_at <= ${endDate}`;
        failedQuery = sql`${failedQuery} AND created_at <= ${endDate}`;
      }

      const [countResult, successResult, failedResult] = await Promise.all([
        countQuery,
        successQuery,
        failedQuery,
      ]);

      // Get actions breakdown
      let actionQuery = sql`
        SELECT action, COUNT(*) as count FROM admin_audit_logs
        WHERE 1=1
      `;

      if (startDate) actionQuery = sql`${actionQuery} AND created_at >= ${startDate}`;
      if (endDate) actionQuery = sql`${actionQuery} AND created_at <= ${endDate}`;

      actionQuery = sql`${actionQuery} GROUP BY action`;

      const actionRows = await actionQuery;
      const actions: Record<string, number> = {};
      actionRows.forEach((row: any) => {
        actions[row.action] = row.count;
      });

      // Get admin users breakdown
      let adminQuery = sql`
        SELECT admin_user_id, COUNT(*) as count FROM admin_audit_logs
        WHERE 1=1
      `;

      if (startDate) adminQuery = sql`${adminQuery} AND created_at >= ${startDate}`;
      if (endDate) adminQuery = sql`${adminQuery} AND created_at <= ${endDate}`;

      adminQuery = sql`${adminQuery} GROUP BY admin_user_id`;

      const adminRows = await adminQuery;
      const admin_users: Record<number, number> = {};
      adminRows.forEach((row: any) => {
        admin_users[row.admin_user_id] = row.count;
      });

      return {
        total_count: countResult[0]?.count || 0,
        success_count: successResult[0]?.count || 0,
        failed_count: failedResult[0]?.count || 0,
        actions,
        admin_users,
      };
    } catch (err) {
      throw new RepositoryError('AUDIT_STATS_FAILED', `Failed to get audit stats: ${String(err)}`);
    }
  }

  /**
   * Verify audit logs are immutable (append-only).
   *
   * This method confirms that no updates or deletes have been performed
   * on audit logs (since they're append-only, the ID sequence should be continuous).
   *
   * @returns Boolean indicating integrity status
   */
  async verifyImmutability(): Promise<boolean> {
    const sql = getSql();

    try {
      const rows = await sql`
        SELECT COUNT(*) as total, MAX(id) as max_id FROM admin_audit_logs
      `;

      if (!rows.length) return true; // Empty table is valid

      const { total, max_id } = rows[0];
      // In a pure append-only system, total should equal max_id (no gaps from deletes)
      // This is a simplistic check; real data integrity would use database constraints
      return total === max_id;
    } catch (err) {
      throw new RepositoryError('AUDIT_IMMUTABLE_FAILED', `Failed to verify audit immutability: ${String(err)}`);
    }
  }

  /**
   * Get audit logs for export.
   *
   * @param options Query filters
   * @returns All matching audit logs for export
   */
  async getForExport(options: AuditLogQueryOptions): Promise<AdminAuditLog[]> {
    // Same as queryAuditLogs but without pagination limits
    const sql = getSql();

    try {
      let query = sql`SELECT * FROM admin_audit_logs WHERE 1=1`;

      if (options.adminUserId) {
        query = sql`${query} AND admin_user_id = ${options.adminUserId}`;
      }

      if (options.correlationId) {
        query = sql`${query} AND correlation_id = ${options.correlationId}`;
      }

      if (options.action) {
        query = sql`${query} AND action = ${options.action}`;
      }

      if (options.resourceType) {
        query = sql`${query} AND resource_type = ${options.resourceType}`;
      }

      if (options.status) {
        query = sql`${query} AND status = ${options.status}`;
      }

      if (options.startDate) {
        query = sql`${query} AND created_at >= ${options.startDate}`;
      }

      if (options.endDate) {
        query = sql`${query} AND created_at <= ${options.endDate}`;
      }

      query = sql`${query} ORDER BY created_at ASC`;

      const rows = await query;
      return rows.map((row: any) => this.mapToAuditLog(row));
    } catch (err) {
      throw new RepositoryError('AUDIT_EXPORT_FAILED', `Failed to get audit logs for export: ${String(err)}`);
    }
  }

  /**
   * Helper: map database row to AdminAuditLog.
   */
  private mapToAuditLog(row: any): AdminAuditLog {
    return {
      id: row.id,
      admin_user_id: row.admin_user_id,
      session_id: row.session_id,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      changes: row.changes ? JSON.parse(row.changes) : undefined,
      correlation_id: row.correlation_id,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      role: row.role,
      status: row.status,
      error_message: row.error_message,
      request_duration_ms: row.request_duration_ms,
      created_at: new Date(row.created_at),
    };
  }
}

/**
 * Get singleton instance of AuditLogRepository.
 */
let auditLogRepoInstance: AuditLogRepository | null = null;

export function getAuditLogRepository(): AuditLogRepository {
  if (!auditLogRepoInstance) {
    auditLogRepoInstance = new AuditLogRepository();
  }
  return auditLogRepoInstance;
}
