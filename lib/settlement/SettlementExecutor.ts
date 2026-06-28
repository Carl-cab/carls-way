// Settlement Executor: Applies SettlementPlan status transitions.
// Phase B3.1: Updates transfer_intents.status only. No balance/ledger/notification side effects.

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
}

export default SettlementExecutor;
