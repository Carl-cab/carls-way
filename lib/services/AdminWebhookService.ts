/**
 * Admin Webhook Service
 *
 * Read-only access to webhook event processing for investigation.
 * Used by Operations Console for webhook debugging and tracing.
 */

import { checkPermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';

export interface AdminWebhookDTO {
  id: number;
  provider: string;
  event_id: string;
  event_type: string;
  status: string;
  related_resource_id?: number;
  related_resource_type?: string;
  http_status_code?: number;
  processing_attempts: number;
  error_message?: string;
  next_retry_at?: string;
  correlation_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AdminWebhookListResponse {
  webhooks: AdminWebhookDTO[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface WebhookSearchFilters {
  provider?: string;
  eventType?: string;
  status?: string;
  relatedResourceType?: string;
  startDate?: Date;
  endDate?: Date;
  correlationId?: string;
}

export class AdminWebhookService {
  /**
   * Search webhooks (paginated).
   * Requires provider_events:view permission.
   */
  async searchWebhooks(
    filters: WebhookSearchFilters,
    page: number = 1,
    pageSize: number = 50
  ): Promise<AdminWebhookListResponse> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;

    // Build query
    let query = sql`SELECT * FROM webhooks WHERE 1=1`;

    if (filters.provider) {
      query = sql`${query} AND provider = ${filters.provider}`;
    }

    if (filters.eventType) {
      query = sql`${query} AND event_type = ${filters.eventType}`;
    }

    if (filters.status) {
      query = sql`${query} AND status = ${filters.status}`;
    }

    if (filters.relatedResourceType) {
      query = sql`${query} AND related_resource_type = ${filters.relatedResourceType}`;
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
    let countQ = sql`SELECT COUNT(*) as count FROM webhooks WHERE 1=1`;

    if (filters.provider) countQ = sql`${countQ} AND provider = ${filters.provider}`;
    if (filters.eventType) countQ = sql`${countQ} AND event_type = ${filters.eventType}`;
    if (filters.status) countQ = sql`${countQ} AND status = ${filters.status}`;
    if (filters.relatedResourceType) countQ = sql`${countQ} AND related_resource_type = ${filters.relatedResourceType}`;
    if (filters.startDate) countQ = sql`${countQ} AND created_at >= ${filters.startDate}`;
    if (filters.endDate) countQ = sql`${countQ} AND created_at <= ${filters.endDate}`;
    if (filters.correlationId) countQ = sql`${countQ} AND correlation_id = ${filters.correlationId}`;

    const [rows, countResult] = await Promise.all([query, countQ]);

    return {
      webhooks: rows.slice(0, limit).map((w: any) => this.toDTO(w)),
      total_count: countResult[0]?.count || 0,
      page,
      page_size: limit,
    };
  }

  /**
   * Get a specific webhook by ID.
   * Requires provider_events:view permission.
   */
  async getWebhookById(id: number): Promise<AdminWebhookDTO | null> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql`SELECT * FROM webhooks WHERE id = ${id}`;

    return rows.length ? this.toDTO(rows[0]) : null;
  }

  /**
   * Get webhooks by correlation ID.
   * Requires provider_events:view permission.
   */
  async getWebhooksByCorrelationId(correlationId: string): Promise<AdminWebhookDTO[]> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM webhooks
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at ASC
    `;

    return rows.map((w: any) => this.toDTO(w));
  }

  /**
   * Get webhooks for a specific provider.
   * Requires provider_events:view permission.
   */
  async getProviderWebhooks(
    provider: string,
    limit: number = 100
  ): Promise<AdminWebhookDTO[]> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM webhooks
      WHERE provider = ${provider}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return rows.map((w: any) => this.toDTO(w));
  }

  /**
   * Get webhook statistics.
   * Requires provider_events:view permission.
   */
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

    let query = sql`SELECT provider, event_type, status, COUNT(*) as count FROM webhooks WHERE 1=1`;

    if (startDate) {
      query = sql`${query} AND created_at >= ${startDate}`;
    }

    if (endDate) {
      query = sql`${query} AND created_at <= ${endDate}`;
    }

    query = sql`${query} GROUP BY provider, event_type, status`;

    const rows = await query;

    const byProvider: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    let total = 0;
    let failed = 0;
    let retries = 0;

    rows.forEach((row: any) => {
      const count = row.count;
      byProvider[row.provider] = (byProvider[row.provider] || 0) + count;
      byStatus[row.status] = (byStatus[row.status] || 0) + count;
      byEventType[row.event_type] = (byEventType[row.event_type] || 0) + count;
      total += count;

      if (row.status === 'failed') {
        failed += count;
      }
    });

    // Get retry count
    const retryResult = await sql`
      SELECT COUNT(*) as count FROM webhooks
      WHERE processing_attempts > 1
      ${startDate ? sql`AND created_at >= ${startDate}` : sql``}
      ${endDate ? sql`AND created_at <= ${endDate}` : sql``}
    `;

    retries = retryResult[0]?.count || 0;

    return {
      total_webhooks: total,
      by_provider: byProvider,
      by_status: byStatus,
      by_event_type: byEventType,
      failed_count: failed,
      retry_count: retries,
    };
  }

  /**
   * Convert webhook to DTO.
   */
  private toDTO(webhook: any): AdminWebhookDTO {
    return {
      id: webhook.id,
      provider: webhook.provider,
      event_id: webhook.event_id,
      event_type: webhook.event_type,
      status: webhook.status,
      related_resource_id: webhook.related_resource_id,
      related_resource_type: webhook.related_resource_type,
      http_status_code: webhook.http_status_code,
      processing_attempts: webhook.processing_attempts,
      error_message: webhook.error_message,
      next_retry_at: webhook.next_retry_at,
      correlation_id: webhook.correlation_id,
      created_at: webhook.created_at,
      updated_at: webhook.updated_at,
    };
  }
}

export function getAdminWebhookService(): AdminWebhookService {
  return new AdminWebhookService();
}
