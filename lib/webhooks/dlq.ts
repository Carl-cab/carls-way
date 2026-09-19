import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';

export interface DeadLetter {
  id: number;
  provider: string;
  providerEventId: string;
  eventType: string;
  rawPayload: unknown;
  failureCount: number;
  lastError: string;
  createdAt: string;
  requeuedAt: string | null;
}

/**
 * List dead-lettered webhook events, newest first.
 * Requeued entries are excluded by default — they are back in the normal
 * processing flow.
 */
export async function listDeadLetters(
  opts?: { includeRequeued?: boolean; limit?: number },
): Promise<DeadLetter[]> {
  const sql = getSql();
  const limit = Math.min(opts?.limit ?? 100, 500);

  const rows =
    opts?.includeRequeued
      ? await sql`
          SELECT id, provider, provider_event_id, event_type, raw_payload,
                 failure_count, last_error, created_at, requeued_at
          FROM webhook_dead_letters
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, provider, provider_event_id, event_type, raw_payload,
                 failure_count, last_error, created_at, requeued_at
          FROM webhook_dead_letters
          WHERE requeued_at IS NULL
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;

  return rows.map((r) => ({
    id: r.id as number,
    provider: r.provider as string,
    providerEventId: r.provider_event_id as string,
    eventType: r.event_type as string,
    rawPayload:
      typeof r.raw_payload === 'string' ? JSON.parse(r.raw_payload as string) : r.raw_payload,
    failureCount: r.failure_count as number,
    lastError: r.last_error as string,
    createdAt: r.created_at as string,
    requeuedAt: (r.requeued_at as string | null) ?? null,
  }));
}

/**
 * Requeue a dead-lettered event for processing.
 *
 * Resets the event row to 'received' with a zeroed retry count so the next
 * provider redelivery (or a manual re-post of the payload) reprocesses it
 * instead of being acknowledged-and-ignored. Marks the DLQ entry requeued so
 * it leaves the operator's open queue but stays in history.
 *
 * Returns false when there is no open dead-letter entry for the event.
 */
export async function requeueDeadLetter(
  provider: string,
  providerEventId: string,
  opts?: { requeuedBy?: string },
): Promise<boolean> {
  const sql = getSql();

  const dlRows = await sql`
    UPDATE webhook_dead_letters
    SET requeued_at = NOW()
    WHERE provider = ${provider}
      AND provider_event_id = ${providerEventId}
      AND requeued_at IS NULL
    RETURNING id, event_type, failure_count
  `;
  if (dlRows.length === 0) return false;

  await sql`
    UPDATE provider_webhook_events
    SET processing_status = 'received',
        processing_error = NULL,
        retry_count = 0,
        dead_letter_at = NULL,
        processed_at = NULL
    WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
  `;

  await auditLog(null, 'webhook_dead_letter_requeued', {
    provider,
    provider_event_id: providerEventId,
    event_type: dlRows[0].event_type,
    failure_count: dlRows[0].failure_count,
    requeued_by: opts?.requeuedBy ?? 'admin',
  });

  return true;
}
