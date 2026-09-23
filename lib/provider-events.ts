import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';

/**
 * C1.4: after this many recorded processing failures, a webhook event is
 * moved to the dead-letter queue instead of being retried forever unseen.
 */
export const MAX_WEBHOOK_RETRIES = 5;

export interface WebhookFailureOutcome {
  /** False when no event row existed (nothing was recorded). */
  recorded: boolean;
  retryCount: number;
  /** True when this failure pushed the event into the dead-letter queue. */
  deadLettered: boolean;
}

// Record a provider webhook event in the database.
// Returns true if the event was recorded (first time seeing it), false if it already exists.
// Used to detect duplicate webhook deliveries and implement idempotent processing.
export async function recordProviderEvent(
  provider: string,
  providerEventId: string,
  eventType: string,
  options?: {
    relatedProviderReference?: string;
    rawPayload?: Record<string, unknown>;
  }
): Promise<boolean> {
  const sql = getSql();

  try {
    await sql`
      INSERT INTO provider_webhook_events (
        provider, provider_event_id, event_type, related_provider_reference, raw_payload, processing_status
      ) VALUES (
        ${provider}, ${providerEventId}, ${eventType},
        ${options?.relatedProviderReference ?? null},
        ${options?.rawPayload ? JSON.stringify(options.rawPayload) : null},
        'received'
      )
    `;
    return true;
  } catch (err) {
    // A unique violation means we have seen this event before, which is normal:
    // Stripe and Plaid both deliver at least once.
    //
    // This previously read `error.constraint`, which postgres.js does not set —
    // it exposes `constraint_name`. The comparison was therefore always false,
    // so the duplicate was rethrown, the webhook returned 500, and the provider
    // retried the same event indefinitely. Every redelivery, of which there are
    // many by design, became an infinite retry loop.
    //
    // Both spellings are accepted so a driver change cannot silently reopen it,
    // and the code alone is enough to identify the violation on this table: the
    // insert touches one table with one unique constraint.
    const error = err as { code?: string; constraint_name?: string; constraint?: string };
    if (error.code === '23505') {
      const constraint = error.constraint_name ?? error.constraint;
      if (
        constraint === undefined ||
        constraint === 'provider_webhook_events_provider_provider_event_id_key'
      ) {
        return false;
      }
    }
    throw err;
  }
}

// Check if we have already processed this webhook event.
// Returns true if we've seen this event before, false if it's new.
export async function hasProcessedProviderEvent(
  provider: string,
  providerEventId: string
): Promise<boolean> {
  const sql = getSql();

  const result = await sql`
    SELECT id FROM provider_webhook_events
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
    LIMIT 1
  `;

  return result.length > 0;
}

// Mark a provider webhook event as successfully processed.
// Should be called after handling the event without errors.
export async function markProviderEventProcessed(
  provider: string,
  providerEventId: string
): Promise<void> {
  const sql = getSql();

  await sql`
    UPDATE provider_webhook_events
    SET processing_status = 'processed', processed_at = NOW()
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
  `;
}

// Mark a provider webhook event as failed.
// Should be called if event processing throws an error.
//
// C1.4: each failure increments retry_count. When the count reaches
// MAX_WEBHOOK_RETRIES the event is moved to the dead-letter queue
// (processing_status = 'dead_letter' plus a row in webhook_dead_letters
// preserving the payload) instead of failing silently forever. Returns
// whether this call dead-lettered the event.
export async function markProviderEventFailed(
  provider: string,
  providerEventId: string,
  error: string | Error
): Promise<WebhookFailureOutcome> {
  const sql = getSql();

  const errorMessage = error instanceof Error ? error.message : String(error);

  const rows = await sql`
    UPDATE provider_webhook_events
    SET processing_status = CASE
          WHEN retry_count + 1 >= ${MAX_WEBHOOK_RETRIES} THEN 'dead_letter'
          ELSE 'failed'
        END,
        processing_error = ${errorMessage},
        retry_count = retry_count + 1,
        processed_at = NOW(),
        dead_letter_at = CASE
          WHEN retry_count + 1 >= ${MAX_WEBHOOK_RETRIES} THEN NOW()
          ELSE dead_letter_at
        END
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
    RETURNING retry_count, processing_status, event_type, raw_payload
  `;

  if (rows.length === 0) {
    return { recorded: false, retryCount: 0, deadLettered: false };
  }

  const row = rows[0] as {
    retry_count: number;
    processing_status: string;
    event_type: string;
    raw_payload: unknown;
  };

  if (row.processing_status !== 'dead_letter') {
    return { recorded: true, retryCount: row.retry_count, deadLettered: false };
  }

  // Preserve the event in the dead-letter queue for operator review/replay.
  // Idempotent: a provider that keeps redelivering refreshes the entry
  // instead of duplicating it.
  const payload =
    typeof row.raw_payload === 'string' ? row.raw_payload : JSON.stringify(row.raw_payload ?? null);
  await sql`
    INSERT INTO webhook_dead_letters
      (provider, provider_event_id, event_type, raw_payload, failure_count, last_error)
    VALUES (
      ${provider}, ${providerEventId}, ${row.event_type},
      ${payload}::jsonb, ${row.retry_count}, ${errorMessage}
    )
    ON CONFLICT (provider, provider_event_id) DO UPDATE SET
      failure_count = EXCLUDED.failure_count,
      last_error = EXCLUDED.last_error,
      created_at = NOW(),
      requeued_at = NULL
  `;

  await auditLog(null, 'webhook_dead_lettered', {
    provider,
    provider_event_id: providerEventId,
    event_type: row.event_type,
    failure_count: row.retry_count,
    last_error: errorMessage,
  });

  return { recorded: true, retryCount: row.retry_count, deadLettered: true };
}

// Get an unprocessed webhook event by provider and event ID.
// Used internally to fetch event details for processing.
export async function getProviderEvent(
  provider: string,
  providerEventId: string
): Promise<Record<string, unknown> | null> {
  const sql = getSql();

  const result = await sql`
    SELECT * FROM provider_webhook_events
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
  `;

  return (result[0] as Record<string, unknown> | undefined) ?? null;
}
