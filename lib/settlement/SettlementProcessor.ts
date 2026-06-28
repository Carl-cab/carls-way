// Settlement processor: validates transitions and prepares side effects.
// Phase A4: Skeleton (no balance updates, no ledger entries, no provider calls).

import type {
  ProviderEvent,
  SettlementOutcome,
  NormalizedEvent,
  SettlementStatus,
  SettlementEventType,
} from './types';
import { isValidTransition, getTransitionRule, isTerminalStatus } from './settlement-rules';

export class SettlementProcessor {
  /**
   * Normalize provider-specific event to canonical form.
   * Phase A4: Skeleton — just maps fields, no business logic.
   */
  normalizeProviderEvent(raw: ProviderEvent): NormalizedEvent {
    return {
      provider: raw.provider,
      provider_event_id: raw.provider_event_id,
      provider_reference_id: raw.provider_reference_id,
      eventType: raw.eventType,
      timestamp: raw.timestamp,
      isRetry: false, // Would be set by webhook deduplication
    };
  }

  /**
   * Validate state transition without side effects.
   * Returns structured result, does not throw.
   */
  validateSettlementTransition(
    intentId: string,
    currentStatus: SettlementStatus,
    nextStatus: SettlementStatus,
    eventType?: SettlementEventType,
  ): { valid: boolean; reason: string } {
    if (currentStatus === nextStatus) {
      return { valid: true, reason: 'No-op: same status' };
    }

    if (!isValidTransition(currentStatus, nextStatus, eventType)) {
      return {
        valid: false,
        reason: `Invalid transition: ${currentStatus} → ${nextStatus}`,
      };
    }

    return { valid: true, reason: 'Transition allowed' };
  }

  /**
   * Process settlement event: validate, check idempotency, prepare outcome.
   * Phase A4: Skeleton — no balance updates or ledger entries.
   */
  async processSettlementEvent(
    intentId: string,
    currentStatus: SettlementStatus,
    event: NormalizedEvent,
    isIdempotent: boolean,
  ): Promise<SettlementOutcome> {
    // Map event type to target status
    const nextStatus = this.mapEventToStatus(event.eventType);

    // Validate transition
    const validation = this.validateSettlementTransition(
      intentId,
      currentStatus,
      nextStatus,
      event.eventType,
    );

    if (!validation.valid) {
      return {
        intentId,
        previousStatus: currentStatus,
        nextStatus: currentStatus, // No change
        transition: `${currentStatus}→${currentStatus}`,
        wasIdempotent: false,
        shouldUpdateBalance: false,
        shouldCreateLedgerEntry: false,
        shouldNotifyUser: false,
        requiresManualReview: true,
        reason: validation.reason,
        error: validation.reason,
      };
    }

    // Handle idempotency: if we've seen this before, return same outcome
    if (isIdempotent && isTerminalStatus(nextStatus)) {
      return {
        intentId,
        previousStatus: currentStatus,
        nextStatus: currentStatus, // Already in terminal state
        transition: `${currentStatus} (idempotent)`,
        wasIdempotent: true,
        shouldUpdateBalance: false,
        shouldCreateLedgerEntry: false,
        shouldNotifyUser: false,
        requiresManualReview: false,
        reason: `Idempotent retry: event ${event.provider_event_id} already processed`,
      };
    }

    // Skeleton: prepare outcome without applying side effects
    const outcome = this.prepareSettlementOutcome(
      intentId,
      currentStatus,
      nextStatus,
      event.eventType,
    );

    return outcome;
  }

  /**
   * Determine next status from event type.
   * Maps provider events to settlement states.
   */
  private mapEventToStatus(eventType: string): SettlementStatus {
    const mapping: Record<string, SettlementStatus> = {
      submitted: 'submitted',
      authorized: 'authorized',
      pending: 'pending',
      posted: 'posted',
      settled: 'settled',
      failed: 'failed',
      returned: 'returned',
      cancelled: 'cancelled',
    };
    return (mapping[eventType] || 'settled') as SettlementStatus;
  }

  /**
   * Prepare settlement outcome (what WOULD happen, not actually done).
   * Phase A4: shouldUpdateBalance and shouldCreateLedgerEntry always false.
   */
  private prepareSettlementOutcome(
    intentId: string,
    previousStatus: SettlementStatus,
    nextStatus: SettlementStatus,
    eventType: string,
  ): SettlementOutcome {
    const rule = getTransitionRule(previousStatus, nextStatus);

    // Determine side effect flags
    const shouldNotifyUser = nextStatus === 'settled' || nextStatus === 'failed';
    const requiresManualReview =
      eventType === 'failed' || nextStatus === 'returned' || eventType === 'returned';

    return {
      intentId,
      previousStatus,
      nextStatus,
      transition: `${previousStatus}→${nextStatus}`,
      wasIdempotent: false,
      shouldUpdateBalance: false, // CRITICAL: Phase A4 skeleton
      shouldCreateLedgerEntry: false, // CRITICAL: Phase A4 skeleton
      shouldNotifyUser,
      requiresManualReview,
      reason: rule?.description || `Transition to ${nextStatus}`,
    };
  }

  /**
   * Check if event should trigger user notification.
   * Phase A4: Skeleton (structure only).
   */
  shouldNotifyUser(
    nextStatus: SettlementStatus,
    previousStatus: SettlementStatus,
  ): boolean {
    const notifiableStates: SettlementStatus[] = ['settled', 'failed', 'returned'];
    return notifiableStates.includes(nextStatus) && previousStatus !== nextStatus;
  }

  /**
   * Check if transfer requires manual review.
   * Phase A4: Skeleton (structure only).
   */
  requiresManualReview(nextStatus: SettlementStatus): boolean {
    const reviewStates: SettlementStatus[] = ['failed', 'returned'];
    return reviewStates.includes(nextStatus);
  }
}

export default SettlementProcessor;
