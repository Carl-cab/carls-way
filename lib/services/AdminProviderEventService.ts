/**
 * Admin Provider Event Service
 *
 * Read-only access to provider webhook events for investigation.
 * Used by Operations Console for webhook debugging and tracing.
 */

import { checkPermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';

export interface AdminProviderEventDTO {
  id: number;
  provider: string;
  provider_event_id: string;
  event_type: string;
  related_provider_reference?: string;
  raw_payload?: Record<string, any>;
  processing_status: string;
  processing_error?: string;
  processed_at?: string;
  balance_processed_at?: string;
  balance_processing_error?: string;
  correlation_id?: string;
  created_at: string;
}

export interface AdminProviderEventListResponse {
  events: AdminProviderEventDTO[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface ProviderEventSearchFilters {
  provider?: string;
  eventType?: string;
  status?: string;
  startDate?: Date;
  endDate?: Date;
  correlationId?: string;
}

export class AdminProviderEventService {
  /**
   * Search provider events (paginated).
   * Requires provider_events:view permission.
   */
  async searchProviderEvents(
    filters: ProviderEventSearchFilters,
    page: number = 1,
    pageSize: number = 50
  ): Promise<AdminProviderEventListResponse> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;

    // Build query
    let query = sql`SELECT * FROM provider_webhook_events WHERE 1=1`;

    if (filters.provider) {
      query = sql`${query} AND provider = ${filters.provider}`;
    }

    if (filters.eventType) {
      query = sql`${query} AND event_type = ${filters.eventType}`;
    }

    if (filters.status) {
      query = sql`${query} AND processing_status = ${filters.status}`;
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
    let countQ = sql`SELECT COUNT(*) as count FROM provider_webhook_events WHERE 1=1`;

    if (filters.provider) countQ = sql`${countQ} AND provider = ${filters.provider}`;
    if (filters.eventType) countQ = sql`${countQ} AND event_type = ${filters.eventType}`;
    if (filters.status) countQ = sql`${countQ} AND processing_status = ${filters.status}`;
    if (filters.startDate) countQ = sql`${countQ} AND created_at >= ${filters.startDate}`;
    if (filters.endDate) countQ = sql`${countQ} AND created_at <= ${filters.endDate}`;
    if (filters.correlationId) countQ = sql`${countQ} AND correlation_id = ${filters.correlationId}`;

    const [rows, countResult] = await Promise.all([query, countQ]);

    return {
      events: rows.slice(0, limit).map((e: any) => this.toDTO(e)),
      total_count: countResult[0]?.count || 0,
      page,
      page_size: limit,
    };
  }

  /**
   * Get a specific provider event by ID.
   * Requires provider_events:view permission.
   */
  async getProviderEventById(id: number): Promise<AdminProviderEventDTO | null> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql`SELECT * FROM provider_webhook_events WHERE id = ${id}`;

    return rows.length ? this.toDTO(rows[0]) : null;
  }

  /**
   * Get provider events by correlation ID.
   * Requires provider_events:view permission.
   */
  async getEventsByCorrelationId(correlationId: string): Promise<AdminProviderEventDTO[]> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM provider_webhook_events
      WHERE correlation_id = ${correlationId}
      ORDER BY created_at ASC
    `;

    return rows.map((e: any) => this.toDTO(e));
  }

  /**
   * Get events for a specific provider.
   * Requires provider_events:view permission.
   */
  async getProviderEvents(
    provider: string,
    limit: number = 100
  ): Promise<AdminProviderEventDTO[]> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();
    const rows = await sql`
      SELECT * FROM provider_webhook_events
      WHERE provider = ${provider}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    return rows.map((e: any) => this.toDTO(e));
  }

  /**
   * Get provider event statistics.
   * Requires provider_events:view permission.
   */
  async getProviderEventStats(startDate?: Date, endDate?: Date): Promise<{
    total_events: number;
    by_provider: Record<string, number>;
    by_status: Record<string, number>;
    by_event_type: Record<string, number>;
  }> {
    if (!checkPermission('provider_events:view')) {
      throw new Error('Permission denied: provider_events:view');
    }

    const sql = getSql();

    let baseQuery = sql`SELECT provider, event_type, processing_status, COUNT(*) as count FROM provider_webhook_events WHERE 1=1`;

    if (startDate) {
      baseQuery = sql`${baseQuery} AND created_at >= ${startDate}`;
    }

    if (endDate) {
      baseQuery = sql`${baseQuery} AND created_at <= ${endDate}`;
    }

    const rows = await sql`${baseQuery} GROUP BY provider, event_type, processing_status`;

    const byProvider: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    let total = 0;

    rows.forEach((row: any) => {
      const count = row.count;
      byProvider[row.provider] = (byProvider[row.provider] || 0) + count;
      byStatus[row.processing_status] = (byStatus[row.processing_status] || 0) + count;
      byEventType[row.event_type] = (byEventType[row.event_type] || 0) + count;
      total += count;
    });

    return {
      total_events: total,
      by_provider: byProvider,
      by_status: byStatus,
      by_event_type: byEventType,
    };
  }

  /**
   * Convert provider event to DTO.
   */
  private toDTO(event: any): AdminProviderEventDTO {
    return {
      id: event.id,
      provider: event.provider,
      provider_event_id: event.provider_event_id,
      event_type: event.event_type,
      related_provider_reference: event.related_provider_reference,
      raw_payload: event.raw_payload ? JSON.parse(event.raw_payload) : undefined,
      processing_status: event.processing_status,
      processing_error: event.processing_error,
      processed_at: event.processed_at,
      balance_processed_at: event.balance_processed_at,
      balance_processing_error: event.balance_processing_error,
      correlation_id: event.correlation_id,
      created_at: event.created_at,
    };
  }
}

export function getAdminProviderEventService(): AdminProviderEventService {
  return new AdminProviderEventService();
}
