/**
 * Admin Transfer Service
 *
 * Read-only access to transfer intents for investigation.
 * Used by Operations Console for transfer investigation.
 */

import { checkPermission, maskSensitiveFields } from '@/lib/rbac';
import { getSql } from '@/lib/db';
import type { AdminRole } from '@/lib/rbac/types';

export interface AdminTransferDTO {
  id: number;
  user_id: number;
  bank_account_id?: number;
  type: string;
  amount: number;
  currency: string;
  status: string;
  provider_region: string;
  provider_name: string;
  execution_mode: string;
  provider_reference_id?: string;
  failure_reason?: string;
  consent_confirmed_at?: string;
  idempotency_key?: string;
  correlation_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AdminTransferListResponse {
  transfers: AdminTransferDTO[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface TransferSearchFilters {
  userId?: number;
  status?: string;
  type?: string;
  provider?: string;
  startDate?: Date;
  endDate?: Date;
  correlationId?: string;
}

/**
 * Raw row shape returned by this service's queries. The SELECTs project
 * exactly the AdminTransferDTO columns, so the row and the DTO share a shape.
 */
type AdminTransferRow = AdminTransferDTO;

export class AdminTransferService {
  /**
   * Search transfers with filters (paginated).
   * Requires transfers:view or transfers:search permission.
   */
  async searchTransfers(
    filters: TransferSearchFilters,
    page: number = 1,
    pageSize: number = 50,
    role?: AdminRole
  ): Promise<AdminTransferListResponse> {
    if (!checkPermission('transfers:view') && !checkPermission('transfers:search')) {
      throw new Error('Permission denied: transfers:view or transfers:search');
    }

    const sql = getSql();
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;

    // Build query
    let query = sql`SELECT * FROM transfer_intents WHERE 1=1`;

    if (filters.userId) {
      query = sql`${query} AND user_id = ${filters.userId}`;
    }

    if (filters.status) {
      query = sql`${query} AND status = ${filters.status}`;
    }

    if (filters.type) {
      query = sql`${query} AND type = ${filters.type}`;
    }

    if (filters.provider) {
      query = sql`${query} AND provider_name = ${filters.provider}`;
    }

    if (filters.startDate) {
      query = sql`${query} AND created_at >= ${filters.startDate}`;
    }

    if (filters.endDate) {
      query = sql`${query} AND created_at <= ${filters.endDate}`;
    }

    if (filters.correlationId) {
      query = sql`${query} AND correlation_id = ${filters.correlationId}`;
    }

    // Get count
    const countQuery = sql`SELECT COUNT(*) as count FROM transfer_intents WHERE 1=1`;
    let countQ = countQuery;

    if (filters.userId) countQ = sql`${countQ} AND user_id = ${filters.userId}`;
    if (filters.status) countQ = sql`${countQ} AND status = ${filters.status}`;
    if (filters.type) countQ = sql`${countQ} AND type = ${filters.type}`;
    if (filters.provider) countQ = sql`${countQ} AND provider_name = ${filters.provider}`;
    if (filters.startDate) countQ = sql`${countQ} AND created_at >= ${filters.startDate}`;
    if (filters.endDate) countQ = sql`${countQ} AND created_at <= ${filters.endDate}`;
    if (filters.correlationId) countQ = sql`${countQ} AND correlation_id = ${filters.correlationId}`;

    const [rows, countResult] = await Promise.all([
      query.then((r: unknown[]) => r.slice(0, limit + 1)),
      countQ,
    ]);

    return {
      transfers: (rows as unknown as AdminTransferRow[]).slice(0, limit).map((t) => this.toDTO(t)),
      total_count: countResult[0]?.count || 0,
      page,
      page_size: limit,
    };
  }

  /**
   * Get a specific transfer by ID.
   * Requires transfers:view permission.
   */
  async getTransferById(id: number): Promise<AdminTransferDTO | null> {
    if (!checkPermission('transfers:view')) {
      throw new Error('Permission denied: transfers:view');
    }

    const sql = getSql();
    const rows = await sql`SELECT * FROM transfer_intents WHERE id = ${id}`;

    return rows.length ? this.toDTO(rows[0] as unknown as AdminTransferRow) : null;
  }

  /**
   * Get transfers by correlation ID (trace full flow).
   * Requires transfers:view permission.
   */
  async getTransfersByCorrelationId(correlationId: string): Promise<AdminTransferDTO[]> {
    if (!checkPermission('transfers:view')) {
      throw new Error('Permission denied: transfers:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM transfer_intents
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at ASC
    `;

    return (rows as unknown as AdminTransferRow[]).map((t) => this.toDTO(t));
  }

  /**
   * Get all transfers for a user.
   * Requires transfers:search permission.
   */
  async getTransfersForUser(userId: number, limit: number = 100): Promise<AdminTransferDTO[]> {
    if (!checkPermission('transfers:search')) {
      throw new Error('Permission denied: transfers:search');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM transfer_intents
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return (rows as unknown as AdminTransferRow[]).map((t) => this.toDTO(t));
  }

  /**
   * Get transfer statistics.
   * Requires transfers:view permission.
   */
  async getTransferStats(
    startDate?: Date,
    endDate?: Date
  ): Promise<{
    total_count: number;
    by_status: Record<string, number>;
    by_provider: Record<string, number>;
  }> {
    if (!checkPermission('transfers:view')) {
      throw new Error('Permission denied: transfers:view');
    }

    const sql = getSql();

    let query = sql`SELECT status, provider_name, COUNT(*) as count FROM transfer_intents WHERE 1=1`;

    if (startDate) {
      query = sql`${query} AND created_at >= ${startDate}`;
    }

    if (endDate) {
      query = sql`${query} AND created_at <= ${endDate}`;
    }

    query = sql`${query} GROUP BY status, provider_name`;

    const rows = await query;
    const byStatus: Record<string, number> = {};
    const byProvider: Record<string, number> = {};

    // COUNT(*) is bigint; postgres.js returns it as a string.
    type StatsRow = { status: string; provider_name: string; count: string };

    (rows as unknown as StatsRow[]).forEach((row) => {
      const count = Number(row.count);
      byStatus[row.status] = (byStatus[row.status] || 0) + count;
      byProvider[row.provider_name] = (byProvider[row.provider_name] || 0) + count;
    });

    const totalCount = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return {
      total_count: totalCount,
      by_status: byStatus,
      by_provider: byProvider,
    };
  }

  /**
   * Convert transfer to DTO (no bank account details).
   */
  private toDTO(transfer: AdminTransferRow): AdminTransferDTO {
    return {
      id: transfer.id,
      user_id: transfer.user_id,
      bank_account_id: transfer.bank_account_id,
      type: transfer.type,
      amount: transfer.amount,
      currency: transfer.currency,
      status: transfer.status,
      provider_region: transfer.provider_region,
      provider_name: transfer.provider_name,
      execution_mode: transfer.execution_mode,
      provider_reference_id: transfer.provider_reference_id,
      failure_reason: transfer.failure_reason,
      consent_confirmed_at: transfer.consent_confirmed_at,
      idempotency_key: transfer.idempotency_key,
      correlation_id: transfer.correlation_id,
      created_at: transfer.created_at,
      updated_at: transfer.updated_at,
    };
  }
}

export function getAdminTransferService(): AdminTransferService {
  return new AdminTransferService();
}
