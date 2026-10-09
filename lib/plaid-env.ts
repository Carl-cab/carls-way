import { PlaidEnvironments } from 'plaid';

/**
 * Which Plaid host this process talks to.
 *
 * `lib/plaid.ts` and `app/api/webhooks/plaid/route.ts` both call this. They
 * used to default in opposite directions: the client to production, the
 * webhook verifier to sandbox. A request could be signed against one host
 * and sent to the other.
 *
 * Fail closed: an unset or unrecognised `PLAID_ENV` is sandbox, never
 * production. Production Plaid is used only when `PLAID_ENV=production`.
 *
 * This does not consult `MANNA_ENV`. On the deployed sandbox beta,
 * `VERCEL_ENV=production` already forces the deployment environment to
 * production, and treating that as "talk to production Plaid" would move a
 * sandbox beta onto the live Plaid host. The live transfer flags remain a
 * separate gate.
 */
export type PlaidEnvironmentName = 'sandbox' | 'production';

export function resolvePlaidEnvironment(): PlaidEnvironmentName {
  // The installed Plaid SDK only publishes sandbox and production hosts.
  // Anything else, including "development" and a typo, stays on sandbox.
  const declared = process.env.PLAID_ENV?.trim().toLowerCase();
  if (declared === 'production') return 'production';
  return 'sandbox';
}

export function plaidApiBasePath(): string {
  return PlaidEnvironments[resolvePlaidEnvironment()];
}

/**
 * JWKS URL for the Plaid-Verification JWT.
 *
 * Production is the only host with its own keys, and only when `PLAID_ENV`
 * says so. Every other value verifies against sandbox keys.
 */
export function plaidWebhookJwksUrl(): string {
  return resolvePlaidEnvironment() === 'production'
    ? 'https://production.plaid.com/.well-known/jwks.json'
    : 'https://sandbox.plaid.com/.well-known/jwks.json';
}
