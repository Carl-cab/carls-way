// TransferProviderFactory — central provider selection logic.
// Routes all provider selection through a single factory.
// No provider selection logic should exist anywhere else in the application.
//
// Factory Rules:
// - US + sandbox → SandboxUSProvider
// - CA + sandbox → SandboxCAProvider
// - US + live → PlaidTransferProvider (when enabled via env var)
// - CA + live → CanadianEFTProvider (when enabled via env var)

import { SandboxUSProvider } from './SandboxUSProvider';
import { SandboxCAProvider } from './SandboxCAProvider';
import { PlaidTransferProvider } from './PlaidTransferProvider';
import { CanadianEFTProvider } from './CanadianEFTProvider';
import type { TransferProvider } from './TransferProvider';

export type UserRegion = 'US' | 'CA';
export type ExecutionMode = 'sandbox' | 'live';

export function getTransferProvider(region: UserRegion, mode: ExecutionMode = 'sandbox'): TransferProvider {
  // US region
  if (region === 'US') {
    if (mode === 'live') {
      // Check if live Plaid is enabled
      if (process.env.PLAID_TRANSFER_LIVE === 'true') {
        return new PlaidTransferProvider();
      }
      // Fall back to sandbox if live is not enabled
      return new SandboxUSProvider();
    }
    return new SandboxUSProvider();
  }

  // CA region
  if (mode === 'live') {
    // Check if live Canadian EFT is enabled
    if (process.env.CA_EFT_LIVE === 'true') {
      return new CanadianEFTProvider();
    }
    // Fall back to sandbox if live is not enabled
    return new SandboxCAProvider();
  }
  return new SandboxCAProvider();
}

// Convert country code to provider region
export function regionFromCountry(country: string): UserRegion {
  return country === 'US' ? 'US' : 'CA';
}

/**
 * Resolve the execution mode for a region from environment flags.
 * Returns 'live' ONLY when that region's live flag is explicitly 'true'
 * (US: PLAID_TRANSFER_LIVE, CA: CA_EFT_LIVE). Defaults to 'sandbox' otherwise,
 * so nothing goes live until the flag is deliberately set alongside live
 * credentials. This is the single source of truth for go-live gating.
 */
export function resolveExecutionMode(region: UserRegion): ExecutionMode {
  if (region === 'US' && process.env.PLAID_TRANSFER_LIVE === 'true') return 'live';
  if (region === 'CA' && process.env.CA_EFT_LIVE === 'true') return 'live';
  return 'sandbox';
}

/** Narrow an untrusted string (e.g. a DB column) to a valid ExecutionMode. */
export function toExecutionMode(value: string | null | undefined): ExecutionMode {
  return value === 'live' ? 'live' : 'sandbox';
}

// Convenience method for routes that only need sandbox
export function getSandboxProvider(region: UserRegion): TransferProvider {
  return getTransferProvider(region, 'sandbox');
}

// Convenience method that uses country directly
export function getProviderByCountry(country: string, mode: ExecutionMode = 'sandbox'): TransferProvider {
  return getTransferProvider(regionFromCountry(country), mode);
}
