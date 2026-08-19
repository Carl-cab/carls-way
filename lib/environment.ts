/**
 * Deployment environment resolution.
 *
 * SECURITY CONTRACT — read before changing anything in this file.
 *
 * Permissive ("sandbox") behaviour must be an explicit, positive opt-in. It is
 * never inferred from the absence of a credential, because "credential is
 * missing" and "this is a development machine" are different facts, and
 * conflating them means a production deployment with a misconfigured secret
 * silently degrades into permissive mode.
 *
 * Rules enforced here:
 *
 *  1. Sandbox requires `MANNA_ENV=sandbox`, spelled exactly. Anything else —
 *     unset, empty, typo'd, "dev", "test", "SANDBOX_" — resolves to production.
 *  2. Production is the default. An unconfigured deployment is treated as
 *     production and therefore fails closed, rather than opening up.
 *  3. `VERCEL_ENV=production` overrides `MANNA_ENV=sandbox`. A production
 *     deployment target can never be downgraded into permissive mode by an
 *     environment variable, however it was set.
 *  4. A missing or malformed credential is a *configuration error*, surfaced as
 *     ConfigurationError. It is never an environment signal.
 */

export type DeploymentEnvironment = 'production' | 'sandbox';

/**
 * Raised when the deployment is production but a capability it depends on is
 * not configured. Callers must translate this into a controlled failure —
 * never into a permissive fallback.
 */
export class ConfigurationError extends Error {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.capability = capability;
  }
}

/**
 * Resolve the deployment environment.
 *
 * Production is the default. Sandbox is only ever returned for an exact,
 * explicit `MANNA_ENV=sandbox`, and never on a Vercel production deployment.
 */
export function getDeploymentEnvironment(): DeploymentEnvironment {
  // Rule 3 — the platform's own production signal wins over anything else.
  // Checked first so that no value of MANNA_ENV can weaken a production deploy.
  if (process.env.VERCEL_ENV === 'production') {
    return 'production';
  }

  const declared = process.env.MANNA_ENV?.trim().toLowerCase();

  // Rule 1 — exact positive opt-in only.
  if (declared === 'sandbox') {
    return 'sandbox';
  }

  // Rule 2 — unset / unknown / malformed all resolve to production.
  return 'production';
}

export function isSandboxEnvironment(): boolean {
  return getDeploymentEnvironment() === 'sandbox';
}

export function isProductionEnvironment(): boolean {
  return getDeploymentEnvironment() === 'production';
}

/**
 * Stripe secret keys are `sk_live_…` (live) or `sk_test_…` (test mode).
 * Anything else is not a usable Stripe secret key.
 */
function isWellFormedStripeSecretKey(key: string): boolean {
  return /^sk_(live|test)_[A-Za-z0-9]/.test(key);
}

/**
 * Assert that identity verification (KYC) can actually be performed.
 *
 * In production this requires a present, well-formed Stripe secret key. If that
 * is missing or malformed the function throws ConfigurationError, and the caller
 * must fail the request. It must NOT fall back to approving the user.
 *
 * In sandbox this is a no-op: sandbox does not call Stripe at all.
 */
export function assertKycProviderConfigured(): void {
  if (isSandboxEnvironment()) {
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;

  if (!key || key.trim() === '') {
    throw new ConfigurationError(
      'kyc',
      'STRIPE_SECRET_KEY is not set. Identity verification cannot run in production without it.',
    );
  }

  if (!isWellFormedStripeSecretKey(key.trim())) {
    throw new ConfigurationError(
      'kyc',
      'STRIPE_SECRET_KEY is malformed. Identity verification cannot run in production with an unusable key.',
    );
  }
}

/**
 * Whether automatic (non-provider) identity verification is permitted.
 *
 * True only in an explicitly declared sandbox environment. This is the single
 * gate guarding auto-verification; it deliberately consults no credential.
 */
export function canAutoVerifyIdentity(): boolean {
  return isSandboxEnvironment();
}
