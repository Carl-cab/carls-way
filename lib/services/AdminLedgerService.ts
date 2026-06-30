/**
 * Admin Ledger Service
 *
 * Read-only access to ledger entries for financial investigation.
 * Used by Operations Console for balance verification and reconciliation.
 */

import { checkPermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';

export interface AdminLedgerEntryDTO {
  id: number;
  user_id: number;
  transaction_id?: number;
  transfer_intent_id?: number;
  currency: string;
  account_type: string;
  entry_type: string;
  debit: string; // Numeric as string to preserve precision
  credit: string; // Numeric as string to preserve precision
  provider?: string;
  provider_reference?: string;
  provider_event_id?: string;
  description?: string;
  correlation_id?: string;
  created_at: string;
}

export interface AdminLedgerListResponse {
  entries: AdminLedgerEntryDTO[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface LedgerSearchFilters {
  userId?: number;
  currency?: string;
  entryType?: string;
  provider?: string;
  startDate?: Date;
  endDate?: Date;
  correlationId?: string;
}

export class AdminLedgerService {
  /**
   * Search ledger entries (paginated).
   * Requires ledger:view permission.
   */
  async searchLedger(
    filters: LedgerSearchFilters,
    page: number = 1,
    pageSize: number = 50
  ): Promise<AdminLedgerListResponse> {
    if (!checkPermission('ledger:view')) {
      throw new Error('Permission denied: ledger:view');
    }

    const sql = getSql();
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;

    // Build query
    let query = sql`SELECT * FROM ledger_entries WHERE 1=1`;

    if (filters.userId) {
      query = sql`${query} AND user_id = ${filters.userId}`;
    }

    if (filters.currency) {
      query = sql`${query} AND currency = ${filters.currency}`;
    }

    if (filters.entryType) {
      query = sql`${query} AND entry_type = ${filters.entryType}`;
    }

    if (filters.provider) {
      query = sql`${query} AND provider = ${filters.provider}`;
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

    // Get count (simplified)
    let countQ = sql`SELECT COUNT(*) as count FROM ledger_entries WHERE 1=1`;

    if (filters.userId) countQ = sql`${countQ} AND user_id = ${filters.userId}`;
    if (filters.currency) countQ = sql`${countQ} AND currency = ${filters.currency}`;
    if (filters.entryType) countQ = sql`${countQ} AND entry_type = ${filters.entryType}`;
    if (filters.provider) countQ = sql`${countQ} AND provider = ${filters.provider}`;
    if (filters.startDate) countQ = sql`${countQ} AND created_at >= ${filters.startDate}`;
    if (filters.endDate) countQ = sql`${countQ} AND created_at <= ${filters.endDate}`;
    if (filters.correlationId) countQ = sql`${countQ} AND correlation_id = ${filters.correlationId}`;

    const [rows, countResult] = await Promise.all([query, countQ]);

    return {
      entries: rows.slice(0, limit).map((e: any) => this.toDTO(e)),
      total_count: countResult[0]?.count || 0,
      page,
      page_size: limit,
    };
  }

  /**
   * Get ledger entries for a specific user.
   * Requires ledger:view permission.
   */
  async getUserLedger(userId: number, limit: number = 100): Promise<AdminLedgerEntryDTO[]> {
    if (!checkPermission('ledger:view')) {
      throw new Error('Permission denied: ledger:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM ledger_entries
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return rows.map((e: any) => this.toDTO(e));
  }

  /**
   * Get ledger entries by correlation ID.
   * Requires ledger:view permission.
   */
  async getEntriesByCorrelationId(correlationId: string): Promise<AdminLedgerEntryDTO[]> {
    if (!checkPermission('ledger:view')) {
      throw new Error('Permission denied: ledger:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM ledger_entries
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at ASC
    `;

    return rows.map((e: any) => this.toDTO(e));
  }

  /**
   * Get user balance from ledger.
   * Requires ledger:view permission.
   */
  async getUserBalance(userId: number, currency: string): Promise<{
    balance: string;
    last_updated: string;
  }> {
    if (!checkPermission('ledger:view')) {
      throw new Error('Permission denied: ledger:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT
        COALESCE(SUM(CAST(credit AS NUMERIC) - CAST(debit AS NUMERIC)), 0) as balance,
        MAX(created_at) as last_updated
      FROM ledger_entries
      WHERE user_id = ${userId} AND currency = ${currency}
    `;

    if (!rows.length) {
      return { balance: '0', last_updated: new Date().toISOString() };
    }

    return {
      balance: String(rows[0].balance),
      last_updated: rows[0].last_updated || new Date().toISOString(),
    };
  }

  /**
   * Get ledger reconciliation stats.
   * Requires ledger:view permission.
   */
  async getReconciliationStats(startDate?: Date, endDate?: Date): Promise<{
    total_debits: string;
    total_credits: string;
    net_balance: string;
    by_currency: Record<string, { debit: string; credit: string; balance: string }>;
  }> {
    if (!checkPermission('ledger:view')) {
      throw new Error('Permission denied: ledger:view');
    }

    const sql = getSql();

    let query = sql`
      SELECT
        currency,
        SUM(CAST(debit AS NUMERIC)) as total_debit,
        SUM(CAST(credit AS NUMERIC)) as total_credit
      FROM ledger_entries
      WHERE 1=1
    `;

    if (startDate) {
      query = sql`${query} AND created_at >= ${startDate}`;
    }

    if (endDate) {
      query = sql`${query} AND created_at <= ${endDate}`;
    }

    query = sql`${query} GROUP BY currency`;

    const rows = await query;

    const byCurrency: Record<string, any> = {};
    let totalDebit = 0;
    let totalCredit = 0;

    rows.forEach((row: any) => {
      const debit = parseFloat(row.total_debit || '0');
      const credit = parseFloat(row.total_credit || '0');

      byCurrency[row.currency] = {
        debit: String(debit),
        credit: String(credit),
        balance: String(credit - debit),
      };

      totalDebit += debit;
      totalCredit += credit;
    });

    return {
      total_debits: String(totalDebit),
      total_credits: String(totalCredit),
      net_balance: String(totalCredit - totalDebit),
      by_currency: byCurrency,
    };
  }

  /**
   * Convert ledger entry to DTO.
   */
  private toDTO(entry: any): AdminLedgerEntryDTO {
    return {
      id: entry.id,
      user_id: entry.user_id,
      transaction_id: entry.transaction_id,
      transfer_intent_id: entry.transfer_intent_id,
      currency: entry.currency,
      account_type: entry.account_type,
      entry_type: entry.entry_type,
      debit: String(entry.debit),
      credit: String(entry.credit),
      provider: entry.provider,
      provider_reference: entry.provider_reference,
      provider_event_id: entry.provider_event_id,
      description: entry.description,
      correlation_id: entry.correlation_id,
      created_at: entry.created_at,
    };
  }
}

export function getAdminLedgerService(): AdminLedgerService {
  return new AdminLedgerService();
}
