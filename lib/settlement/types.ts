// Settlement event types and processor interfaces for transfer webhooks.
// Phase A4: Settlement Processor Skeleton (non-blocking, no balance mutations).

export type SettlementEventType =
  | 'submitted'
  | 'authorized'
  | 'pending'
  | 'posted'
  | 'settled'
  | 'failed'
  | 'returned'
  | 'cancelled';

/**
 * Statuses a transfer intent can hold.
 *
 * Two vocabularies had drifted apart here. The skeleton state machine was
 * written around `confirmed → submitted → authorized → pending → posted`, while
 * `transfer_intents` in the running application only ever takes
 * `draft → reviewed → ready → submitting → processing → settled|failed|returned`.
 * They overlapped at the ends and nowhere in the middle, so an intent sitting in
 * `processing` — where every live transfer sits after the provider accepts it —
 * had no transition into `settled` at all. Wiring a webhook to the pipeline
 * would have rejected every real settlement event as an invalid transition.
 *
 * Both sets are kept. The `ready`/`submitting`/`processing` path is what the
 * providers actually write and is what settlement now runs on; the older names
 * remain valid so nothing that already referenced them breaks.
 */
export type SettlementStatus =
  // The lifecycle the application actually uses.
  | 'draft'
  | 'reviewed'
  | 'ready'
  | 'submitting'
  | 'processing'
  | 'settled'
  | 'failed'
  | 'returned'
  | 'cancelled'
  // Retained from the original skeleton; no provider writes these today.
  | 'confirmed'
  | 'submitted'
  | 'authorized'
  | 'pending'
  | 'posted';

export interface ProviderEvent {
  provider: string; // 'plaid' | 'stripe' | 'vopay' etc.
  eventType: SettlementEventType;
  provider_event_id: string;
  provider_reference_id: string; // Link to transfer_intents.provider_reference_id
  timestamp: Date;
  raw_payload: Record<string, unknown>;
}

export interface SettlementOutcome {
  intentId: string;
  previousStatus: SettlementStatus;
  nextStatus: SettlementStatus;
  transition: string; // e.g. "draft→reviewed"
  wasIdempotent: boolean; // true if we've seen this event before
  shouldUpdateBalance: false; // Always false in skeleton phase
  shouldCreateLedgerEntry: false; // Always false in skeleton phase
  shouldNotifyUser: boolean;
  requiresManualReview: boolean;
  reason: string;
  error?: string;
}

export interface SettlementTransitionRule {
  from: SettlementStatus;
  to: SettlementStatus;
  eventTypes: SettlementEventType[];
  allowedActors: 'system' | 'webhook' | 'user' | 'admin';
  description: string;
}

export interface NormalizedEvent {
  provider: string;
  provider_event_id: string;
  provider_reference_id: string;
  eventType: SettlementEventType;
  timestamp: Date;
  isRetry: boolean;
}
