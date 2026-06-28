// Settlement Executor: Applies SettlementPlan side effects (status, ledger, etc.).
// Phase B3.1: Updates transfer_intents.status only.
// Phase B3.2a: Creates ledger entries.

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
}

export default SettlementExecutor;
