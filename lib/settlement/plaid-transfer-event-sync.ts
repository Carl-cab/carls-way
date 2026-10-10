import { getSql } from '@/lib/db';
import { plaidClient } from '@/lib/plaid';
import { recordProviderEvent } from '@/lib/provider-events';
import { handlePlaidTransferSettlement } from './handle-plaid-settlement';

/**
 * Sync Plaid Transfer events after a verified TRANSFER_EVENTS_UPDATE.
 *
 * That webhook body is constant: it names no transfer and no status. The
 * economic cursor is the largest event_id this process has finished, stored
 * in plaid_transfer_event_cursors. Each event is handed to
 * handlePlaidTransferSettlement, which applies money through
 * applySettlementAtomically, so a replayed event cannot credit a wallet twice.
 *
 * The cursor row is locked with a transaction advisory lock and SELECT FOR
 * UPDATE for the whole page loop, including the Plaid HTTP calls. A second
 * webhook blocks until this transaction commits, then reads the advanced
 * cursor. The lock is transaction-scoped on purpose: a session lock would
 * stick to a pooled connection if the process died between lock and unlock.
 *
 * An HTTP failure rolls the cursor transaction back. Settlements that already
 * committed are safe to replay. A retryable settlement failure commits the
 * cursor at the last event that finished and leaves the failing event
 * unadvanced, so the next delivery retries it instead of skipping it.
 *
 * This function does not create the cursor table. That is an additive
 * migration in initializeSchema and GET /api/migrate. A missing table fails
 * the sync and the webhook answers 500.
 */

export const PLAID_TRANSFER_EVENT_CURSOR_ID = 'default';
export const PLAID_TRANSFER_SYNC_PAGE_SIZE = 25;
export const PLAID_TRANSFER_SYNC_MAX_PAGES = 40;

/** Distinct from initializeSchema's pg_advisory_xact_lock(1760304512). */
const CURSOR_ADVISORY_LOCK_CLASS = 871442;
const CURSOR_ADVISORY_LOCK_KEY = 1;

export interface PlaidTransferEventSyncResult {
  afterId: number;
  eventsSeen: number;
  eventsApplied: number;
  retryable: boolean;
  reason?: string;
}

interface SyncEvent {
  event_id: number;
  event_type?: string;
  transfer_id?: string;
}

interface SyncPage {
  transfer_events: SyncEvent[];
  has_more: boolean;
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function providerEventIdFor(eventId: number): string {
  return `plaid_transfer_event:${eventId}`;
}

/**
 * Page /transfer/event/sync from the persisted cursor and settle each event.
 *
 * Returns retryable when the caller must answer 500 so Plaid redelivers.
 * The cursor then points at the last event that was fully handled.
 */
export async function syncPlaidTransferEvents(
  correlationId: string,
): Promise<PlaidTransferEventSyncResult> {
  const sql = getSql();

  return sql.begin(async (tx) => {
    // Casts pick the (int, int) overload. An untyped parameter is ambiguous.
    await tx`SELECT pg_advisory_xact_lock(${CURSOR_ADVISORY_LOCK_CLASS}::int, ${CURSOR_ADVISORY_LOCK_KEY}::int)`;
    await tx`
      INSERT INTO plaid_transfer_event_cursors (cursor_id, after_id)
      VALUES (${PLAID_TRANSFER_EVENT_CURSOR_ID}, 0)
      ON CONFLICT (cursor_id) DO NOTHING
    `;
    const locked = await tx<{ after_id: unknown }[]>`
      SELECT after_id
      FROM plaid_transfer_event_cursors
      WHERE cursor_id = ${PLAID_TRANSFER_EVENT_CURSOR_ID}
      FOR UPDATE
    `;
    const stored = readNonNegativeSafeInteger(locked[0]?.after_id);
    if (stored === null) {
      throw new Error('Plaid transfer event cursor is missing or outside the safe integer range');
    }

    let afterId = stored;
    let eventsSeen = 0;
    let eventsApplied = 0;
    let retryable = false;
    let reason: string | undefined;

    for (let page = 0; page < PLAID_TRANSFER_SYNC_MAX_PAGES; page++) {
      const response = await plaidClient.transferEventSync({
        after_id: afterId,
        count: PLAID_TRANSFER_SYNC_PAGE_SIZE,
      });
      const body = response?.data as SyncPage | undefined;
      if (!body || !Array.isArray(body.transfer_events) || typeof body.has_more !== 'boolean') {
        throw new Error('Plaid transfer event sync returned an unexpected payload');
      }

      const events = [...body.transfer_events].sort((a, b) => {
        const left = readNonNegativeSafeInteger(a.event_id);
        const right = readNonNegativeSafeInteger(b.event_id);
        if (left === null && right === null) return 0;
        if (left === null) return -1;
        if (right === null) return 1;
        return left - right;
      });
      if (events.length === 0) break;

      let stop = false;
      for (const event of events) {
        const eventId = readNonNegativeSafeInteger(event.event_id);
        if (eventId === null) {
          retryable = true;
          reason = 'unsafe_event_id';
          stop = true;
          break;
        }
        if (eventId <= afterId) continue;

        eventsSeen += 1;
        const providerEventId = providerEventIdFor(eventId);
        const transferId =
          typeof event.transfer_id === 'string' && event.transfer_id.trim().length > 0
            ? event.transfer_id
            : undefined;
        const plaidStatus = typeof event.event_type === 'string' ? event.event_type : undefined;

        // Record before settlement. markProviderEventProcessed/Failed update
        // an existing row; a missing row would drop the failure on the floor.
        await recordProviderEvent('plaid', providerEventId, `transfer.event.${plaidStatus ?? 'unknown'}`, {
          relatedProviderReference: transferId,
          correlationId,
          rawPayload: {
            event_id: eventId,
            event_type: plaidStatus ?? null,
            transfer_id: transferId ?? '',
          },
        });

        const result = await handlePlaidTransferSettlement({
          providerEventId,
          transferId,
          plaidStatus,
          correlationId,
        });

        if (result.retryable) {
          // Leave afterId on the previous success so the next delivery
          // fetches this event again. Do not skip past it.
          retryable = true;
          reason = result.reason
            ? `retryable_settlement: ${result.reason}`.slice(0, 500)
            : 'retryable_settlement';
          stop = true;
          break;
        }

        if (result.outcome === 'applied') eventsApplied += 1;
        afterId = eventId;
        await tx`
          UPDATE plaid_transfer_event_cursors
          SET after_id = ${afterId}, updated_at = NOW()
          WHERE cursor_id = ${PLAID_TRANSFER_EVENT_CURSOR_ID}
        `;
      }

      if (stop || !body.has_more) break;
      if (page === PLAID_TRANSFER_SYNC_MAX_PAGES - 1) {
        retryable = true;
        reason = 'page_cap';
      }
    }

    return { afterId, eventsSeen, eventsApplied, retryable, reason };
  });
}
