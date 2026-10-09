import {
  markProviderEventFailed,
  markProviderEventProcessed,
} from '@/lib/provider-events';
import { SettlementOrchestrator } from './SettlementOrchestrator';
import { applySettlementAtomically } from './apply-settlement';
import { mapPlaidTransferStatus } from './plaid-event-adapter';
import type { SettlementHandlingResult } from './handle-stripe-settlement';

/**
 * Drive one verified Plaid TRANSFER.STATUS_UPDATE through settlement.
 *
 * The route has already verified the signature and inserted the
 * provider_webhook_events row. This function decides the transition and
 * applies it. It marks the row processed only after the apply commits, and
 * it does not swallow a local failure: the caller answers 500 so Plaid
 * redelivers. Marking the row processed while the intent was unchanged was
 * the previous behaviour, and it made a retry impossible.
 *
 * Idempotency is the intent's status claim inside applySettlementAtomically,
 * not the webhook body hash. Two different deliveries that both say the same
 * transfer settled can only credit the wallet once.
 */
export async function handlePlaidTransferSettlement(input: {
  providerEventId: string;
  transferId: string | undefined;
  plaidStatus: string | undefined;
  correlationId?: string;
}): Promise<SettlementHandlingResult> {
  const providerEventId = input.providerEventId;

  if (!input.transferId) {
    await markProviderEventProcessed('plaid', providerEventId);
    return {
      outcome: 'recorded_only',
      markedProcessed: true,
      reason: 'missing_transfer_id',
    };
  }

  const eventType = mapPlaidTransferStatus(input.plaidStatus);
  if (!eventType) {
    // An unknown status is kept as evidence and not applied. Guessing would
    // move money on a value this code does not understand.
    await markProviderEventProcessed('plaid', providerEventId);
    return {
      outcome: 'recorded_only',
      markedProcessed: true,
      reason: 'unmapped_plaid_status',
    };
  }

  try {
    const plan = await new SettlementOrchestrator().orchestrateSettlement(
      {
        provider: 'plaid',
        provider_event_id: providerEventId,
        provider_reference_id: input.transferId,
        eventType,
        timestamp: new Date(),
        isRetry: false,
      },
      input.correlationId ?? '',
    );

    if (plan.error) {
      await markProviderEventFailed('plaid', providerEventId, plan.error);
      const noIntent = plan.error === 'INTENT_NOT_FOUND';
      return {
        outcome: noIntent ? 'no_matching_intent' : 'invalid_transition',
        markedProcessed: false,
        intentId: plan.intentId,
        reason: plan.error,
      };
    }

    const applied = await applySettlementAtomically(plan);
    await markProviderEventProcessed('plaid', providerEventId);

    if (!applied.applied) {
      return {
        outcome: 'no_change',
        markedProcessed: true,
        intentId: plan.intentId,
        transition: plan.transition,
        reason: applied.reason,
      };
    }

    return {
      outcome: 'applied',
      markedProcessed: true,
      intentId: plan.intentId,
      transition: plan.transition,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markProviderEventFailed('plaid', providerEventId, message);
    return {
      outcome: 'failed',
      markedProcessed: false,
      retryable: true,
      reason: message,
    };
  }
}
