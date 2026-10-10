import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type postgres from 'postgres';
import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import { handlePlaidTransferSettlement } from '@/lib/settlement/handle-plaid-settlement';
import { syncPlaidTransferEvents } from '@/lib/settlement/plaid-transfer-event-sync';
import { checkRateLimit, clientIdentifier, rateLimitHeaders } from '@/lib/rate-limit';
import { markProviderEventFailed, markProviderEventProcessed, getProviderEvent, recordProviderEvent } from '@/lib/provider-events';
import { plaidWebhookJwksUrl, resolvePlaidEnvironment } from '@/lib/plaid-env';
import { logRedactedError, redactedErrorMessage } from '@/lib/plaid-error';

// ─── JWK cache ────────────────────────────────────────────────────────────────
// Plaid rotates keys infrequently; cache the JWKS for the lifetime of the
// serverless function instance to avoid a round-trip on every webhook.
// The host comes from resolvePlaidEnvironment(), the same helper the Plaid
// client uses, so the verifier and the API cannot point at different environments.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _jwksEnv: string | null = null;
function getJWKS() {
  const env = resolvePlaidEnvironment();
  if (!_jwks || _jwksEnv !== env) {
    _jwksEnv = env;
    _jwks = createRemoteJWKSet(new URL(plaidWebhookJwksUrl()));
  }
  return _jwks;
}

// ─── Signature verification ───────────────────────────────────────────────────
/**
 * Verifies the Plaid-Verification JWT header.
 *
 * Steps (per Plaid docs):
 *  1. Decode JWT header — ensure alg === "ES256"
 *  2. Verify JWT signature using Plaid's JWK public key
 *  3. Ensure JWT is not older than 5 minutes (replay protection)
 *  4. SHA-256 the raw request body and compare to request_body_sha256 claim
 */
