import type { NormalizedEvent, SettlementEventType } from './types';

/**
 * Translate Stripe webhook events into the settlement pipeline's vocabulary.
 *
 * The pipeline is provider-neutral: it reasons about `settled` and `failed`
 * against a `provider_reference_id`, not about payment intents and payouts.
 * This adapter is the only place that knows Stripe's event names, so adding a
 * second Canadian rail later means writing another adapter rather than
 * threading provider conditionals through the orchestrator.
 *
 * ## What maps, and what deliberately does not
 *
 * Two Stripe object types matter, because CanadianEFTProvider creates exactly
 * two things and stores either one's id as `transfer_intents.provider_reference_id`:
 *
 *   payment_intent   add_money  — an ACSS debit pulling from the customer's bank
 *   payout           cash_out   — currently a platform payout, NOT enabled
 *
 * `charge.*` events are intentionally not mapped. A charge is a child of a
 * payment intent, so a successful ACSS debit produces both `charge.succeeded`
 * and `payment_intent.succeeded`. Mapping both would hand the pipeline two
 * settlement events for one movement of money, and the charge's id is not what
 * is stored as the reference, so the second one would fail to resolve an intent
 * and look like an orphan rather than a duplicate. One object, one event.
 *
 * `payment_intent.processing` maps to `pending` rather than being dropped: ACSS
 * debits sit in that state for business days, and an intent that never leaves
 * `submitting` locally is indistinguishable from a lost submission during
 * reconciliation.
 */

/** Stripe event types this adapter understands. */
const STRIPE_SETTLEMENT_EVENTS: Record<string, SettlementEventType> = {
  // Add money: ACSS debit from the customer's bank into the platform.
  'payment_intent.processing': 'pending',
  'payment_intent.succeeded': 'settled',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'cancelled',

  // Cash out is deliberately absent.
  //
  // `payout.*` is NOT mapped, and must stay unmapped until a recipient-owned
  // Canadian disbursement rail exists. stripe.payouts.create moves money to the
  // platform's own external account, not the customer's, so settling a
  // `payout.paid` would mark a customer cash-out complete on the strength of a
  // transfer that never reached them — and, since the settled plan carries a
  // balance effect, would debit their wallet for it.
  //
  // These events are still recorded as operational evidence by the webhook's
  // record-only list; they simply produce no settlement.
};

export interface StripeEventLike {
  id: string;
  type: string;
  created?: number;
  data: { object: unknown };
}

export interface AdapterResult {
  /** Null when the event is not a settlement event this pipeline acts on. */
  normalized: NormalizedEvent | null;
  /** Why an event was not normalized. Present only when normalized is null. */
  skipped?: 'unmapped_event_type' | 'missing_object_id';
}

/**
 * Whether an event type is one this adapter settles.
 *
 * Exported so the webhook can tell "financial event we act on" from "financial
 * event we merely record", without duplicating the mapping table.
 */
export function isSettlementEvent(eventType: string): boolean {
  return eventType in STRIPE_SETTLEMENT_EVENTS;
}

/**
 * Normalize a verified Stripe event.
 *
 * Returns `normalized: null` rather than throwing for events outside the map:
 * an unmapped type is an ordinary occurrence, not an error, and the caller
 * still records it so nothing is lost.
 *
 * `isRetry` is not decided here. Whether this delivery is a repeat is a
 * property of what the database has already seen, not of the payload, so the
 * caller sets it from the provider_webhook_events row.
 */
export function adaptStripeEvent(event: StripeEventLike): AdapterResult {
  const eventType = STRIPE_SETTLEMENT_EVENTS[event.type];
  if (!eventType) {
    return { normalized: null, skipped: 'unmapped_event_type' };
  }

  const object = event.data?.object as Record<string, unknown> | null | undefined;
  const referenceId = typeof object?.id === 'string' ? object.id : null;

  // Without the object id there is nothing to match a transfer intent against.
  // Better to record the event and surface it than to guess at a reference.
  if (!referenceId) {
    return { normalized: null, skipped: 'missing_object_id' };
  }

  return {
    normalized: {
      provider: 'stripe',
      provider_event_id: event.id,
      provider_reference_id: referenceId,
      eventType,
      // Stripe sends `created` in seconds. Falling back to now would silently
      // fabricate ordering information, so an absent value uses the epoch,
      // which is visibly wrong rather than plausibly wrong.
      timestamp: new Date((event.created ?? 0) * 1000),
      isRetry: false,
    },
  };
}

/** The event types this adapter maps, for tests and documentation. */
export function mappedStripeEventTypes(): string[] {
  return Object.keys(STRIPE_SETTLEMENT_EVENTS);
}
