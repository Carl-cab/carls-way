// Settlement processor module exports.
// Phase A4: Settlement Processor Skeleton (structure only, no side effects).

export { default as SettlementProcessor } from './SettlementProcessor';
export {
  isValidTransition,
  getTransitionRule,
  isTerminalStatus,
  isProcessingStatus,
  SETTLEMENT_TRANSITIONS,
} from './settlement-rules';
export type {
  SettlementEventType,
  SettlementStatus,
  ProviderEvent,
  SettlementOutcome,
  NormalizedEvent,
  SettlementTransitionRule,
} from './types';
