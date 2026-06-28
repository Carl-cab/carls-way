import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, timingSafeEqual } from 'crypto';
import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import { SettlementOrchestrator, SettlementExecutor } from '@/lib/settlement';
import type { SettlementEventType } from '@/lib/settlement';

// ─── JWK cache ────────────────────────────────────────────────────────────────
// Plaid rotates keys infrequently; cache the JWKS for the lifetime of the
// serverless function instance to avoid a round-trip on every webhook.
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const PLAID_JWKS_URL =
  PLAID_ENV === 'production'
    ? 'https://production.plaid.com/webhook_verification_key/get'
    : 'https://sandbox.plaid.com/webhook_verification_key/get';

// jose's createRemoteJWKSet handles caching and key rotation automatically.
// We use the standard JWKS endpoint exposed by Plaid.
// Plaid also exposes a standard JWKS-compatible endpoint at:
//   https://{env}.plaid.com/.well-known/jwks.json  (undocumented but stable)
// We use the documented /webhook_verification_key/get approach via the SDK
// but fall back to the well-known endpoint for jose's RemoteJWKSet.
const PLAID_JWKS_WELL_KNOWN =
  PLAID_ENV === 'production'
    ? 'https://production.plaid.com/.well-known/jwks.json'
    : 'https://sandbox.plaid.com/.well-known/jwks.json';

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(PLAID_JWKS_WELL_KNOWN));
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
  // Phase B3.1/B3.2a/B3.2b: Handle transfer settlement events
  // Extract transfer_id from payload data
  const transferId = (payload.data as Record<string, unknown>)?.transfer_id as
    | string
    | undefined;
  if (!transferId) {
    console.warn('[plaid-webhook] TRANSFER event missing transfer_id');
    return;
  }

  try {
    const eventStatus = (payload.data as Record<string, unknown>)?.status as
      | string
      | undefined;

    // Create normalized event for settlement orchestration
    const normalizedEvent = {
      provider: 'plaid',
      provider_event_id: webhookId,
      provider_reference_id: transferId,
      eventType: mapPlaidTransferStatus(eventStatus),
      timestamp: new Date(),
      isRetry: false, // TODO: track retry status from Plaid headers if available
    };

    // B2: Get settlement plan
    // Milestone 2: Pass correlation ID through settlement pipeline
    const orchestrator = new SettlementOrchestrator();
    const plan = await orchestrator.orchestrateSettlement(normalizedEvent, correlationId);

    // B3.1: Execute status transition
    const executor = new SettlementExecutor();
    const statusResult = await executor.executeSettlementPlan(plan);

    // B3.2a: Execute ledger creation
    const ledgerResult = await executor.executeLedgerCreation(plan);

    // B3.2b: Execute balance update
    const balanceResult = await executor.executeBalanceUpdate(plan);

    // Log execution results
    console.log(
      `[plaid-webhook] Transfer settlement executed: ${transferId} → ${statusResult.newStatus}`,
      {
        status: statusResult,
        ledger: ledgerResult,
        balance: balanceResult,
      }
    );

    await auditLog(
      0, // Will be replaced by intent owner in future phases
      'transfer_settlement_executed',
      {
        transfer_id: transferId,
        status_transition: `${statusResult.previousStatus} → ${statusResult.newStatus}`,
        status_updated: statusResult.updated,
        ledger_entries_created: ledgerResult.entriesCreated,
        balance_updated: balanceResult.balanceUpdated,
        balance_currency: balanceResult.currency,
        balance_amount: balanceResult.amountApplied,
      }
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[plaid-webhook] Transfer event handler error: ${errMsg}`, err);
  }
}

function mapPlaidTransferStatus(status: string | undefined): SettlementEventType {
  // Map Plaid transfer status to settlement event type
  switch (status) {
    case 'submitted':
      return 'submitted';
    case 'authorized':
      return 'authorized';
    case 'pending':
      return 'pending';
    case 'posted':
      return 'posted';
    case 'settled':
      return 'settled';
    case 'failed':
      return 'failed';
    case 'returned':
      return 'returned';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'submitted';
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
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
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
        ${JSON.stringify(payload)},
        'received',
        ${correlationId}
      )
      ON CONFLICT (provider, provider_event_id) DO NOTHING
      RETURNING id
    `;

    // If no row was returned, this is a duplicate — return 200 immediately
    if (insertResult.length === 0) {
      console.log(`[plaid-webhook] Duplicate event ignored: ${webhookId} (${eventType})`);
      return NextResponse.json({ received: true, duplicate: true });
    }

    const eventRowId = (insertResult[0] as { id: number }).id;

    // 5. Dispatch to event handler
    try {
      if (webhook_type === 'TRANSACTIONS' && webhook_code === 'DEFAULT_UPDATE') {
        await handleTransactionsDefault(payload);
      } else if (webhook_type === 'ITEM' && webhook_code === 'ERROR') {
        await handleItemError(payload);
      } else if (webhook_type === 'ITEM' && webhook_code === 'PENDING_EXPIRATION') {
        await handleItemPendingExpiration(payload);
      } else if (webhook_type === 'TRANSFER' && webhook_code === 'STATUS_UPDATE') {
        await handleTransferEventStatusUpdate(payload, webhookId, correlationId);
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
    } catch (handlerErr) {
      const errMsg = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
      console.error(`[plaid-webhook] Handler error for ${eventType}:`, handlerErr);

      // Mark as failed but still return 200 so Plaid does not retry
      await sql`
        UPDATE provider_webhook_events
        SET processing_status = 'failed',
            processing_error = ${errMsg}
        WHERE id = ${eventRowId}
      `;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[plaid-webhook] Database error:', err);
    // Return 500 so Plaid will retry
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
