// DEPRECATED: Provider router compatibility layer.
// All new code should import from lib/providers/ directly.
// This file maintained for backward compatibility only.

import { getTransferProvider, regionFromCountry, type UserRegion } from '@/lib/providers/TransferProviderFactory';
import type { TransferProvider } from './types';

// Re-export for backward compatibility
export type { UserRegion };
export { getTransferProvider, regionFromCountry };
