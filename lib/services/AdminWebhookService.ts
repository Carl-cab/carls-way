/**
 * Read-only access to provider webhook event processing for the Operations Console.
 *
 * Provider webhooks are persisted in `provider_webhook_events`; this service projects
 * that canonical table into the console's historical webhook response contract.
 */

import { checkPermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';

export interface AdminWebhookDTO {
  id: number;
  provider: string;
  event_id: string;
  event_type: string;
  status: string;
  processing_attempts: number;
  error_message?: string;
  correlation_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AdminWebhookListResponse {
  webhooks: AdminWebhookDTO[];
  total_count: number | string;
  page: number;
  page_size: number;
}

export interface WebhookSearchFilters {
  provider?: string;
  eventType?: string;
  status?: string;
  correlationId?: string;
  startDate?: Date;
  endDate?: Date;
}

type AdminWebhookRow = {
  id: number;
  provider: string;
  event_id: string;
  event_type: string;
  status: string;
  processing_attempts: number;
  error_message: string | null;
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
};

const eventProjection = `
  id,
  provider,
  provider_event_id AS event_id,
  event_type,
  processing_status AS status,
  1::integer AS processing_attempts,
  processing_error AS error_message,
  correlation_id,
  created_at,
  COALESCE(processed_at, created_at) AS updated_at
`;

export class AdminWebhookService {
  async searchWebhooks(
    filters: WebhookSearchFilters,
    page: number = 1,
    pageSize: number = 50
  ): Promise<AdminWebhookListResponse> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const limit = Math.min(Math.max(pageSize, 1), 100);
    const safePage = Math.max(page, 1);
    const offset = (safePage - 1) * limit;

    let query = sql.unsafe(`SELECT ${eventProjection} FROM provider_webhook_events WHERE TRUE`);
    let countQuery = sql`SELECT COUNT(*) AS count FROM provider_webhook_events WHERE TRUE`;

    if (filters.provider) {
      query = sql`${query} AND provider = ${filters.provider}`;
      countQuery = sql`${countQuery} AND provider = ${filters.provider}`;
    }
    if (filters.eventType) {
      query = sql`${query} AND event_type = ${filters.eventType}`;
      countQuery = sql`${countQuery} AND event_type = ${filters.eventType}`;
    }
    if (filters.status) {
      query = sql`${query} AND processing_status = ${filters.status}`;
      countQuery = sql`${countQuery} AND processing_status = ${filters.status}`;
    }
    if (filters.startDate) {
      query = sql`${query} AND created_at >= ${filters.startDate}`;
      countQuery = sql`${countQuery} AND created_at >= ${filters.startDate}`;
    }
    if (filters.endDate) {
      query = sql`${query} AND created_at <= ${filters.endDate}`;
      countQuery = sql`${countQuery} AND created_at <= ${filters.endDate}`;
    }
    if (filters.correlationId) {
      query = sql`${query} AND correlation_id = ${filters.correlationId}`;
      countQuery = sql`${countQuery} AND correlation_id = ${filters.correlationId}`;
    }

    query = sql`${query} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;

    const [rows, countResult] = await Promise.all([query, countQuery]);
    return {
      webhooks: (rows as unknown as AdminWebhookRow[]).map((row) => this.toDTO(row)),
      total_count: countResult[0]?.count ?? 0,
      page: safePage,
      page_size: limit,
    };
  }

  async getWebhookById(id: number): Promise<AdminWebhookDTO | null> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql.unsafe<AdminWebhookRow[]>(
      `SELECT ${eventProjection} FROM provider_webhook_events WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? this.toDTO(rows[0]) : null;
  }

  async getWebhooksByCorrelationId(correlationId: string): Promise<AdminWebhookDTO[]> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql.unsafe<AdminWebhookRow[]>(
      `SELECT ${eventProjection}
       FROM provider_webhook_events
       WHERE correlation_id = $1
       ORDER BY created_at ASC`,
      [correlationId]
    );
    return rows.map((row) => this.toDTO(row));
  }

  async getProviderWebhooks(provider: string, limit: number = 100): Promise<AdminWebhookDTO[]> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql.unsafe<AdminWebhookRow[]>(
      `SELECT ${eventProjection}
       FROM provider_webhook_events
       WHERE provider = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [provider, Math.min(Math.max(limit, 1), 100)]
    );
    return rows.map((row) => this.toDTO(row));
  }

  async getWebhookStats(startDate?: Date, endDate?: Date): Promise<{
    total_webhooks: number;
    by_provider: Record<string, number>;
    by_status: Record<string, number>;
    by_event_type: Record<string, number>;
    failed_count: number;
    retry_count: number;
  }> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    let query = sql`
      SELECT provider, event_type, processing_status AS status, COUNT(*) AS count
      FROM provider_webhook_events
      WHERE TRUE
    `;

    if (startDate) query = sql`${query} AND created_at >= ${startDate}`;
    if (endDate) query = sql`${query} AND created_at <= ${endDate}`;
    query = sql`${query} GROUP BY provider, event_type, processing_status`;

    const rows = await query as unknown as Array<{
      provider: string;
      event_type: string;
      status: string;
      count: string;
    }>;

    const by_provider: Record<string, number> = {};
    const by_status: Record<string, number> = {};
    const by_event_type: Record<string, number> = {};
    let total_webhooks = 0;
    let failed_count = 0;

    for (const row of rows) {
      const count = Number(row.count);
      by_provider[row.provider] = (by_provider[row.provider] ?? 0) + count;
      by_status[row.status] = (by_status[row.status] ?? 0) + count;
      by_event_type[row.event_type] = (by_event_type[row.event_type] ?? 0) + count;
      total_webhooks += count;
      if (row.status === 'failed') failed_count += count;
    }

    return {
      total_webhooks,
      by_provider,
      by_status,
      by_event_type,
      failed_count,
      // provider_webhook_events does not track individual retry attempts yet.
      retry_count: 0,
    };
  }

  private toDTO(row: AdminWebhookRow): AdminWebhookDTO {
    return {
      id: row.id,
      provider: row.provider,
      event_id: row.event_id,
      event_type: row.event_type,
      status: row.status,
      processing_attempts: row.processing_attempts,
      error_message: row.error_message ?? undefined,
      correlation_id: row.correlation_id ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

export function getAdminWebhookService(): AdminWebhookService {
  return new AdminWebhookService();
}
