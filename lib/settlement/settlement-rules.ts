// Settlement state transition rules and validation.
// Phase A4: Skeleton (structure only, no business logic yet).

import type { SettlementTransitionRule, SettlementStatus, SettlementEventType } from './types';

export const SETTLEMENT_TRANSITIONS: SettlementTransitionRule[] = [
  // ── The lifecycle transfer_intents actually takes ──────────────────────────
  //
  // ready → submitting → processing → settled | failed, with returned after
  // settlement. These are the statuses the providers write
  // (lib/providers/CanadianEFTProvider.ts, PlaidTransferProvider.ts); the
  // skeleton rules further down never covered them, so an intent in
  // `processing` had no route to `settled` and every webhook settlement event
  // was rejected as an invalid transition.
  {
    from: 'ready',
    to: 'submitting',
    eventTypes: ['submitted'],
    allowedActors: 'system',
    description: 'System claimed the intent and is calling the provider',
  },
  {
    from: 'submitting',
    to: 'processing',
    eventTypes: ['submitted', 'pending'],
    allowedActors: 'system',
    description: 'Provider accepted the transfer and returned a reference',
  },
  {
    from: 'processing',
    to: 'processing',
    eventTypes: ['pending'],
    allowedActors: 'webhook',
    description: 'Provider reported continued progress; no state change',
  },
  {
    from: 'processing',
    to: 'settled',
    eventTypes: ['settled', 'posted'],
    allowedActors: 'webhook',
    description: 'Provider confirmed the funds moved',
  },
  {
    from: 'processing',
    to: 'failed',
    eventTypes: ['failed'],
    allowedActors: 'webhook',
    description: 'Provider rejected or could not complete the transfer',
  },
  {
    from: 'processing',
    to: 'cancelled',
    eventTypes: ['cancelled'],
    allowedActors: 'webhook',
    description: 'Transfer was cancelled before completion',
  },
  {
    // A provider can report failure before the local write recording the
    // reference lands. Without this the intent would be stranded in
    // `submitting` with no route out.
    from: 'submitting',
    to: 'failed',
    eventTypes: ['failed'],
    allowedActors: 'webhook',
    description: 'Provider rejected the transfer during submission',
  },

  // ── Original skeleton rules, retained ─────────────────────────────────────
  {
    from: 'draft',
    to: 'reviewed',
    eventTypes: [],
    allowedActors: 'user',
    description: 'User reviewed the transfer',
  },
  {
    from: 'reviewed',
    to: 'ready',
    eventTypes: [],
    allowedActors: 'user',
    description: 'User confirmed consent; intent is ready to execute',
  },
  {
    from: 'reviewed',
    to: 'confirmed',
    eventTypes: [],
    allowedActors: 'user',
    description: 'User confirmed consent',
  },
  {
    from: 'confirmed',
    to: 'submitted',
    eventTypes: ['submitted'],
    allowedActors: 'system',
    description: 'System submitted to provider',
  },
  {
    from: 'submitted',
    to: 'authorized',
    eventTypes: ['authorized'],
    allowedActors: 'webhook',
    description: 'Provider authorized the transfer',
  },
  {
    from: 'authorized',
    to: 'pending',
    eventTypes: ['pending'],
    allowedActors: 'webhook',
    description: 'Transfer is pending settlement',
  },
  {
    from: 'pending',
    to: 'posted',
    eventTypes: ['posted'],
    allowedActors: 'webhook',
    description: 'Transfer posted to account',
  },
  {
    from: 'posted',
    to: 'settled',
    eventTypes: ['settled'],
    allowedActors: 'webhook',
    description: 'Transfer settled',
  },
  {
    from: 'posted',
    to: 'failed',
    eventTypes: ['failed'],
    allowedActors: 'webhook',
    description: 'Transfer failed during settlement',
  },
  {
    from: 'settled',
    to: 'returned',
    eventTypes: ['returned'],
    allowedActors: 'webhook',
    description: 'Transfer was returned after settlement',
  },
  {
    from: 'confirmed',
    to: 'cancelled',
    eventTypes: ['cancelled'],
    allowedActors: 'user',
    description: 'User cancelled before execution',
  },
];

export function isValidTransition(
  from: SettlementStatus,
  to: SettlementStatus,
  eventType?: SettlementEventType,
): boolean {
  const rule = SETTLEMENT_TRANSITIONS.find(r => r.from === from && r.to === to);
  if (!rule) return false;
  if (eventType && rule.eventTypes.length > 0 && !rule.eventTypes.includes(eventType)) {
    return false;
  }
  return true;
}

export function getTransitionRule(
  from: SettlementStatus,
  to: SettlementStatus,
): SettlementTransitionRule | undefined {
  return SETTLEMENT_TRANSITIONS.find(r => r.from === from && r.to === to);
}

export function isTerminalStatus(status: SettlementStatus): boolean {
  return ['settled', 'failed', 'returned', 'cancelled'].includes(status);
}

export function isProcessingStatus(status: SettlementStatus): boolean {
  // Includes the statuses the application actually writes. It previously listed
  // only the skeleton's labels, so an intent sitting in `submitting` or
  // `processing` — where every live transfer sits — reported false, which is the
  // opposite of the truth for the only statuses that occur in practice.
  return [
    'ready',
    'submitting',
    'processing',
    'submitted',
    'authorized',
    'pending',
    'posted',
  ].includes(status);
}
