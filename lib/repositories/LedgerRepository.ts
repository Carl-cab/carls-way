/**
 * Ledger repository for managing double-entry accounting records.
 *
 * Responsibilities:
 * - Create ledger entries (individual entries and pairs)
 * - Query ledger history
 * - Calculate account balances
 * - Ensure ledger integrity (append-only)
 * - No business logic, no balance mutations
 *
 * The ledger is the source of truth for all currency movements in the system.
 * Balances are calculated from ledger entries, never stored directly.
 */

import { BaseRepository } from './BaseRepository';
import type {
  LedgerEntry,
  LedgerBalance,
  CreateLedgerEntryInput,
  CreateLedgerPairInput,
  PaginatedResult,
} from './types';

export class LedgerRepository extends BaseRepository {
  /**
   * Create a single ledger entry.
   *
   * @param input Ledger entry data
   * @returns Created ledger entry
   */
  async createEntry(input: CreateLedgerEntryInput): Promise<LedgerEntry> {
    return this.executeQuery(async () => {
      const result = await this.sql<LedgerEntry[]>`
        INSERT INTO ledger_entries (
          user_id, transaction_id, transfer_intent_id, currency, account_type,
          entry_type, debit, credit, provider, provider_reference,
          provider_event_id, description, correlation_id, created_at
        )
        VALUES (
          ${input.user_id},
          ${input.transaction_id || null},
          ${input.transfer_intent_id || null},
          ${input.currency},
          ${input.account_type},
          ${input.entry_type},
          ${input.debit},
          ${input.credit},
          ${input.provider || null},
          ${input.provider_reference || null},
          ${input.provider_event_id || null},
          ${input.description || null},
          ${input.correlation_id || null},
          NOW()
        )
        RETURNING *
      `;

      this.assertFound(result[0], 'created ledger entry');
      return result[0];
    }, 'LedgerRepository.createEntry');
  }

  /**
   * Create a pair of ledger entries (double-entry accounting).
   *
   * Creates two entries atomically: one for sender (debit) and one for receiver (credit).
   * Uses a CTE to ensure both entries are created in a single atomic transaction.
   *
   * @param input Ledger pair data
   * @returns Object with both entries: { debit: LedgerEntry, credit: LedgerEntry }
   */
  async createPair(
    input: CreateLedgerPairInput
  ): Promise<{ debit: LedgerEntry; credit: LedgerEntry }> {
    return this.executeQuery(async () => {
      const result = await this.sql<
        { debit_id: number; credit_id: number }[]
      >`
        WITH sender_entry AS (
          INSERT INTO ledger_entries (
            user_id, transaction_id, currency, account_type,
            entry_type, debit, credit, description, correlation_id, created_at
          )
          VALUES (
            ${input.sender_user_id},
            ${input.transaction_id},
            ${input.currency},
            'wallet',
            'payment_sent',
            ${input.amount},
            0,
            'Payment sent',
            ${input.correlation_id || null},
            NOW()
          )
          RETURNING id
        ),
        receiver_entry AS (
          INSERT INTO ledger_entries (
            user_id, transaction_id, currency, account_type,
            entry_type, debit, credit, description, correlation_id, created_at
          )
          VALUES (
            ${input.receiver_user_id},
            ${input.transaction_id},
            ${input.currency},
            'wallet',
            'payment_received',
            0,
            ${input.amount},
            'Payment received',
            ${input.correlation_id || null},
            NOW()
          )
          RETURNING id
        )
        SELECT
          (SELECT id FROM sender_entry) as debit_id,
          (SELECT id FROM receiver_entry) as credit_id
      `;

      const ids = result[0];
      this.assertFound(ids, 'ledger pair');

      // Fetch the created entries
      const senderEntry = await this.findById(ids.debit_id);
      const receiverEntry = await this.findById(ids.credit_id);

      this.assertFound(senderEntry, `sender entry ${ids.debit_id}`);
      this.assertFound(receiverEntry, `receiver entry ${ids.credit_id}`);

      return {
        debit: senderEntry,
        credit: receiverEntry,
      };
    }, 'LedgerRepository.createPair');
  }

