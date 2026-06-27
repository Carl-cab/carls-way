import { getSql } from '@/lib/db';

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
    // If UNIQUE constraint violation, event already exists
    const error = err as Record<string, unknown>;
    if (error.code === '23505' && error.constraint === 'provider_webhook_events_provider_provider_event_id_key') {
      return false;
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
export async function markProviderEventFailed(
  provider: string,
  providerEventId: string,
  error: string | Error
): Promise<void> {
  const sql = getSql();

  const errorMessage = error instanceof Error ? error.message : String(error);

  await sql`
    UPDATE provider_webhook_events
    SET processing_status = 'failed', processing_error = ${errorMessage}, processed_at = NOW()
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
  `;
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
