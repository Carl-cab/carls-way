import {
  recordProviderEvent,
  markProviderEventProcessed,
  markProviderEventFailed,
  getProviderEvent,
} from '@/lib/provider-events';
import { SettlementOrchestrator } from './SettlementOrchestrator';
import { applySettlementAtomically } from './apply-settlement';
import { adaptStripeEvent, isSettlementEvent, type StripeEventLike } from './stripe-event-adapter';

/**
 * Drive a verified Stripe event through the settlement pipeline.
 *
 * The webhook previously recorded financial events and marked them processed in
 * the same breath, without ever calling the orchestrator or executor. Events
 * were therefore durably stored and permanently ignored: a successful ACSS
 * debit never moved its transfer intent, never wrote a ledger entry, and never
 * credited a wallet, while the row said `processed`.
 *
 * ## Ordering
 *
 * The sequence is deliberate and is the whole point of this module:
 *
 *   1. record the event as `received`
 *   2. orchestrate — read the intent, decide the transition and side effects
 *   3. execute — apply status, ledger entries, and balance, each idempotent
 *   4. only then mark the event `processed`
 *
 * Marking processed last is what makes a crash safe. If the process dies at any
 * point before step 4, the row stays `received`, Stripe retries on its own
 * schedule, and the work is attempted again. Marking first — the previous
 * behaviour — converts every mid-flight failure into permanent, silent loss of
 * a financial event.
 *
 * ## Duplicates and reordering
 *
 * Stripe delivers at least once and does not guarantee order. Both are handled
 * by layers below rather than here:
 *
 *   - duplicates: `provider_webhook_events` is unique on
 *     (provider, provider_event_id), so a repeat delivery is detected at step 1
 *     and passed to the orchestrator with `isRetry`, and the executor's writes
 *     are individually idempotent (ledger rows carry
 *     UNIQUE(transfer_intent_id, provider_event_id, entry_type)).
 *   - reordering: the orchestrator validates the transition against the
 *     intent's current status, so a late `pending` arriving after `settled` is
 *     rejected as an invalid transition rather than dragging the intent
 *     backwards.
 *
 * ## What this does not do
 *
 * It does not enable live money movement. The provider that would create these
 * Stripe objects stays behind `CA_EFT_LIVE`, which is off. This is the receiving
 * half: it makes the pipeline correct so the rail can be switched on later,
 * under test-mode validation, rather than switching on a rail whose settlement
 * path has never run.
 */

export type SettlementHandlingOutcome =
  // The plan ran. Named `applied` rather than `settled` because a settlement
  // event can legitimately leave the intent's status unchanged — a repeat
  // `pending`, for instance — and reusing the status name for the handler's
  // result made those two meanings impossible to tell apart.
  | 'applied'
  // The event was valid and recorded, but moved nothing: the outcome had
  // already been claimed by an earlier event, or the plan's next state equals
  // the current one. Distinct provider event ids describing a single outcome
  // land here rather than settling it twice.
  | 'no_change'
  | 'recorded_only'
  | 'duplicate_ignored'
  | 'no_matching_intent'
  | 'invalid_transition'
  | 'failed';

export interface SettlementHandlingResult {
  outcome: SettlementHandlingOutcome;
  /** True when the event row ended in `processed`. */
  markedProcessed: boolean;
  /**
   * True when the failure was local and transient, so the caller should answer
   * 500 and let the provider redeliver. A terminal provider result — a rejected
   * transfer, an event for an unknown intent — is not retryable: redelivering
   * produces the same answer, so it is recorded and acknowledged.
   */
  retryable?: boolean;
  intentId?: string;
  transition?: string;
  reason?: string;
}

export async function handleStripeSettlementEvent(
  event: StripeEventLike,
  correlationId = '',
): Promise<SettlementHandlingResult> {
  const providerEventId = event.id;
  const adapted = adaptStripeEvent(event);
  const referenceId = adapted.normalized?.provider_reference_id;

  // Step 1. Record before doing anything else, so the event survives a crash
  // even if nothing downstream succeeds. `false` means we have seen it before.
  const isFirstDelivery = await recordProviderEvent('stripe', providerEventId, event.type, {
    relatedProviderReference: referenceId,
    rawPayload: event as unknown as Record<string, unknown>,
  });

  // An event we do not settle is still worth keeping — it is evidence during an
  // investigation — but there is nothing to apply, so it is complete on arrival.
  if (!adapted.normalized) {
    await markProviderEventProcessed('stripe', providerEventId);
    return {
      outcome: 'recorded_only',
      markedProcessed: true,
      reason: adapted.skipped ?? 'not_a_settlement_event',
    };
  }

  // A repeat delivery that already completed needs no further work. Re-running
  // would be harmless — every write below is idempotent — but returning early
  // keeps the common retry cheap and makes the intent legible in the logs.
  if (!isFirstDelivery) {
    const existing = await getProviderEvent('stripe', providerEventId);
    if (existing?.processing_status === 'processed') {
      return {
        outcome: 'duplicate_ignored',
        markedProcessed: true,
        reason: 'Event already processed on an earlier delivery',
      };
    }
  }

  const normalized = { ...adapted.normalized, isRetry: !isFirstDelivery };

  try {
    // Step 2. Plan. Pure: reads the intent and decides, writes nothing.
    const plan = await new SettlementOrchestrator().orchestrateSettlement(
      normalized,
      correlationId,
    );

    if (plan.error) {
      // No intent matched this reference, or the transition is not permitted.
      // Both are terminal for this event rather than retryable: redelivering
      // will produce the same answer. Recorded as failed so it surfaces in the
      // console instead of looking processed.
      await markProviderEventFailed('stripe', providerEventId, plan.error);
      // The orchestrator reports a machine-readable code here, not prose.
      const noIntent = plan.error === 'INTENT_NOT_FOUND';
      return {
        outcome: noIntent ? 'no_matching_intent' : 'invalid_transition',
        markedProcessed: false,
        intentId: plan.intentId,
        reason: plan.error,
      };
    }

    // Step 3. Apply, once per business outcome. Idempotency is keyed on the
    // intent's status transition rather than on provider_event_id: two distinct
    // Stripe event ids can describe the same PaymentIntent reaching the same
    // outcome, and every event-keyed guard lets the second one through. Status,
    // ledger and balance move in one transaction.
    const applied = await applySettlementAtomically(plan);

    // Step 4. Only now is the event complete.
    await markProviderEventProcessed('stripe', providerEventId);

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
    // A local execution failure — a database timeout, a transaction conflict,
    // a lost connection — is not a terminal provider result. The row is left
    // un-processed and `retryable` is set so the route answers 500 and Stripe
    // redelivers. Recording the failure and answering 200, as this did before,
    // meant Stripe never retried and there is no worker that drains failed
    // rows, so the event was lost.
    await markProviderEventFailed('stripe', providerEventId, message);
    return { outcome: 'failed', markedProcessed: false, retryable: true, reason: message };
  }
}

export { isSettlementEvent };