async function verifyPlaidWebhook(
  rawBody: string,
  verificationHeader: string | null
): Promise<{ valid: boolean; reason?: string }> {
  if (!verificationHeader) {
    return { valid: false, reason: 'Missing Plaid-Verification header' };
  }

  try {
    // Verify JWT signature and extract payload
    const { payload, protectedHeader } = await jwtVerify(
      verificationHeader,
      getJWKS(),
      { algorithms: ['ES256'] }
    );

    // Ensure algorithm is ES256
    if (protectedHeader.alg !== 'ES256') {
      return { valid: false, reason: `Unexpected JWT algorithm: ${protectedHeader.alg}` };
    }

    // Check issued-at — reject if older than 5 minutes
    const iat = payload.iat;
    if (!iat || Date.now() / 1000 - iat > 5 * 60) {
      return { valid: false, reason: 'JWT is expired (older than 5 minutes)' };
    }

    // Verify body hash
    const claimedHash = payload['request_body_sha256'] as string | undefined;
    if (!claimedHash) {
      return { valid: false, reason: 'JWT payload missing request_body_sha256' };
    }

    const actualHash = createHash('sha256').update(rawBody).digest('hex');
    const claimedBuf = Buffer.from(claimedHash, 'hex');
    const actualBuf = Buffer.from(actualHash, 'hex');

    if (
      claimedBuf.length !== actualBuf.length ||
      !timingSafeEqual(claimedBuf, actualBuf)
    ) {
      return { valid: false, reason: 'Body hash mismatch' };
    }

    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `JWT verification failed: ${msg}` };
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleTransactionsDefault(payload: PlaidWebhookPayload) {
  const sql = getSql();
  const { item_id, new_transactions } = payload;

  // Find the bank account linked to this item
  const rows = await sql`
    SELECT id, user_id FROM bank_accounts
    WHERE plaid_item_id = ${item_id ?? null} AND is_active = true
    LIMIT 1
  `;
  if (!rows[0]) return;

  const { user_id } = rows[0] as { id: number; user_id: number };

  // Notify the user that new transactions are available
  await sql`
    INSERT INTO notifications (user_id, type, title, message)
    VALUES (
      ${user_id},
      'transactions_update',
      'New Transactions Available',
      ${`${new_transactions ?? 0} new transaction(s) synced from your bank.`}
    )
  `;

  await auditLog(user_id, 'plaid_transactions_update', {
    item_id,
    new_transactions: new_transactions ?? 0,
  });
}

async function handleItemError(payload: PlaidWebhookPayload) {
  const sql = getSql();
  const { item_id, error } = payload;

  const rows = await sql`
    SELECT id, user_id FROM bank_accounts
    WHERE plaid_item_id = ${item_id ?? null} AND is_active = true
    LIMIT 1
  `;
  if (!rows[0]) return;

  const { id: bankAccountId, user_id } = rows[0] as { id: number; user_id: number };

  // Mark the bank account as requiring re-link
  await sql`
    UPDATE bank_accounts
    SET is_active = false,
        relink_required = true,
        updated_at = NOW()
    WHERE id = ${bankAccountId}
  `;

  // Notify user to re-link
  const errorCode = error?.error_code ?? 'UNKNOWN';
  await sql`
    INSERT INTO notifications (user_id, type, title, message)
    VALUES (
      ${user_id},
      'bank_relink_required',
      'Bank Account Needs Re-linking',
      ${`Your bank account connection has an issue (${errorCode}). Please re-link your account to continue using transfers.`}
    )
  `;

  await auditLog(user_id, 'plaid_item_error', {
    item_id,
    bank_account_id: bankAccountId,
    error_code: errorCode,
  });
}

async function handleItemPendingExpiration(payload: PlaidWebhookPayload) {
  const sql = getSql();
  const { item_id, consent_expiration_time } = payload;

  const rows = await sql`
    SELECT id, user_id FROM bank_accounts
    WHERE plaid_item_id = ${item_id ?? null} AND is_active = true
    LIMIT 1
  `;
  if (!rows[0]) return;

  const { user_id } = rows[0] as { id: number; user_id: number };

  await sql`
    INSERT INTO notifications (user_id, type, title, message)
    VALUES (
      ${user_id},
      'bank_expiring',
      'Bank Connection Expiring Soon',
      ${`Your bank account connection will expire on ${consent_expiration_time ?? 'soon'}. Please re-link to avoid interruption.`}
    )
  `;

  await auditLog(user_id, 'plaid_item_pending_expiration', {
    item_id,
    consent_expiration_time,
  });
}

async function handleTransferEventStatusUpdate(
  payload: PlaidWebhookPayload,
  webhookId: string,
  correlationId: string
) {
  const data = payload.data as Record<string, unknown> | undefined;
  const transferId = typeof data?.transfer_id === 'string' ? data.transfer_id : undefined;
  const eventStatus = typeof data?.status === 'string' ? data.status : undefined;

  // Returns the settlement result instead of swallowing it. A retryable
  // failure must not be marked processed by the route, or Plaid will not
  // redeliver and the transfer never settles.
  return handlePlaidTransferSettlement({
    providerEventId: webhookId,
    transferId,
    plaidStatus: eventStatus,
    correlationId,
  });
}

/**
 * TRANSFER_EVENTS_UPDATE is Plaid's real Transfer webhook. The body never
 * carries a transfer id or a status, and it is identical across deliveries,
 * so the body-hash idempotency key below would treat every later notification
 * as a duplicate of the first and stop syncing. Each verified delivery gets
 * its own row and then runs the cursor sync. Settlement idempotency stays in
 * applySettlementAtomically.
 */
async function handleTransferEventsUpdate(
  correlationId: string,
  payload: PlaidWebhookPayload,
  eventType: string,
) {
  const deliveryId = `plaid_transfer_events_update:${randomUUID()}`;
  try {
    await recordProviderEvent('plaid', deliveryId, eventType, {
      correlationId,
      rawPayload: {
        webhook_type: payload.webhook_type,
        webhook_code: payload.webhook_code,
        environment: payload.environment ?? null,
      },
    });
    const sync = await syncPlaidTransferEvents(correlationId);
    if (sync.retryable) {
      await markProviderEventFailed(
        'plaid',
        deliveryId,
        sync.reason ?? 'Plaid transfer event sync did not finish',
      );
      return NextResponse.json(
        { error: 'Settlement failed; event will be retried' },
        { status: 500 },
      );
    }
    await markProviderEventProcessed('plaid', deliveryId);
    return NextResponse.json({ received: true, synced: true });
  } catch (err) {
    const errMsg = redactedErrorMessage(err);
    logRedactedError('[plaid-webhook] TRANSFER_EVENTS_UPDATE sync failed:', err);
    try {
      await markProviderEventFailed('plaid', deliveryId, errMsg);
    } catch (markErr) {
      logRedactedError('[plaid-webhook] Failed to record sync failure:', markErr);
    }
    return NextResponse.json(
      { error: 'Settlement failed; event will be retried' },
      { status: 500 },
    );
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id?: string;
  new_transactions?: number;
  removed_transactions?: string[];
  error?: { error_code?: string; error_message?: string } | null;
  consent_expiration_time?: string;
  environment?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // C1.1: reject floods before any verification work. Keyed on source IP —
  // webhooks are unauthenticated at this point, so per-user keying is not
  // possible yet. Legitimate provider traffic is far below this ceiling.
  const webhookRate = await checkRateLimit('webhook:events', clientIdentifier(req));
  if (!webhookRate.allowed) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: rateLimitHeaders(webhookRate) },
    );
  }

  // Milestone 2: Extract or generate correlation ID for request tracing
  const { extractOrGenerateCorrelationId } = await import('@/lib/correlation');
  const correlationId = extractOrGenerateCorrelationId(req);

  // 1. Read raw body — required for signature verification
  const rawBody = await req.text();

  // 2. Verify signature
  const verificationHeader = req.headers.get('plaid-verification');
  const { valid, reason } = await verifyPlaidWebhook(rawBody, verificationHeader);

  if (!valid) {
    console.error(`[plaid-webhook] Signature verification failed: ${reason}`);
    return NextResponse.json({ error: 'Invalid webhook signature', reason }, { status: 400 });
  }

  // 3. Parse payload
  let payload: PlaidWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as PlaidWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { webhook_type, webhook_code } = payload;
  const eventType = `${webhook_type}.${webhook_code}`;

  // The real Transfer webhook is handled before the body-hash dedupe. Its
  // body does not change between deliveries, so that hash would swallow every
  // notification after the first. Signature verification has already passed.
  if (webhook_type === 'TRANSFER' && webhook_code === 'TRANSFER_EVENTS_UPDATE') {
    return handleTransferEventsUpdate(correlationId, payload, eventType);
  }

  // 4. Idempotency — use a stable event ID derived from the JWT kid + body hash
  //    Plaid does not send a unique event ID in the body, so we derive one from
  //    the SHA-256 of the raw body (which is verified above).
  const webhookId = createHash('sha256').update(rawBody).digest('hex').slice(0, 64);

  const sql = getSql();

  try {
    // Attempt to insert — the UNIQUE(provider, provider_event_id) constraint
    // makes this naturally idempotent: duplicate webhooks are silently ignored.
    // Milestone 2: Include correlation_id for request tracing
    const insertResult = await sql`
      INSERT INTO provider_webhook_events
        (provider, provider_event_id, event_type, related_provider_reference, raw_payload, processing_status, correlation_id)
      VALUES (
        'plaid',
        ${webhookId},
        ${eventType},
        ${payload.item_id ?? null},
        ${sql.json(payload as unknown as postgres.JSONValue)},
        'received',
        ${correlationId}
      )
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id
    `;

    // If no row was returned, this is a redelivery. Processed and dead-lettered
    // events are acknowledged without reprocessing; events that previously
    // failed (or crashed mid-processing) are reprocessed so provider retries
    // actually retry — this is what feeds the dead-letter queue.
    let eventRowId: number;
    if (insertResult.length === 0) {
      const existing = (await getProviderEvent('plaid', webhookId)) as {
        id: number;
        processing_status: string;
      } | null;
      const existingStatus = existing?.processing_status;
      if (!existing || existingStatus === 'processed' || existingStatus === 'dead_letter') {
        console.log(`[plaid-webhook] Duplicate event ignored: ${webhookId} (${eventType})`);
        return NextResponse.json({ received: true, duplicate: true });
      }
      console.log(
        `[plaid-webhook] Reprocessing ${existingStatus} event: ${webhookId} (${eventType})`
      );
      eventRowId = existing.id;
    } else {
      eventRowId = (insertResult[0] as { id: number }).id;
    }

    // 5. Dispatch to event handler
    try {
      if (webhook_type === 'TRANSACTIONS' && webhook_code === 'DEFAULT_UPDATE') {
        await handleTransactionsDefault(payload);
      } else if (webhook_type === 'ITEM' && webhook_code === 'ERROR') {
        await handleItemError(payload);
      } else if (webhook_type === 'ITEM' && webhook_code === 'PENDING_EXPIRATION') {
        await handleItemPendingExpiration(payload);
      } else if (webhook_type === 'TRANSFER' && webhook_code === 'STATUS_UPDATE') {
        const settlement = await handleTransferEventStatusUpdate(payload, webhookId, correlationId);
        if (settlement.retryable) {
          // The handler already recorded the failure. 500 is what makes Plaid
          // redeliver; marking the row processed here would drop the transfer.
          return NextResponse.json(
            { error: 'Settlement failed; event will be retried' },
            { status: 500 },
          );
        }
        if (settlement.markedProcessed) {
          await sql`
            UPDATE provider_webhook_events
            SET processing_status = 'processed',
                processed_at = NOW()
            WHERE id = ${eventRowId}
          `;
        }
        return NextResponse.json({ received: true, outcome: settlement.outcome });
      } else {
        // Unhandled event type — log and acknowledge
        console.log(`[plaid-webhook] Unhandled event: ${eventType}`);
      }

      // Mark as processed
      await sql`
        UPDATE provider_webhook_events
        SET processing_status = 'processed',
            processed_at = NOW()
        WHERE id = ${eventRowId}
      `;
      return NextResponse.json({ received: true });
    } catch (handlerErr) {
      const errMsg = redactedErrorMessage(handlerErr);
      logRedactedError(`[plaid-webhook] Handler error for ${eventType}:`, handlerErr);

      // C1.4: track the failure; after MAX_WEBHOOK_RETRIES the event moves to
      // the dead-letter queue. Return 500 so Plaid redelivers — previously a
      // handler failure was acknowledged with 200, which meant the event was
      // silently lost (Plaid never retries a 200).
      const outcome = await markProviderEventFailed('plaid', webhookId, errMsg);
      if (outcome.deadLettered) {
        console.error(
          `[plaid-webhook] Event dead-lettered after ${outcome.retryCount} attempts: ${webhookId} (${eventType})`
        );
      }
      return NextResponse.json(
        { error: 'Webhook handler failed; event will be retried' },
        { status: 500 }
      );
    }

    // Unreachable: both paths above return.
  } catch (err) {
    logRedactedError('[plaid-webhook] Database error:', err);
    // Return 500 so Plaid will retry
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
