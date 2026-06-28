// Settlement module exports.
// Phase A4: Settlement Processor Skeleton (structure only, no side effects).
// Phase B2: Settlement Orchestrator (plans outcomes without executing).

export { default as SettlementProcessor } from './SettlementProcessor';
export { default as SettlementOrchestrator } from './SettlementOrchestrator';
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
export type { SettlementPlan } from './SettlementOrchestrator';
