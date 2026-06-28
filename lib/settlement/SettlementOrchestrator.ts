// Settlement Orchestrator: Plans settlement outcomes without executing them.
// Phase B2: Converts SettlementProcessor results into executable SettlementOutcome.
// Queries transfer_intents, validates state transitions, prepares side effect instructions.

import { getSql } from '@/lib/db';
import SettlementProcessor from './SettlementProcessor';
import type {
  NormalizedEvent,
  SettlementStatus,
} from './types';

export interface SettlementPlan {
  intentId: string;
  previousStatus: SettlementStatus;
  nextStatus: SettlementStatus;
  transition: string;
  // Provider context for idempotency
  provider: string;
  provider_event_id: string;
  provider_reference_id: string;
  updateBalance: {
    shouldUpdate: boolean;
    currency?: string;
    amount?: number;
    operation?: 'add' | 'subtract';
  };
  createLedgerEntries: {
    shouldCreate: boolean;
    entries?: Array<{
      currency: string;
      debit: number;
      credit: number;
      entryType: string;
      description: string;
    }>;
  };
  notifyUser: boolean;
  reverseVelocity: boolean;
  requiresManualReview: boolean;
  idempotent: boolean;
  reason: string;
  error?: string;
}

export class SettlementOrchestrator {
  /**
   * Orchestrate settlement for a provider event.
   * Query transfer_intents, validate transition, prepare side effects.
   * Phase B2: Plan only, do not execute.
   */
  async orchestrateSettlement(event: NormalizedEvent): Promise<SettlementPlan> {
    const sql = getSql();

    try {
      // 1. Query transfer_intents by provider_reference_id
      const rows = await sql`
        SELECT id, user_id, type, amount, currency, status,
               provider_reference_id, bank_account_id
        FROM transfer_intents
        WHERE provider_reference_id = ${event.provider_reference_id}
        LIMIT 1
      `;

      if (!rows[0]) {
        // No intent found for this provider reference
        return {
          intentId: event.provider_reference_id,
          previousStatus: 'draft' as SettlementStatus,
          nextStatus: 'draft' as SettlementStatus,
          transition: 'draft→draft (not found)',
          provider: event.provider,
          provider_event_id: event.provider_event_id,
          provider_reference_id: event.provider_reference_id,
          updateBalance: { shouldUpdate: false },
          createLedgerEntries: { shouldCreate: false },
          notifyUser: false,
          reverseVelocity: false,
          requiresManualReview: true,
          idempotent: false,
          reason: `No transfer intent found for provider reference: ${event.provider_reference_id}`,
          error: 'INTENT_NOT_FOUND',
        };
      }

      const intent = rows[0] as {
        id: string;
        user_id: number;
        type: string;
        amount: number;
        currency: string;
        status: SettlementStatus;
        provider_reference_id: string;
        bank_account_id: string;
      };

      // 2. Call SettlementProcessor to validate and plan transition
      const processor = new SettlementProcessor();
      const outcome = await processor.processSettlementEvent(
        intent.id,
        intent.status,
        event,
        false // isIdempotent
      );

      // 3. Enrich outcome with side effect instructions
      const plan = this.enrichOutcomeWithSideEffects(
        intent,
        outcome.nextStatus,
        event,
        intent.provider_reference_id
      );

      return plan;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      return {
        intentId: event.provider_reference_id,
        previousStatus: 'draft' as SettlementStatus,
        nextStatus: 'draft' as SettlementStatus,
        transition: 'draft→draft (error)',
        provider: event.provider,
        provider_event_id: event.provider_event_id,
        provider_reference_id: event.provider_reference_id,
        updateBalance: { shouldUpdate: false },
        createLedgerEntries: { shouldCreate: false },
        notifyUser: false,
        reverseVelocity: false,
        requiresManualReview: true,
        idempotent: false,
        reason: `Settlement orchestration error: ${errorMsg}`,
        error: 'ORCHESTRATION_ERROR',
      };
    }
  }

