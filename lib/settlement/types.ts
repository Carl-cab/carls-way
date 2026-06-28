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

export type SettlementStatus =
  | 'draft'
  | 'reviewed'
  | 'confirmed'
  | 'submitted'
  | 'authorized'
  | 'pending'
  | 'posted'
  | 'settled'
  | 'failed'
  | 'returned'
  | 'cancelled';

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
