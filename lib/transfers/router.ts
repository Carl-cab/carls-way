// DEPRECATED: Provider router compatibility layer.
// All new code should import from lib/providers/ directly.
// This file maintained for backward compatibility only.

export {
  getTransferProvider,
  regionFromCountry,
  resolveExecutionMode,
  toExecutionMode,
  type UserRegion,
  type ExecutionMode,
} from '@/lib/providers/TransferProviderFactory';
export type { TransferProvider } from './types';