  /**
   * Enrich settlement outcome with side effect instructions.
   * Determines what WOULD happen, but does not execute.
   * Phase B2: Planning only.
   */
  private enrichOutcomeWithSideEffects(
    intent: {
      id: string;
      user_id: number;
      type: string;
      amount: number;
      currency: string;
      status: SettlementStatus;
    },
    nextStatus: SettlementStatus,
    event: NormalizedEvent,
    providerReferenceId: string
  ): SettlementPlan {
    // Determine balance update instructions based on transition
    const updateBalance = this.planBalanceUpdate(intent, nextStatus);

    // Determine ledger entry instructions based on transition
    const createLedgerEntries = this.planLedgerEntries(intent, nextStatus);

    // Determine notification strategy
    const notifyUser = this.shouldNotify(nextStatus);

    // Determine velocity reversal (only for returned transfers)
    const reverseVelocity = nextStatus === 'returned';

    // Determine if manual review required
    const requiresManualReview = nextStatus === 'failed' || nextStatus === 'returned';

    return {
      intentId: intent.id,
      previousStatus: intent.status,
      nextStatus,
      transition: `${intent.status}→${nextStatus}`,
      provider: event.provider,
      provider_event_id: event.provider_event_id,
      provider_reference_id: providerReferenceId,
      updateBalance,
      createLedgerEntries,
      notifyUser,
      reverseVelocity,
      requiresManualReview,
      idempotent: false,
      reason: `Settlement plan: ${intent.status} → ${nextStatus}`,
    };
  }

  /**
   * Plan balance update for this transition.
   * Phase B2: Describe what would be updated, do not update.
   */
  private planBalanceUpdate(
    intent: {
      type: string;
      amount: number;
      currency: string;
    },
    nextStatus: SettlementStatus
  ): SettlementPlan['updateBalance'] {
    // Only settled transfers update balances (in Phase B3)
    if (nextStatus !== 'settled') {
      return { shouldUpdate: false };
    }

    // Determine operation based on transfer type
    const operation =
      intent.type === 'add_money'
        ? ('add' as const)
        : ('subtract' as const);

    return {
      shouldUpdate: true,
      currency: intent.currency,
      amount: intent.amount,
      operation,
    };
  }

  /**
   * Plan ledger entries for this transition.
   * Phase B2: Describe what would be created, do not create.
   */
  private planLedgerEntries(
    intent: {
      id: string;
      type: string;
      amount: number;
      currency: string;
    },
    nextStatus: SettlementStatus
  ): SettlementPlan['createLedgerEntries'] {
    if (nextStatus === 'settled') {
      return {
        shouldCreate: true,
        entries: [
          {
            currency: intent.currency,
            debit: intent.type === 'add_money' ? intent.amount : 0,
            credit: intent.type === 'cash_out' ? intent.amount : 0,
            entryType: 'transfer_settlement',
            description: `${intent.type === 'add_money' ? 'Add Money' : 'Cash Out'} settled - Intent ${intent.id}`,
          },
        ],
      };
    }

    if (nextStatus === 'returned') {
      return {
        shouldCreate: true,
        entries: [
          {
            currency: intent.currency,
            debit: intent.type === 'cash_out' ? intent.amount : 0,
            credit: intent.type === 'add_money' ? intent.amount : 0,
            entryType: 'transfer_reversal',
            description: `${intent.type === 'add_money' ? 'Add Money' : 'Cash Out'} returned - Intent ${intent.id}`,
          },
        ],
      };
    }

    return { shouldCreate: false };
  }

  /**
   * Determine if user should be notified.
   * Phase B2: Decision only, do not notify.
   */
  private shouldNotify(nextStatus: SettlementStatus): boolean {
    const notifiableStates: SettlementStatus[] = ['settled', 'failed', 'returned'];
    return notifiableStates.includes(nextStatus);
  }
}

export default SettlementOrchestrator;
