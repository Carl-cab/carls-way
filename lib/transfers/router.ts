// Provider router — selects the correct TransferProvider based on user region.
// US users → SandboxUSProvider (future: PlaidTransferProvider)
// CA users → SandboxCAProvider (future: CanadianEFTProvider)
//
// To add a live provider: import it here and swap the return value
// behind an environment-gated condition. Never change the interface.

import { SandboxUSProvider } from './sandbox-us';
import { SandboxCAProvider } from './sandbox-ca';
import type { TransferProvider } from './types';

export type UserRegion = 'US' | 'CA';

export function getTransferProvider(userRegion: UserRegion): TransferProvider {
  if (userRegion === 'US') {
    return new SandboxUSProvider();
  }
  return new SandboxCAProvider();
}

export function regionFromCountry(country: string): UserRegion {
  return country === 'US' ? 'US' : 'CA';
}
