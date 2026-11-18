/**
 * Restricted internal beta — server-enforced capability restrictions.
 *
 * WHY THIS EXISTS. The owner approved a P2P-only internal sandbox beta
 * (2026-11-18) and required three capabilities to be disabled, server-side,
 * for it. Each is disabled for its own specific reason, and they are not
 * interchangeable:
 *
 *   funding (`add_money`)
 *     Sandbox funding has NO capacity control. Decision 0013 is the control
 *     and it is unimplemented and blocked on independent validation.
 *     Measured 2026-11-18: one verified user funded CA$1,850 across five
 *     confirmations against 0013's approved CA$100 cumulative ceiling, with
 *     the P2P velocity counter untouched throughout.
 *
 *   cash_out
 *     Design-blocked in CLAUDE.md: the recipient-owned destination,
 *     disbursement accounting, ownership validation and return/reversal
 *     architecture are design-only. It is nonetheless fully reachable today —
 *     measured, a sandbox cash_out of CA$500 settled and debited a balance.
 *     Decision 0013 requires it disabled and it is not.
 *
 *   cross_currency
 *     A cross-border payment debits CAD and credits USD, so within each
 *     currency the ledger entry is unmatched. It is EXCLUDED from every
 *     per-payment reconciliation invariant (it carries
 *     `payment_rail='wire'`), so it is money movement no control examines.
 *     The FX clearing-account treatment it would need is documented and
 *     deliberately not built.
 *
 * HOW THE PROFILE RESOLVES, and why sandbox defaults to restricted.
 *
 *   1. `MANNA_BETA_PROFILE=p2p_only`     -> restricted, anywhere.
 *   2. `MANNA_BETA_PROFILE=unrestricted` -> unrestricted, anywhere. An
 *      explicit, auditable opt-out: the only way to re-enable these in a
 *      sandbox is to say so.
 *   3. Otherwise, SANDBOX defaults to RESTRICTED.
 *   4. Otherwise (production, or an unrecognised value outside sandbox)
 *      this module restricts nothing.
 *
 * Rule 3 is the important one. A beta deployment is a sandbox deployment, so
 * the restriction is the default there rather than something an operator has
 * to remember to switch on — forgetting the variable leaves the beta
 * restricted, not open. That is the opposite posture from an opt-in flag, and
 * it is chosen deliberately because all three capabilities are ones this
 * repository already says must not be used.
 *
 * Rule 4 is scoped on purpose. This module is a BETA control, not a
 * production one: production's protection against live money movement is the
 * `PLAID_TRANSFER_LIVE` / `CA_EFT_LIVE` flags and decision 0010's zero
 * throughput, and nothing here should be read as adding to or standing in for
 * those. An unrecognised value outside sandbox resolves to unrestricted
 * rather than throwing, because a typo must not take a production deployment
 * down — but inside sandbox an unrecognised value resolves to RESTRICTED, so
 * the typo fails safe where the beta runs.
 */

import { isSandboxEnvironment } from '@/lib/environment';

export type BetaProfile = 'p2p_only' | 'unrestricted';

/** The capabilities a restricted beta withholds. */
export type RestrictedCapability = 'funding' | 'cash_out' | 'cross_currency';

const RESTRICTED_IN_P2P_ONLY: ReadonlySet<RestrictedCapability> = new Set([
  'funding',
  'cash_out',
  'cross_currency',
]);

/**
 * Raised when a restricted capability is attempted. Carries the capability so
 * a route can answer **403** with a specific reason rather than a generic
 * refusal — a participant who is told "cash out is unavailable in this beta"
 * does not retry, and one told "something went wrong" does.
 */
export class BetaRestrictionError extends Error {
  readonly capability: RestrictedCapability;
  readonly profile: BetaProfile;

  constructor(capability: RestrictedCapability, message: string) {
    super(message);
    this.name = 'BetaRestrictionError';
    this.capability = capability;
    this.profile = 'p2p_only';
  }
}

/** The active profile. See the resolution rules in this file's header. */
export function betaProfile(): BetaProfile {
  const declared = process.env.MANNA_BETA_PROFILE?.trim().toLowerCase();

  if (declared === 'p2p_only') return 'p2p_only';
  if (declared === 'unrestricted') return 'unrestricted';

  // Unset, or an unrecognised value. Sandbox fails safe; production is not
  // this module's business.
  return isSandboxEnvironment() ? 'p2p_only' : 'unrestricted';
}

export function isRestrictedBeta(): boolean {
  return betaProfile() === 'p2p_only';
}

export function isCapabilityRestricted(capability: RestrictedCapability): boolean {
  return isRestrictedBeta() && RESTRICTED_IN_P2P_ONLY.has(capability);
}

/** Human-readable refusal, used in the API response and the interface alike. */
export function restrictionMessage(capability: RestrictedCapability): string {
  switch (capability) {
    case 'funding':
      return 'Adding money is disabled in this restricted beta.';
    case 'cash_out':
      return 'Cashing out is disabled in this restricted beta.';
    case 'cross_currency':
      return 'Cross-currency payments are disabled in this restricted beta. You can send to people who use the same currency as you.';
  }
}

/**
 * Throws `BetaRestrictionError` when the capability is withheld.
 *
 * Deliberately NOT wrapped in a try/catch by any caller: a refusal must abort
 * the request, and a `catch` that swallowed it would turn a refusal into an
 * admission — the same shape decision 0008 closed on the velocity paths.
 */
export function assertCapabilityAllowed(capability: RestrictedCapability): void {
  if (isCapabilityRestricted(capability)) {
    throw new BetaRestrictionError(capability, restrictionMessage(capability));
  }
}

/**
 * What the interface and a pre-invitation verification both read.
 *
 * The same resolver serves both, so the banner a participant sees and the
 * rule a route enforces cannot disagree — a UI that hid a button while the
 * API still honoured it would be worse than no restriction, because it would
 * look controlled.
 */
export function betaRestrictionState(): {
  profile: BetaProfile;
  restricted: boolean;
  capabilities: Record<RestrictedCapability, boolean>;
} {
  return {
    profile: betaProfile(),
    restricted: isRestrictedBeta(),
    capabilities: {
      funding: !isCapabilityRestricted('funding'),
      cash_out: !isCapabilityRestricted('cash_out'),
      cross_currency: !isCapabilityRestricted('cross_currency'),
    },
  };
}