  /**
   * Find a ledger entry by ID.
   *
   * @param id Ledger entry ID
   * @returns Ledger entry or null
   */
  async findById(id: number): Promise<LedgerEntry | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<LedgerEntry[]>`
        SELECT *
        FROM ledger_entries
        WHERE id = ${id}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'LedgerRepository.findById');
  }

  /**
   * Get ledger entries for a user.
   *
   * @param userId User ID
   * @param limit Maximum results
   * @param offset Offset for pagination
   * @returns Array of ledger entries
   */
  async findByUser(
    userId: number,
    limit: number = 100,
    offset: number = 0
  ): Promise<LedgerEntry[]> {
    return this.executeQuery(async () => {
      return this.sql<LedgerEntry[]>`
        SELECT *
        FROM ledger_entries
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
        OFFSET ${Math.max(0, offset)}
      `;
    }, 'LedgerRepository.findByUser');
  }

  /**
   * Get ledger entries paginated.
   *
   * @param userId User ID
   * @param page Page number (1-indexed)
   * @param limit Items per page
   * @returns Paginated entries
   */
  async findByUserPaginated(
    userId: number,
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResult<LedgerEntry>> {
    return this.executeQuery(async () => {
      const { page: validPage, limit: validLimit } = this.validatePagination(page, limit);
      const offset = this.calculateOffset(validPage, validLimit);

      const [entries, countResult] = await Promise.all([
        this.sql<LedgerEntry[]>`
          SELECT *
          FROM ledger_entries
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
          LIMIT ${validLimit}
          OFFSET ${offset}
        `,
        this.sql<{ count: number }[]>`
          SELECT COUNT(*) as count FROM ledger_entries
          WHERE user_id = ${userId}
        `,
      ]);

      const total = countResult[0]?.count || 0;

      return {
        data: entries,
        meta: {
          page: validPage,
          limit: validLimit,
          total,
          hasMore: offset + validLimit < total,
        },
      };
    }, 'LedgerRepository.findByUserPaginated');
  }

  /**
   * Get ledger entries for a transaction.
   *
   * @param transactionId Transaction ID
   * @returns Array of ledger entries (usually 2: sender and receiver)
   */
  async findByTransaction(transactionId: number): Promise<LedgerEntry[]> {
    return this.executeQuery(async () => {
      return this.sql<LedgerEntry[]>`
        SELECT *
        FROM ledger_entries
        WHERE transaction_id = ${transactionId}
        ORDER BY created_at ASC
      `;
    }, 'LedgerRepository.findByTransaction');
  }

  /**
   * Get ledger entries for a transfer intent.
   *
   * @param transferIntentId Transfer intent ID
   * @returns Array of ledger entries
   */
  async findByTransferIntent(transferIntentId: number): Promise<LedgerEntry[]> {
    return this.executeQuery(async () => {
      return this.sql<LedgerEntry[]>`
        SELECT *
        FROM ledger_entries
        WHERE transfer_intent_id = ${transferIntentId}
        ORDER BY created_at ASC
      `;
    }, 'LedgerRepository.findByTransferIntent');
  }

  /**
   * Get ledger entries by provider event.
   *
   * Used to find entries created from specific webhook events.
   *
   * @param provider Provider name
   * @param providerEventId Provider event ID
   * @returns Array of ledger entries
   */
  async findByProviderEvent(provider: string, providerEventId: string): Promise<LedgerEntry[]> {
    return this.executeQuery(async () => {
      return this.sql<LedgerEntry[]>`
        SELECT *
        FROM ledger_entries
        WHERE provider = ${provider}
          AND provider_event_id = ${providerEventId}
        ORDER BY created_at ASC
      `;
    }, 'LedgerRepository.findByProviderEvent');
  }

  /**
   * Calculate balance for a user and currency.
   *
   * Balance = SUM(credit) - SUM(debit)
   * This is the source of truth for account balance, calculated from ledger.
   *
   * @param userId User ID
   * @param currency Currency code
   * @returns Balance calculation with totals
   */
  async getBalance(userId: number, currency: 'CAD' | 'USD'): Promise<LedgerBalance> {
    return this.executeQuery(async () => {
      const result = await this.sql<
        {
          total_debits: string;
          total_credits: string;
        }[]
      >`
        SELECT
          COALESCE(SUM(debit), 0)::NUMERIC as total_debits,
          COALESCE(SUM(credit), 0)::NUMERIC as total_credits
        FROM ledger_entries
        WHERE user_id = ${userId}
          AND currency = ${currency}
          AND account_type = 'wallet'
      `;

      const row = result[0];
      this.assertFound(row, `balance for user ${userId}/${currency}`);

      const totalDebits = parseFloat(row.total_debits);
      const totalCredits = parseFloat(row.total_credits);
      const balance = totalCredits - totalDebits;

      return {
        user_id: userId,
        currency,
        total_debits: totalDebits,
        total_credits: totalCredits,
        balance,
      };
    }, 'LedgerRepository.getBalance');
  }

  /**
   * Get balances for both currencies for a user.
   *
   * @param userId User ID
   * @returns Map of currency to balance
   */
  async getBalances(userId: number): Promise<{ CAD: number; USD: number }> {
    const [cadBalance, usdBalance] = await Promise.all([
      this.getBalance(userId, 'CAD'),
      this.getBalance(userId, 'USD'),
    ]);

    return {
      CAD: cadBalance.balance,
      USD: usdBalance.balance,
    };
  }

  /**
   * Count ledger entries for a user.
   *
   * @param userId User ID
   * @returns Total count
   */
  async countByUser(userId: number): Promise<number> {
    return this.count('ledger_entries', `user_id = ${userId}`);
  }

  /**
   * Get ledger entries by entry type.
   *
   * @param entryType Entry type filter
   * @param limit Maximum results
   * @returns Array of entries
   */
  async findByEntryType(
    entryType: string,
    limit: number = 100
  ): Promise<LedgerEntry[]> {
    return this.executeQuery(async () => {
      return this.sql<LedgerEntry[]>`
        SELECT *
        FROM ledger_entries
        WHERE entry_type = ${entryType}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'LedgerRepository.findByEntryType');
  }

  /**
   * Get total volume (sum of all credits) for a currency.
   *
   * Useful for financial reporting and analytics.
   *
   * @param currency Currency code
   * @returns Total volume
   */
  async getTotalVolume(currency: 'CAD' | 'USD'): Promise<number> {
    return this.executeQuery(async () => {
      const result = await this.sql<{ total: string }[]>`
        SELECT COALESCE(SUM(credit), 0)::NUMERIC as total
        FROM ledger_entries
        WHERE currency = ${currency}
          AND entry_type IN ('payment_received', 'settlement')
      `;

      return parseFloat(result[0]?.total || '0');
    }, 'LedgerRepository.getTotalVolume');
  }

  /**
   * Get entries within a date range.
   *
   * @param userId User ID
   * @param startDate Start date (inclusive)
   * @param endDate End date (inclusive)
   * @param limit Maximum results
   * @returns Array of entries
   */
  async findByDateRange(
    userId: number,
    startDate: string,
    endDate: string,
    limit: number = 100
  ): Promise<LedgerEntry[]> {
    return this.executeQuery(async () => {
      return this.sql<LedgerEntry[]>`
        SELECT *
        FROM ledger_entries
        WHERE user_id = ${userId}
          AND created_at >= ${startDate}
          AND created_at <= ${endDate}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'LedgerRepository.findByDateRange');
  }
}

/**
 * Singleton instance of LedgerRepository.
 */
let ledgerRepositoryInstance: LedgerRepository | null = null;

export function getLedgerRepository(): LedgerRepository {
  if (!ledgerRepositoryInstance) {
    ledgerRepositoryInstance = new LedgerRepository();
  }
  return ledgerRepositoryInstance;
}
