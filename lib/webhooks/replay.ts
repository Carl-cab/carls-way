import { getSql } from '@/lib/db';
import {
  handleStripeSettlementEvent,
  isSettlementEvent,
} from '@/lib/settlement/handle-stripe-settlement';
import type { StripeEventLike } from '@/lib/settlement/stripe-event-adapter';

export type DeadLetterReplayOutcome =
  | 'replayed'
  | 'not_found_or_already_replayed'
  | 'not_replayable'
  | 'stored_event_invalid'
  | 'replay_failed';

export interface DeadLetterReplayResult {
  outcome: DeadLetterReplayOutcome;
  /** The local settlement result is intentionally summarized, never raw payload. */
  settlementOutcome?: string;
  markedProcessed?: boolean;
}

interface ClaimedReplayEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  relatedProviderReference: string | null;
  rawPayload: unknown;
  correlationId: string | null;
}

function parseStoredStripeEvent(event: ClaimedReplayEvent): StripeEventLike | null {
  let payload: unknown = event.rawPayload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  const data = candidate.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const object = (data as Record<string, unknown>).object;
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;

  // The event was accepted only after provider signature verification. Re-check
  // its stable identifiers before giving the stored evidence to the local handler
  // so a corrupt row cannot be replayed under another event or reference.
  if (candidate.id !== event.providerEventId || candidate.type !== event.eventType) return null;
  const objectId = (object as Record<string, unknown>).id;
  if (typeof objectId !== 'string' || objectId.length === 0) return null;
  if (objectId !== event.relatedProviderReference) return null;

  return candidate as unknown as StripeEventLike;
}

/**
 * Claim one open dead letter and send only its already-verified, persisted event
 * to the local Stripe settlement handler. This function never invokes a webhook
 * HTTP route, never recreates a provider request, and never constructs a rail
 * provider. The settlement transaction itself remains the financial exactly-once
 * barrier for concurrent provider redelivery or operator replay.
 */
export async function replayDeadLetterForLocalSettlement(
  provider: string,
  providerEventId: string,
  _opts?: { requeuedBy?: string },
): Promise<DeadLetterReplayResult> {
  // The admin audit wrapper owns actor identity. Keep the optional argument for
  // route compatibility without persisting an identifier in the aggregate-only
  // operational replay audit record.
  void _opts;
  const sql = getSql();

  const claimed = await sql.begin(async (tx) => {
    const rows = await tx<{
      provider: string;
      provider_event_id: string;
      event_type: string;
      related_provider_reference: string | null;
      raw_payload: unknown;
      correlation_id: string | null;
    }[]>`
      SELECT
        dl.provider,
        dl.provider_event_id,
        dl.event_type,
        e.related_provider_reference,
        e.raw_payload,
        e.correlation_id
      FROM webhook_dead_letters AS dl
      JOIN provider_webhook_events AS e
        ON e.provider = dl.provider AND e.provider_event_id = dl.provider_event_id
      WHERE dl.provider = ${provider}
        AND dl.provider_event_id = ${providerEventId}
        AND dl.requeued_at IS NULL
        AND e.processing_status = 'dead_letter'
        AND dl.event_type = e.event_type
        AND dl.raw_payload IS NOT DISTINCT FROM e.raw_payload
      FOR UPDATE OF dl, e
    `;

    if (!rows[0]) return null;
    const row = rows[0];

    // Only Stripe's locally verified settlement handler is eligible today. Do
    // not guess how to reconstruct any other provider's signed event.
    if (row.provider !== 'stripe' || !isSettlementEvent(row.event_type)) {
      return 'not_replayable' as const;
    }

    const candidate = {
      provider: row.provider,
      providerEventId: row.provider_event_id,
      eventType: row.event_type,
      relatedProviderReference: row.related_provider_reference,
      rawPayload: row.raw_payload,
      correlationId: row.correlation_id,
    } satisfies ClaimedReplayEvent;
    if (!parseStoredStripeEvent(candidate)) {
      // Do not reset an event we cannot prove is the same verified Stripe event.
      // It remains open in the DLQ for investigation instead of disappearing into
      // a retry cycle.
      return 'stored_event_invalid' as const;
    }

    await tx`
      UPDATE webhook_dead_letters
      SET requeued_at = NOW()
      WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
        AND requeued_at IS NULL
    `;
    await tx`
      UPDATE provider_webhook_events
      SET processing_status = 'received',
          processing_error = NULL,
          retry_count = 0,
          dead_letter_at = NULL,
          processed_at = NULL
      WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
    `;
    // Operator identity is recorded by the admin audit wrapper. Operational
    // alert metadata is aggregate-only, never IDs or provider error details.
    await tx`
      INSERT INTO audit_logs (user_id, action, metadata)
      VALUES (
        NULL,
        'webhook_dead_letter_replay_queued',
        ${JSON.stringify({ replay_count: 1, handler: 'local_verified_stripe_settlement' })}
      )
    `;

    return candidate;
  });

  if (!claimed) return { outcome: 'not_found_or_already_replayed' };
  if (claimed === 'not_replayable') return { outcome: 'not_replayable' };
  if (claimed === 'stored_event_invalid') return { outcome: 'stored_event_invalid' };

  const event = parseStoredStripeEvent(claimed);
  if (!event) {
    // The event was validated while locked above. Preserve the defensive branch
    // for a future parser change without exposing persisted contents.
    throw new Error('Stored verified event failed replay validation after claim');
  }

  let settlement;
  try {
    // The verified event's PaymentIntent metadata is the sole correlation
    // source. Passing a stored correlation separately would create two
    // authorities and could bypass the metadata-validation path.
    settlement = await handleStripeSettlementEvent(event);
  } catch {
    // Retry remains operator-controlled. A crash after claim can still strand
    // the event in 'received'; the runbook requires manual investigation.
    await reopenFailedReplay(provider, providerEventId);
    return { outcome: 'replay_failed' };
  }
  if (!settlement.markedProcessed) {
    await reopenFailedReplay(provider, providerEventId);
    return { outcome: 'replay_failed' };
  }
  return {
    outcome: 'replayed',
    settlementOutcome: settlement.outcome,
    markedProcessed: settlement.markedProcessed,
  };
}

async function reopenFailedReplay(provider: string, providerEventId: string): Promise<void> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`
      UPDATE provider_webhook_events SET processing_status = 'dead_letter',
          dead_letter_at = NOW()
      WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
        AND processing_status <> 'processed'
    `;
    await tx`
      UPDATE webhook_dead_letters SET requeued_at = NULL
      WHERE provider = ${provider} AND provider_event_id = ${providerEventId}
        AND EXISTS (SELECT 1 FROM provider_webhook_events e
          WHERE e.provider = ${provider} AND e.provider_event_id = ${providerEventId}
            AND e.processing_status = 'dead_letter')
    `;
    await tx`
      INSERT INTO audit_logs (user_id, action, metadata)
      VALUES (NULL, 'webhook_dead_letter_replay_failed', ${JSON.stringify({ replay_count: 1 })})
    `;
  });
}
