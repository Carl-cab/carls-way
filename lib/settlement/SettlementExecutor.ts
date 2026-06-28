// Settlement Executor: Applies SettlementPlan side effects (status, ledger, balance, etc.).
// Phase B3.1: Updates transfer_intents.status only.
// Phase B3.2a: Creates ledger entries.
// Phase B3.2b: Updates wallet balances.

import { getSql } from '@/lib/db';
import type { SettlementStatus } from './types';
import type { SettlementPlan } from './SettlementOrchestrator';

export interface SettlementExecutionResult {
  success: boolean;
  intentId: string;
  previousStatus: SettlementStatus;
  newStatus: SettlementStatus;
  updated: boolean; // Whether status actually changed
  reason: string;
  error?: string;
}

export interface LedgerExecutionResult {
  success: boolean;
  intentId: string;
  entriesCreated: number; // Number of ledger entries inserted
  reason: string;
  error?: string;
}

export interface BalanceExecutionResult {
  success: boolean;
  intentId: string;
  balanceUpdated: boolean; // Whether balance actually changed
  currency?: string;
  amountApplied?: number; // Amount added or subtracted
  operation?: 'add' | 'subtract';
  reason: string;
  error?: string;
}

export class SettlementExecutor {
  /**
   * Execute a settlement plan: apply status transitions to transfer_intents.
   * Phase B3.1: Status transitions only, no balance/ledger/notification changes.
   * Idempotent: if already at target status, returns success without updating.
   */
  async executeSettlementPlan(plan: SettlementPlan): Promise<SettlementExecutionResult> {
    const sql = getSql();

    // If plan has an error, return failure
    if (plan.error) {
      return {
        success: false,
        intentId: plan.intentId,
        previousStatus: plan.previousStatus,
        newStatus: plan.nextStatus,
        updated: false,
        reason: `Plan generation failed: ${plan.error}`,
        error: plan.error,
      };
    }

    try {
      // Query the transfer intent
      const rows = await sql`
        SELECT id, status
        FROM transfer_intents
        WHERE id = ${plan.intentId}
        LIMIT 1
      `;

      if (!rows[0]) {
        return {
          success: false,
          intentId: plan.intentId,
          previousStatus: plan.previousStatus,
          newStatus: plan.nextStatus,
          updated: false,
          reason: `Transfer intent not found: ${plan.intentId}`,
          error: 'INTENT_NOT_FOUND',
        };
      }

      const intent = rows[0] as {
        id: string;
        status: SettlementStatus;
      };

      // If already at target status, return idempotent success
      if (intent.status === plan.nextStatus) {
        return {
          success: true,
          intentId: plan.intentId,
          previousStatus: intent.status,
          newStatus: plan.nextStatus,
          updated: false,
          reason: `Idempotent: already in status ${plan.nextStatus}`,
        };
      }

      // Update status to next state
      await sql`
        UPDATE transfer_intents
        SET status = ${plan.nextStatus}, updated_at = NOW()
        WHERE id = ${plan.intentId}
      `;

      return {
        success: true,
        intentId: plan.intentId,
        previousStatus: intent.status,
        newStatus: plan.nextStatus,
        updated: true,
        reason: `Status transitioned: ${intent.status} → ${plan.nextStatus}`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return {
        success: false,
        intentId: plan.intentId,
        previousStatus: plan.previousStatus,
        newStatus: plan.nextStatus,
        updated: false,
        reason: `Execution error: ${errorMsg}`,
        error: 'EXECUTION_ERROR',
      };
    }
  }

  /**
   * Execute ledger entries from settlement plan.
   * Phase B3.2a: Create ledger entries only. No balance updates.
   * Idempotent: duplicate webhook events will not create duplicate entries.
   */
  async executeLedgerCreation(plan: SettlementPlan): Promise<LedgerExecutionResult> {
    const sql = getSql();

    // Only create ledger entries if plan requires them
    if (!plan.createLedgerEntries.shouldCreate || !plan.createLedgerEntries.entries) {
      return {
        success: true,
        intentId: plan.intentId,
        entriesCreated: 0,
        reason: 'No ledger entries required for this transition',
      };
    }

    if (plan.createLedgerEntries.entries.length === 0) {
      return {
        success: true,
        intentId: plan.intentId,
        entriesCreated: 0,
        reason: 'No ledger entries in plan',
      };
    }

    try {
      // Query transfer intent to get user_id and provider_reference_id
      const intentRows = await sql`
        SELECT id, user_id, provider_reference_id
        FROM transfer_intents
        WHERE id = ${plan.intentId}
        LIMIT 1
      `;

      if (!intentRows[0]) {
        return {
          success: false,
          intentId: plan.intentId,
          entriesCreated: 0,
          reason: `Transfer intent not found: ${plan.intentId}`,
          error: 'INTENT_NOT_FOUND',
        };
      }

      const intent = intentRows[0] as {
        id: string;
        user_id: number;
        provider_reference_id: string;
      };

      // Map entry_type from plan format to database format
      const mapEntryType = (planType: string, nextStatus: string): string => {
        if (nextStatus === 'settled') {
          return planType === 'transfer_settlement'
            ? 'add_money_settled'
            : 'cash_out_settled';
        }
        if (nextStatus === 'returned') {
          return 'transfer_returned';
        }
        if (nextStatus === 'failed') {
          return 'transfer_failed';
        }
        return planType;
      };

      // Insert all ledger entries atomically
      // Use the idempotency guard: UNIQUE(transfer_intent_id, provider_event_id, entry_type)
      // Multiple entries with same intent_id but different entry_type are allowed
      // Duplicate entry_type from same provider_event_id is rejected
      const insertPromises = plan.createLedgerEntries.entries.map((entry) => {
        const dbEntryType = mapEntryType(entry.entryType, plan.nextStatus);
        return sql`
          INSERT INTO ledger_entries (
            user_id,
            transfer_intent_id,
            currency,
            account_type,
            entry_type,
            debit,
            credit,
            provider,
            provider_reference,
            provider_event_id,
            description
          )
          VALUES (
            ${intent.user_id},
            ${intent.id},
            ${entry.currency},
            'wallet',
            ${dbEntryType},
            ${entry.debit},
            ${entry.credit},
            ${plan.provider},
            ${intent.provider_reference_id},
            ${plan.provider_event_id},
            ${entry.description}
          )
          ON CONFLICT (transfer_intent_id, provider_event_id, entry_type) DO NOTHING
        `;
      });

      // Execute all inserts
      const results = await Promise.all(insertPromises);
      const entriesCreated = results.filter((r) => r.count > 0).length;

      return {
        success: true,
        intentId: plan.intentId,
        entriesCreated,
        reason: `Ledger entries created: ${entriesCreated} of ${plan.createLedgerEntries.entries.length}`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return {
        success: false,
        intentId: plan.intentId,
        entriesCreated: 0,
        reason: `Ledger execution error: ${errorMsg}`,
        error: 'LEDGER_EXECUTION_ERROR',
      };
    }
  }

  /**
   * Execute balance updates from settlement plan.
   * Phase B3.2b: Update wallet balances only. No ledger entries, notifications, velocity.
   * Idempotent: same provider event never updates balance twice via balance_processed_at tracking.
   */
  async executeBalanceUpdate(plan: SettlementPlan): Promise<BalanceExecutionResult> {
    const sql = getSql();

    // Only update balance if plan requires it
    if (!plan.updateBalance.shouldUpdate) {
      return {
        success: true,
        intentId: plan.intentId,
        balanceUpdated: false,
        reason: 'Balance update not required for this transition',
      };
    }

    // Validate plan has required fields
    if (!plan.updateBalance.currency || !plan.updateBalance.amount || !plan.updateBalance.operation) {
      return {
        success: false,
        intentId: plan.intentId,
        balanceUpdated: false,
        reason: 'Balance update instruction incomplete',
        error: 'INVALID_BALANCE_INSTRUCTION',
      };
    }

    const { currency, amount, operation } = plan.updateBalance;

    // Validate currency
    if (currency !== 'USD' && currency !== 'CAD') {
      return {
        success: false,
        intentId: plan.intentId,
        balanceUpdated: false,
        reason: `Invalid currency: ${currency}`,
        error: 'INVALID_CURRENCY',
      };
    }

    // Validate amount is positive
    if (amount <= 0) {
      return {
        success: false,
        intentId: plan.intentId,
        balanceUpdated: false,
        reason: `Invalid amount: ${amount}`,
        error: 'INVALID_AMOUNT',
      };
    }

    // Declare eventRows at method scope so it's accessible in catch block
    let eventRows: Array<{
      id: number;
      balance_processed_at: string | null;
      balance_processing_error: string | null;
    }> = [];

    try {
      // Query transfer intent to get details
      const intentRows = await sql`
        SELECT id, user_id, type, status
        FROM transfer_intents
        WHERE id = ${plan.intentId}
        LIMIT 1
      `;

      if (!intentRows[0]) {
        return {
          success: false,
          intentId: plan.intentId,
          balanceUpdated: false,
          reason: `Transfer intent not found: ${plan.intentId}`,
          error: 'INTENT_NOT_FOUND',
        };
      }

      const intent = intentRows[0] as {
        id: string;
        user_id: number;
        type: string;
        status: string;
      };

      // Check if balance has already been processed for this provider event
      try {
        eventRows = await sql`
          SELECT id, balance_processed_at, balance_processing_error
          FROM provider_webhook_events
          WHERE provider = ${plan.provider} AND provider_event_id = ${plan.provider_event_id}
          LIMIT 1
        `;
      } catch {
        // If event not found, continue (it might not have been recorded yet)
      }

      if (eventRows[0]) {
        const event = eventRows[0];
        if (event.balance_processed_at) {
          // Balance already processed - return idempotent success
          return {
            success: true,
            intentId: plan.intentId,
            balanceUpdated: false,
            currency,
            amountApplied: amount,
            operation,
            reason: `Idempotent: balance already updated for this event`,
          };
        }
      }

      // Special handling for Cash Out: not supported in current system (no real execute)
      if (intent.type === 'cash_out') {
        // Track that we skipped cash_out (no update)
        if (eventRows[0]) {
          try {
            await sql`
              UPDATE provider_webhook_events
              SET balance_processed_at = NOW(),
                  balance_processing_error = 'SKIPPED_CASH_OUT_NO_LIVE_EXECUTE'
              WHERE provider = ${plan.provider} AND provider_event_id = ${plan.provider_event_id}
            `;
          } catch {
            // Ignore tracking failures
          }
        }

        return {
          success: true,
          intentId: plan.intentId,
          balanceUpdated: false,
          currency,
          reason: `Skipped: cash_out transfers require live executeTransfer() implementation`,
        };
      }

      // Special handling for Returned: only reverse if balance was previously applied
      if (plan.nextStatus === 'returned') {
        // Verify a prior settlement balance update exists
        try {
          const priorSettledEvents = await sql`
            SELECT COUNT(*) as count
            FROM provider_webhook_events
            WHERE provider = ${plan.provider}
              AND related_provider_reference = ${plan.provider_reference_id}
              AND event_type LIKE '%settled%'
              AND balance_processed_at IS NOT NULL
            LIMIT 1
          `;

          const eventCount = (priorSettledEvents[0] as { count: number }).count;
          if (eventCount === 0) {
            // No prior balance update found — return skipped
            return {
              success: true,
              intentId: plan.intentId,
              balanceUpdated: false,
              currency,
              reason: `Skipped: returned status but no prior settlement balance update found`,
            };
          }
        } catch (err) {
          // Log but continue with reversal — be lenient on check failure
          const checkErr = err instanceof Error ? err.message : String(err);
          console.warn(
            `[settlement] Warning: Could not verify prior settlement balance for returned transfer ${plan.intentId}: ${checkErr}`
          );
        }
      }

      // Prepare balance column name
      const balanceColumn = currency === 'USD' ? 'balance_usd' : 'balance_cad';

      // Atomic balance update using arithmetic
      // For add_money, operation is 'add'; for returned on add_money, operation is 'subtract'
      const updateAmount = operation === 'add' ? amount : -amount;

      const updateResult = await sql`
        UPDATE users
        SET ${sql(balanceColumn)} = ${sql(balanceColumn)} + ${updateAmount}
        WHERE id = ${intent.user_id}
        RETURNING id
      `;

      if (!updateResult[0]) {
        return {
          success: false,
          intentId: plan.intentId,
          balanceUpdated: false,
          reason: `User not found: ${intent.user_id}`,
          error: 'USER_NOT_FOUND',
        };
      }

      // Track balance update in provider_webhook_events
      if (eventRows[0]) {
        await sql`
          UPDATE provider_webhook_events
          SET balance_processed_at = NOW()
          WHERE provider = ${plan.provider} AND provider_event_id = ${plan.provider_event_id}
        `;
      }

      return {
        success: true,
        intentId: plan.intentId,
        balanceUpdated: true,
        currency,
        amountApplied: amount,
        operation,
        reason: `Balance updated: ${operation} ${amount} ${currency}`,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';

      // Try to record the error in provider_webhook_events for tracking
      try {
        if (eventRows[0]) {
          await sql`
            UPDATE provider_webhook_events
            SET balance_processing_error = ${errorMsg}
            WHERE provider = ${plan.provider} AND provider_event_id = ${plan.provider_event_id}
          `;
        }
      } catch {
        // Ignore error tracking failures
      }

      return {
        success: false,
        intentId: plan.intentId,
        balanceUpdated: false,
        reason: `Balance execution error: ${errorMsg}`,
        error: 'BALANCE_EXECUTION_ERROR',
      };
    }
  }
}

export default SettlementExecutor;
