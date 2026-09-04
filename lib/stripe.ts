import Stripe from 'stripe';

let _stripe: Stripe | null = null;

/*
 * NOTE: there is deliberately no `isStripeLive()` helper here.
 *
 * Inferring "sandbox" from the absence (or test-mode prefix) of a credential is
 * a fail-open pattern: a production deployment with a missing or test key would
 * silently take the permissive branch. Environment is resolved explicitly in
 * lib/environment.ts instead, and credential problems surface there as
 * ConfigurationError. Do not reintroduce credential-sniffing here.
 */

/**
 * Returns a singleton Stripe client.
 * Throws at call-time (not module load) so missing env vars surface
 * in the request that actually uses Stripe, with a clear message.
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY environment variable is not set');
    }
    _stripe = new Stripe(key, {
      apiVersion: '2026-06-24.dahlia',
    });
  }
  return _stripe;
}
