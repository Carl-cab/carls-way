/**
 * Transfer intent repository for managing bank transfer operations.
 *
 * Responsibilities:
 * - Create transfer intents
 * - Query transfer intents by various criteria
 * - Update transfer status through state machine
 * - Track settlement state and provider references
 * - No business logic, no settlement orchestration
 */

import { BaseRepository } from './BaseRepository';
import type {
  TransferIntent,
  TransferStatus,
  CreateTransferIntentInput,
  PaginatedResult,
} from './types';

export class TransferIntentRepository extends BaseRepository {
  /**
   * Find a transfer intent by ID.
   *
   * @param id Transfer intent ID
   * @returns Transfer intent or null
   */
  async findById(id: number): Promise<TransferIntent | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE id = ${id}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'TransferIntentRepository.findById');
  }

  /**
   * Find a transfer intent by provider reference ID.
   *
   * Used to find intents by external provider identifiers.
   *
   * @param providerReferenceId Provider reference ID
   * @returns Transfer intent or null
   */
  async findByProviderReference(providerReferenceId: string): Promise<TransferIntent | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE provider_reference_id = ${providerReferenceId}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'TransferIntentRepository.findByProviderReference');
  }

  /**
   * Find transfer intents by idempotency key.
   *
   * Used to prevent duplicate transfer requests from the same user.
   *
   * @param userId User ID
   * @param idempotencyKey Idempotency key
   * @returns Array of matching intents (usually 0 or 1)
   */
  async findByIdempotencyKey(
    userId: number,
    idempotencyKey: string
  ): Promise<TransferIntent[]> {
    return this.executeQuery(async () => {
      return this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE user_id = ${userId}
          AND idempotency_key = ${idempotencyKey}
        ORDER BY created_at DESC
      `;
    }, 'TransferIntentRepository.findByIdempotencyKey');
  }

  /**
   * Get transfer intents for a user.
   *
   * @param userId User ID
   * @param limit Maximum results
   * @param offset Offset for pagination
   * @returns Array of transfer intents
   */
  async findByUser(
    userId: number,
    limit: number = 100,
    offset: number = 0
  ): Promise<TransferIntent[]> {
    return this.executeQuery(async () => {
      return this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
        OFFSET ${Math.max(0, offset)}
      `;
    }, 'TransferIntentRepository.findByUser');
  }

  /**
   * Get transfer intents paginated.
   *
   * @param userId User ID
   * @param page Page number (1-indexed)
   * @param limit Items per page
   * @returns Paginated intents
   */
  async findByUserPaginated(
    userId: number,
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResult<TransferIntent>> {
    return this.executeQuery(async () => {
      const { page: validPage, limit: validLimit } = this.validatePagination(page, limit);
      const offset = this.calculateOffset(validPage, validLimit);

      const [intents, countResult] = await Promise.all([
        this.sql<TransferIntent[]>`
          SELECT *
          FROM transfer_intents
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
          LIMIT ${validLimit}
          OFFSET ${offset}
        `,
        this.sql<{ count: number }[]>`
          SELECT COUNT(*) as count FROM transfer_intents
          WHERE user_id = ${userId}
        `,
      ]);

      const total = countResult[0]?.count || 0;

      return {
        data: intents,
        meta: {
          page: validPage,
          limit: validLimit,
          total,
          hasMore: offset + validLimit < total,
        },
      };
    }, 'TransferIntentRepository.findByUserPaginated');
  }

  /**
   * Get transfer intents by status.
   *
   * @param status Transfer status
   * @param limit Maximum results
   * @returns Array of intents
   */
  async findByStatus(
    status: TransferStatus,
    limit: number = 100
  ): Promise<TransferIntent[]> {
    return this.executeQuery(async () => {
      return this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE status = ${status}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'TransferIntentRepository.findByStatus');
  }

  /**
   * Get transfer intents for a bank account.
   *
   * @param bankAccountId Bank account ID
   * @param limit Maximum results
   * @returns Array of intents
   */
  async findByBankAccount(
    bankAccountId: number,
    limit: number = 100
  ): Promise<TransferIntent[]> {
    return this.executeQuery(async () => {
      return this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE bank_account_id = ${bankAccountId}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'TransferIntentRepository.findByBankAccount');
  }

  /**
   * Create a new transfer intent.
   *
   * @param input Transfer intent creation data
   * @returns Created transfer intent
   */
  async create(input: CreateTransferIntentInput): Promise<TransferIntent> {
    return this.executeQuery(async () => {
      const result = await this.sql<TransferIntent[]>`
        INSERT INTO transfer_intents (
          user_id, bank_account_id, type, amount, currency, status,
          provider_region, provider_name, execution_mode,
          idempotency_key, correlation_id, created_at, updated_at
        )
        VALUES (
          ${input.user_id},
          ${input.bank_account_id},
          ${input.type},
          ${input.amount},
          ${input.currency},
          'draft',
          ${input.provider_region},
          ${input.provider_name},
          ${input.execution_mode},
          ${input.idempotency_key || null},
          ${input.correlation_id || null},
          NOW(),
          NOW()
        )
        RETURNING *
      `;

      this.assertFound(result[0], 'created transfer intent');
      return result[0];
    }, 'TransferIntentRepository.create');
  }

  /**
   * Update transfer intent status.
   *
   * @param id Transfer intent ID
   * @param status New status
   * @returns Updated transfer intent
   */
  async updateStatus(id: number, status: TransferStatus): Promise<TransferIntent> {
    return this.executeQuery(async () => {
      const result = await this.sql<TransferIntent[]>`
        UPDATE transfer_intents
        SET status = ${status},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `transfer intent ${id}`);
      return result[0];
    }, 'TransferIntentRepository.updateStatus');
  }

  /**
   * Update transfer intent with provider information.
   *
   * @param id Transfer intent ID
   * @param providerReferenceId Provider reference ID
   * @returns Updated transfer intent
   */
  async updateProviderReference(
    id: number,
    providerReferenceId: string
  ): Promise<TransferIntent> {
    return this.executeQuery(async () => {
      const result = await this.sql<TransferIntent[]>`
        UPDATE transfer_intents
        SET provider_reference_id = ${providerReferenceId},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `transfer intent ${id}`);
      return result[0];
    }, 'TransferIntentRepository.updateProviderReference');
  }

  /**
   * Update transfer intent consent state.
   *
   * @param id Transfer intent ID
   * @returns Updated transfer intent
   */
  async confirmConsent(id: number): Promise<TransferIntent> {
    return this.executeQuery(async () => {
      const result = await this.sql<TransferIntent[]>`
        UPDATE transfer_intents
        SET consent_confirmed_at = NOW(),
            status = 'ready',
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `transfer intent ${id}`);
      return result[0];
    }, 'TransferIntentRepository.confirmConsent');
  }

  /**
   * Mark transfer intent as failed with error reason.
   *
   * @param id Transfer intent ID
   * @param reason Failure reason
   * @returns Updated transfer intent
   */
  async markFailed(id: number, reason: string): Promise<TransferIntent> {
    return this.executeQuery(async () => {
      const result = await this.sql<TransferIntent[]>`
        UPDATE transfer_intents
        SET status = 'failed',
            failure_reason = ${reason},
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `transfer intent ${id}`);
      return result[0];
    }, 'TransferIntentRepository.markFailed');
  }

  /**
   * Count transfer intents by status.
   *
   * @returns Map of status to count
   */
  async countByStatus(): Promise<Record<TransferStatus, number>> {
    return this.executeQuery(async () => {
      const result = await this.sql<{ status: string; count: number }[]>`
        SELECT status, COUNT(*) as count
        FROM transfer_intents
        GROUP BY status
      `;

      const counts: Record<string, number> = {};
      for (const row of result) {
        counts[row.status] = row.count;
      }

      return counts as Record<TransferStatus, number>;
    }, 'TransferIntentRepository.countByStatus');
  }

  /**
   * Count transfer intents by user.
   *
   * @param userId User ID
   * @returns Total count for user
   */
  async countByUser(userId: number): Promise<number> {
    return this.count('transfer_intents', `user_id = ${userId}`);
  }

  /**
   * Get transfer intents in processing state.
   *
   * Used for monitoring and recovery operations.
   *
   * @param limit Maximum results
   * @returns Array of processing intents
   */
  async findProcessing(limit: number = 100): Promise<TransferIntent[]> {
    return this.executeQuery(async () => {
      return this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE status = 'processing'
        ORDER BY created_at ASC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'TransferIntentRepository.findProcessing');
  }

  /**
   * Get transfer intents that need manual review.
   *
   * Used for compliance and operations dashboards.
   *
   * @param limit Maximum results
   * @returns Array of intents needing review
   */
  async findNeedingReview(limit: number = 100): Promise<TransferIntent[]> {
    return this.executeQuery(async () => {
      return this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE status IN ('failed', 'returned', 'blocked')
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'TransferIntentRepository.findNeedingReview');
  }

  /**
   * Get transfer intents by correlation ID.
   *
   * Useful for tracing a request through the system.
   *
   * @param correlationId Correlation ID
   * @returns Array of matching intents
   */
  async findByCorrelationId(correlationId: string): Promise<TransferIntent[]> {
    return this.executeQuery(async () => {
      return this.sql<TransferIntent[]>`
        SELECT *
        FROM transfer_intents
        WHERE correlation_id = ${correlationId}
        ORDER BY created_at DESC
      `;
    }, 'TransferIntentRepository.findByCorrelationId');
  }
}

/**
 * Singleton instance of TransferIntentRepository.
 */
let transferIntentRepositoryInstance: TransferIntentRepository | null = null;

export function getTransferIntentRepository(): TransferIntentRepository {
  if (!transferIntentRepositoryInstance) {
    transferIntentRepositoryInstance = new TransferIntentRepository();
  }
  return transferIntentRepositoryInstance;
}
