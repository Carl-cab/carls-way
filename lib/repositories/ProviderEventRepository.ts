/**
 * Provider event repository for managing webhook events and idempotency.
 *
 * Responsibilities:
 * - Record provider webhook events
 * - Ensure webhook idempotency (duplicate detection)
 * - Track event processing status
 * - Query events by provider and type
 * - No business logic, no settlement orchestration
 *
 * The provider_webhook_events table is the source of truth for webhook processing.
 * UNIQUE(provider, provider_event_id) constraint ensures idempotency.
 */

import { BaseRepository } from './BaseRepository';
import type {
  ProviderWebhookEvent,
  CreateProviderWebhookEventInput,
  PaginatedResult,
} from './types';
import { DuplicateKeyError } from './types';

export class ProviderEventRepository extends BaseRepository {
  /**
   * Find a provider event by ID.
   *
   * @param id Provider event ID
   * @returns Provider event or null
   */
  async findById(id: number): Promise<ProviderWebhookEvent | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE id = ${id}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'ProviderEventRepository.findById');
  }

  /**
   * Find a provider event by provider and event ID.
   *
   * @param provider Provider name (plaid, etc.)
   * @param providerEventId Provider event ID
   * @returns Provider event or null
   */
  async findByProviderEventId(
    provider: string,
    providerEventId: string
  ): Promise<ProviderWebhookEvent | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE provider = ${provider}
          AND provider_event_id = ${providerEventId}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'ProviderEventRepository.findByProviderEventId');
  }

  /**
   * Get provider events for a specific provider.
   *
   * @param provider Provider name
   * @param limit Maximum results
   * @param offset Offset for pagination
   * @returns Array of provider events
   */
  async findByProvider(
    provider: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<ProviderWebhookEvent[]> {
    return this.executeQuery(async () => {
      return this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE provider = ${provider}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
        OFFSET ${Math.max(0, offset)}
      `;
    }, 'ProviderEventRepository.findByProvider');
  }

  /**
   * Get provider events by event type.
   *
   * @param eventType Event type
   * @param limit Maximum results
   * @returns Array of provider events
   */
  async findByEventType(eventType: string, limit: number = 100): Promise<ProviderWebhookEvent[]> {
    return this.executeQuery(async () => {
      return this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE event_type = ${eventType}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'ProviderEventRepository.findByEventType');
  }

  /**
   * Get provider events by processing status.
   *
   * @param status Processing status
   * @param limit Maximum results
   * @returns Array of provider events
   */
  async findByStatus(
    status: 'received' | 'processing' | 'processed' | 'failed',
    limit: number = 100
  ): Promise<ProviderWebhookEvent[]> {
    return this.executeQuery(async () => {
      return this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE processing_status = ${status}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'ProviderEventRepository.findByStatus');
  }

  /**
   * Get all provider events paginated.
   *
   * @param page Page number (1-indexed)
   * @param limit Items per page
   * @returns Paginated events
   */
  async findAll(
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResult<ProviderWebhookEvent>> {
    return this.executeQuery(async () => {
      const { page: validPage, limit: validLimit } = this.validatePagination(page, limit);
      const offset = this.calculateOffset(validPage, validLimit);

      const [events, countResult] = await Promise.all([
        this.sql<ProviderWebhookEvent[]>`
          SELECT *
          FROM provider_webhook_events
          ORDER BY created_at DESC
          LIMIT ${validLimit}
          OFFSET ${offset}
        `,
        this.sql<{ count: number }[]>`
          SELECT COUNT(*) as count FROM provider_webhook_events
        `,
      ]);

      const total = countResult[0]?.count || 0;

      return {
        data: events,
        meta: {
          page: validPage,
          limit: validLimit,
          total,
          hasMore: offset + validLimit < total,
        },
      };
    }, 'ProviderEventRepository.findAll');
  }

  /**
   * Create a provider event record.
   *
   * This is the idempotency barrier. The UNIQUE(provider, provider_event_id)
   * constraint prevents duplicate events from being recorded.
   *
   * @param input Provider event data
   * @returns Created provider event
   * @throws DuplicateKeyError if event already exists
   */
  async create(input: CreateProviderWebhookEventInput): Promise<ProviderWebhookEvent> {
    return this.executeQuery(async () => {
      try {
        const result = await this.sql<ProviderWebhookEvent[]>`
          INSERT INTO provider_webhook_events (
            provider, provider_event_id, event_type, related_provider_reference,
            raw_payload, processing_status, correlation_id, created_at
          )
          VALUES (
            ${input.provider},
            ${input.provider_event_id},
            ${input.event_type},
            ${input.related_provider_reference || null},
            ${JSON.stringify(input.raw_payload)},
            'received',
            ${input.correlation_id || null},
            NOW()
          )
          RETURNING *
        `;

        this.assertFound(result[0], 'created provider event');
        return result[0];
      } catch (err) {
        // Re-throw as DuplicateKeyError if it's a UNIQUE violation
        const error = err as Record<string, unknown>;
        if (error.code === '23505' && error.constraint === 'provider_webhook_events_provider_provider_event_id_key') {
          throw new DuplicateKeyError('ProviderWebhookEvent', `${input.provider}:${input.provider_event_id}`);
        }
        throw err;
      }
    }, 'ProviderEventRepository.create');
  }

  /**
   * Update event processing status.
   *
   * @param id Provider event ID
   * @param status New status
   * @param error Error message (if failed)
   * @returns Updated event
   */
  async updateStatus(
    id: number,
    status: 'received' | 'processing' | 'processed' | 'failed',
    error?: string
  ): Promise<ProviderWebhookEvent> {
    return this.executeQuery(async () => {
      const processedAt = status === 'processed' ? new Date().toISOString() : null;

      const result = await this.sql<ProviderWebhookEvent[]>`
        UPDATE provider_webhook_events
        SET processing_status = ${status},
            processing_error = ${error || null},
            processed_at = ${processedAt}
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `provider event ${id}`);
      return result[0];
    }, 'ProviderEventRepository.updateStatus');
  }

  /**
   * Mark event processing as started.
   *
   * @param id Provider event ID
   * @returns Updated event
   */
  async markProcessing(id: number): Promise<ProviderWebhookEvent> {
    return this.updateStatus(id, 'processing');
  }

  /**
   * Mark event processing as completed.
   *
   * @param id Provider event ID
   * @returns Updated event
   */
  async markProcessed(id: number): Promise<ProviderWebhookEvent> {
    return this.updateStatus(id, 'processed');
  }

  /**
   * Mark event processing as failed.
   *
   * @param id Provider event ID
   * @param error Error message
   * @returns Updated event
   */
  async markFailed(id: number, error: string): Promise<ProviderWebhookEvent> {
    return this.updateStatus(id, 'failed', error);
  }

  /**
   * Update balance processing status.
   *
   * Used in Phase B3.2b to track balance update processing.
   *
   * @param id Provider event ID
   * @param processed Whether balance processing succeeded
   * @param error Error message (if failed)
   * @returns Updated event
   */
  async updateBalanceStatus(
    id: number,
    processed: boolean,
    error?: string
  ): Promise<ProviderWebhookEvent> {
    return this.executeQuery(async () => {
      const result = await this.sql<ProviderWebhookEvent[]>`
        UPDATE provider_webhook_events
        SET balance_processed_at = ${processed ? new Date().toISOString() : null},
            balance_processing_error = ${error || null}
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `provider event ${id}`);
      return result[0];
    }, 'ProviderEventRepository.updateBalanceStatus');
  }

  /**
   * Count provider events by status.
   *
   * @returns Map of status to count
   */
  async countByStatus(): Promise<{
    received: number;
    processing: number;
    processed: number;
    failed: number;
  }> {
    return this.executeQuery(async () => {
      const result = await this.sql<{ status: string; count: number }[]>`
        SELECT processing_status as status, COUNT(*) as count
        FROM provider_webhook_events
        GROUP BY processing_status
      `;

      const counts = {
        received: 0,
        processing: 0,
        processed: 0,
        failed: 0,
      };

      for (const row of result) {
        if (row.status in counts) {
          counts[row.status as keyof typeof counts] = row.count;
        }
      }

      return counts;
    }, 'ProviderEventRepository.countByStatus');
  }

  /**
   * Get unprocessed events (received or processing).
   *
   * Used for recovery operations.
   *
   * @param limit Maximum results
   * @returns Array of unprocessed events
   */
  async findUnprocessed(limit: number = 100): Promise<ProviderWebhookEvent[]> {
    return this.executeQuery(async () => {
      return this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE processing_status IN ('received', 'processing')
        ORDER BY created_at ASC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'ProviderEventRepository.findUnprocessed');
  }

  /**
   * Get events for a related provider reference.
   *
   * Used to find all events related to a specific transfer or item.
   *
   * @param reference Provider reference
   * @returns Array of events
   */
  async findByRelatedReference(reference: string): Promise<ProviderWebhookEvent[]> {
    return this.executeQuery(async () => {
      return this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE related_provider_reference = ${reference}
        ORDER BY created_at DESC
      `;
    }, 'ProviderEventRepository.findByRelatedReference');
  }

  /**
   * Get events by correlation ID.
   *
   * Useful for tracing a request through the system.
   *
   * @param correlationId Correlation ID
   * @returns Array of matching events
   */
  async findByCorrelationId(correlationId: string): Promise<ProviderWebhookEvent[]> {
    return this.executeQuery(async () => {
      return this.sql<ProviderWebhookEvent[]>`
        SELECT *
        FROM provider_webhook_events
        WHERE correlation_id = ${correlationId}
        ORDER BY created_at DESC
      `;
    }, 'ProviderEventRepository.findByCorrelationId');
  }

  /**
   * Check if an event has been processed.
   *
   * @param provider Provider name
   * @param providerEventId Provider event ID
   * @returns true if event has been processed
   */
  async isProcessed(provider: string, providerEventId: string): Promise<boolean> {
    return this.executeQuery(async () => {
      const event = await this.findByProviderEventId(provider, providerEventId);
      return event?.processing_status === 'processed';
    }, 'ProviderEventRepository.isProcessed');
  }
}

/**
 * Singleton instance of ProviderEventRepository.
 */
let providerEventRepositoryInstance: ProviderEventRepository | null = null;

export function getProviderEventRepository(): ProviderEventRepository {
  if (!providerEventRepositoryInstance) {
    providerEventRepositoryInstance = new ProviderEventRepository();
  }
  return providerEventRepositoryInstance;
}
