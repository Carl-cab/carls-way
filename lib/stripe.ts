import Stripe from 'stripe';

let _stripe: Stripe | null = null;

/**
 * True when Stripe is configured for LIVE identity verification — i.e. a live
 * secret key is present. When false (no key, or a `sk_test_` sandbox key),
 * the platform runs KYC in sandbox mode: identity is auto-verified so the
 * end-to-end money-movement loop is usable without a live Stripe integration.
 * This gate ensures real KYC is NEVER bypassed once live keys are set.
 */
export function isStripeLive(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return !!key && key.startsWith('sk_live_');
}

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
      apiVersion: '2026-05-27.dahlia',
    });
  }
  return _stripe;
}
