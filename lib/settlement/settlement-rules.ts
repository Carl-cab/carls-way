// Settlement state transition rules and validation.
// Phase A4: Skeleton (structure only, no business logic yet).

import type { SettlementTransitionRule, SettlementStatus, SettlementEventType } from './types';

export const SETTLEMENT_TRANSITIONS: SettlementTransitionRule[] = [
  {
    from: 'draft',
    to: 'reviewed',
    eventTypes: [],
    allowedActors: 'user',
    description: 'User reviewed the transfer',
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
  return ['submitted', 'authorized', 'pending', 'posted'].includes(status);
}
