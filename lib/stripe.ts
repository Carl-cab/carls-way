import Stripe from 'stripe';

let _stripe: Stripe | null = null;

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
