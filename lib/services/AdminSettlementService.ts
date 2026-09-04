/**
 * Admin Settlement Service
 *
 * Read-only access to settlement and transaction data for investigation.
 * Used by Operations Console for financial reconciliation.
 */

import { checkPermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';

export interface AdminTransactionDTO {
  id: number;
  sender_id: number;
  receiver_id: number;
  type: string;
  amount: number;
  status: string;
  sender_currency: string;
  receiver_currency: string;
  fx_rate: string;
  fx_fee: string;
  sender_amount?: string;
  receiver_amount?: string;
  is_cross_border: boolean;
  payment_rail: string;
  estimated_settlement?: string;
  correlation_id?: string;
  created_at: string;
}

export interface AdminSettlementStats {
  total_transactions: number;
  total_volume: Record<string, string>;
  by_status: Record<string, number>;
  by_payment_rail: Record<string, number>;
  cross_border_count: number;
}

export interface SettlementSearchFilters {
  senderId?: number;
  receiverId?: number;
  status?: string;
  currency?: string;
  startDate?: Date;
  endDate?: Date;
  correlationId?: string;
}

/**
 * Raw row shape returned by this service's queries. The SELECTs project
 * exactly the AdminTransactionDTO columns, so the row and the DTO share a shape.
 */
type AdminTransactionRow = AdminTransactionDTO;

export class AdminSettlementService {
  /**
   * Search transactions (paginated).
   * Requires settlements:view or transfers:view permission.
   */
  async searchTransactions(
    filters: SettlementSearchFilters,
    page: number = 1,
    pageSize: number = 50
  ): Promise<{
    transactions: AdminTransactionDTO[];
    total_count: number;
    page: number;
    page_size: number;
  }> {
    if (!checkPermission('settlements:view') && !checkPermission('transfers:view')) {
      throw new Error('Permission denied: settlements:view or transfers:view');
    }

    const sql = getSql();
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;

    // Build query
    let query = sql`SELECT * FROM transactions WHERE 1=1`;

    if (filters.senderId) {
      query = sql`${query} AND sender_id = ${filters.senderId}`;
    }

    if (filters.receiverId) {
      query = sql`${query} AND receiver_id = ${filters.receiverId}`;
    }

    if (filters.status) {
      query = sql`${query} AND status = ${filters.status}`;
    }

    if (filters.currency) {
      query = sql`${query} AND (sender_currency = ${filters.currency} OR receiver_currency = ${filters.currency})`;
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

    query = sql`${query} ORDER BY created_at DESC LIMIT ${limit + 1} OFFSET ${offset}`;

    // Get count
    let countQ = sql`SELECT COUNT(*) as count FROM transactions WHERE 1=1`;

    if (filters.senderId) countQ = sql`${countQ} AND sender_id = ${filters.senderId}`;
    if (filters.receiverId) countQ = sql`${countQ} AND receiver_id = ${filters.receiverId}`;
    if (filters.status) countQ = sql`${countQ} AND status = ${filters.status}`;
    if (filters.currency) {
      countQ = sql`${countQ} AND (sender_currency = ${filters.currency} OR receiver_currency = ${filters.currency})`;
    }
    if (filters.startDate) countQ = sql`${countQ} AND created_at >= ${filters.startDate}`;
    if (filters.endDate) countQ = sql`${countQ} AND created_at <= ${filters.endDate}`;
    if (filters.correlationId) countQ = sql`${countQ} AND correlation_id = ${filters.correlationId}`;

    const [rows, countResult] = await Promise.all([query, countQ]);

    return {
      transactions: (rows as unknown as AdminTransactionRow[]).slice(0, limit).map((t) => this.toDTO(t)),
      total_count: countResult[0]?.count || 0,
      page,
      page_size: limit,
    };
  }

  /**
   * Get a specific transaction by ID.
   * Requires settlements:view permission.
   */
  async getTransactionById(id: number): Promise<AdminTransactionDTO | null> {
    if (!checkPermission('settlements:view')) {
      throw new Error('Permission denied: settlements:view');
    }

    const sql = getSql();
    const rows = await sql`SELECT * FROM transactions WHERE id = ${id}`;

    return rows.length ? this.toDTO(rows[0] as unknown as AdminTransactionRow) : null;
  }

  /**
   * Get transactions by correlation ID.
   * Requires settlements:view permission.
   */
  async getTransactionsByCorrelationId(correlationId: string): Promise<AdminTransactionDTO[]> {
    if (!checkPermission('settlements:view')) {
      throw new Error('Permission denied: settlements:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM transactions
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at ASC
    `;

    return (rows as unknown as AdminTransactionRow[]).map((t) => this.toDTO(t));
  }

  /**
   * Get user's transactions.
   * Requires settlements:view permission.
   */
  async getUserTransactions(userId: number, limit: number = 100): Promise<AdminTransactionDTO[]> {
    if (!checkPermission('settlements:view')) {
      throw new Error('Permission denied: settlements:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM transactions
      WHERE sender_id = ${userId} OR receiver_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return (rows as unknown as AdminTransactionRow[]).map((t) => this.toDTO(t));
  }

  /**
   * Get settlement statistics.
   * Requires settlements:view permission.
   */
  async getSettlementStats(
    startDate?: Date,
    endDate?: Date
  ): Promise<AdminSettlementStats> {
    if (!checkPermission('settlements:view')) {
      throw new Error('Permission denied: settlements:view');
    }

    const sql = getSql();

    let query = sql`
      SELECT
        status,
        payment_rail,
        is_cross_border,
        COUNT(*) as count,
        SUM(amount) as total_amount,
        sender_currency
      FROM transactions
      WHERE 1=1
    `;

    if (startDate) {
      query = sql`${query} AND created_at >= ${startDate}`;
    }

    if (endDate) {
      query = sql`${query} AND created_at <= ${endDate}`;
    }

    query = sql`${query} GROUP BY status, payment_rail, is_cross_border, sender_currency`;

    const rows = await query;

    const byStatus: Record<string, number> = {};
    const byPaymentRail: Record<string, number> = {};
    const totalVolume: Record<string, number> = {};
    let total = 0;
    let crossBorderCount = 0;

    // COUNT(*) is bigint; postgres.js returns it as a string.
    type StatsRow = {
      status: string;
      payment_rail: string;
      sender_currency: string;
      count: string;
      total_amount: string | null;
      is_cross_border: boolean | null;
    };

    (rows as unknown as StatsRow[]).forEach((row) => {
      const count = Number(row.count);
      const amount = parseFloat(row.total_amount || '0');

      byStatus[row.status] = (byStatus[row.status] || 0) + count;
      byPaymentRail[row.payment_rail] = (byPaymentRail[row.payment_rail] || 0) + count;

      const key = row.sender_currency;
      if (!totalVolume[key]) totalVolume[key] = 0;
      totalVolume[key] += amount;

      if (row.is_cross_border) {
        crossBorderCount += count;
      }

      total += count;
    });

    const totalVolumeStr: Record<string, string> = {};
    Object.entries(totalVolume).forEach(([key, value]) => {
      totalVolumeStr[key] = String(value);
    });

    return {
      total_transactions: total,
      total_volume: totalVolumeStr,
      by_status: byStatus,
      by_payment_rail: byPaymentRail,
      cross_border_count: crossBorderCount,
    };
  }

  /**
   * Convert transaction to DTO.
   */
  private toDTO(transaction: AdminTransactionRow): AdminTransactionDTO {
    return {
      id: transaction.id,
      sender_id: transaction.sender_id,
      receiver_id: transaction.receiver_id,
      type: transaction.type,
      amount: transaction.amount,
      status: transaction.status,
      sender_currency: transaction.sender_currency,
      receiver_currency: transaction.receiver_currency,
      fx_rate: String(transaction.fx_rate),
      fx_fee: String(transaction.fx_fee),
      sender_amount: transaction.sender_amount ? String(transaction.sender_amount) : undefined,
      receiver_amount: transaction.receiver_amount ? String(transaction.receiver_amount) : undefined,
      is_cross_border: transaction.is_cross_border,
      payment_rail: transaction.payment_rail,
      estimated_settlement: transaction.estimated_settlement,
      correlation_id: transaction.correlation_id,
      created_at: transaction.created_at,
    };
  }
}

export function getAdminSettlementService(): AdminSettlementService {
  return new AdminSettlementService();
}
