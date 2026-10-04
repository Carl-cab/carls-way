import { randomUUID } from 'crypto';

/**
 * Stripe metadata key used to correlate a PaymentIntent with its local transfer
 * intent before the provider object id is durably written back to PostgreSQL.
 *
 * This is an opaque routing identifier, not authentication material. It is
 * intentionally safe to place in Stripe metadata, but must still be validated
 * against a locally persisted value before it can select a transfer intent.
 */
export const STRIPE_TRANSFER_CORRELATION_METADATA_KEY = 'manna_transfer_correlation_id';

const STRIPE_TRANSFER_CORRELATION_PREFIX = 'stripe_corr_';
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Generate one opaque, nonsecret correlation value for one Stripe transfer. */
export function createStripeTransferCorrelationId(): string {
  return `${STRIPE_TRANSFER_CORRELATION_PREFIX}${randomUUID()}`;
}

/**
 * Accept only values produced by createStripeTransferCorrelationId(). This
 * prevents a malformed metadata field from silently becoming an alternate
 * lookup key for a financial event.
 */
export function isStripeTransferCorrelationId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(STRIPE_TRANSFER_CORRELATION_PREFIX)) return false;
  return UUID_V4_PATTERN.test(value.slice(STRIPE_TRANSFER_CORRELATION_PREFIX.length));
}

export type StripeCorrelationMetadata =
  | { kind: 'absent' }
  | { kind: 'valid'; correlationId: string }
  | { kind: 'invalid' };

/**
 * Extract the correlation metadata from a verified Stripe object.
 *
 * Callers distinguish absent metadata (which is allowed for pre-gate Stripe
 * objects that still match by provider reference) from malformed metadata
 * (which must be rejected for manual review rather than ignored).
 */
export function readStripeTransferCorrelationMetadata(
  metadata: unknown,
): StripeCorrelationMetadata {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { kind: 'absent' };
  }

  const value = (metadata as Record<string, unknown>)[STRIPE_TRANSFER_CORRELATION_METADATA_KEY];
  if (value === undefined) return { kind: 'absent' };
  if (!isStripeTransferCorrelationId(value)) return { kind: 'invalid' };
  return { kind: 'valid', correlationId: value };
}
