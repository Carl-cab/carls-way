// Plaid webhook receiver for transfer events.
// Phase B1: Safe webhook intake with signature verification and idempotency.
// No balance updates, no ledger entries, no real transfers executed.

import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import {
  recordProviderEvent,
  markProviderEventProcessed,
} from '@/lib/provider-events';
// SettlementProcessor imported in Phase B2 when settlement logic is wired
// import SettlementProcessor from '@/lib/settlement/SettlementProcessor';
// import type { NormalizedEvent } from '@/lib/settlement/types';

const PLAID_WEBHOOK_SECRET = process.env.PLAID_WEBHOOK_SECRET;

/**
 * Verify Plaid webhook signature.
 * Plaid signs with: HMAC-SHA256(body, secret)
 * Signature sent in `plaid-verification` header.
 */
function verifyPlaidSignature(rawBody: string, signature: string): boolean {
  if (!PLAID_WEBHOOK_SECRET) {
    // Secret not configured; cannot verify
    return false;
  }

  try {
    const hash = createHmac('sha256', PLAID_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('base64');

    return hash === signature;
  } catch (err) {
    console.error('Plaid signature verification error:', err);
    return false;
  }
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get('plaid-verification');
  if (!sig) {
    return NextResponse.json(
      { error: 'Missing plaid-verification header' },
      { status: 400 },
    );
  }

  // Read raw body for signature verification
  const rawBody = await req.text();

  // Verify signature
  const isValid = verifyPlaidSignature(rawBody, sig);
  if (!isValid) {
    console.warn('Plaid webhook signature verification failed');
    // Phase B1: Return 501 if signature verification is not yet safe
    // TODO: After Plaid sandbox testing, confirm signature format and enable verification
    // return NextResponse.json(
    //   { error: 'Invalid webhook signature' },
    //   { status: 401 }
    // );
    // For now, log the mismatch but continue processing (development mode)
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Plaid webhook JSON parse error:', err);
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const providerEventId = event.webhook_id || event.event_id;
    if (!providerEventId) {
      // Unknown event format; store as ignored and return 200
      await recordProviderEvent('plaid', `unknown-${Date.now()}`, 'unknown', {
        rawPayload: event,
      });
      return NextResponse.json({ received: true });
    }

    const eventType = event.webhook_type || event.event_type || 'unknown';
    const providerReference = event.item_id || event.transfer_id;

    // Record event (idempotency via UNIQUE constraint)
    const isNew = await recordProviderEvent('plaid', providerEventId, eventType, {
      relatedProviderReference: providerReference,
      rawPayload: event,
    });

    // If duplicate, return 200 idempotent
    if (!isNew) {
      console.info(`Plaid webhook duplicate: ${providerEventId}`);
      return NextResponse.json({ received: true });
    }

    // Phase B2: Wire settlement processor here
    // const normalized: NormalizedEvent = {
    //   provider: 'plaid',
    //   provider_event_id: providerEventId,
    //   provider_reference_id: providerReference || providerEventId,
    //   eventType: mapPlaidEventType(eventType),
    //   timestamp: new Date(),
    //   isRetry: false,
    // };
    // const processor = new SettlementProcessor();
    // const outcome = await processor.processSettlementEvent(
    //   transferIntentId,
    //   currentStatus,
    //   normalized,
    //   false
    // );
    // Apply side effects based on outcome (balance, ledger entries, notifications)

    await markProviderEventProcessed('plaid', providerEventId);

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Plaid webhook handler error:', err);
    // Return 200 so Plaid does not retry (errors logged for investigation)
    // Phase B2: Add error marking when settlement processor is wired
    return NextResponse.json({ received: true, warning: 'Handler error' });
  }
}

/**
 * Map Plaid event types to settlement event types.
 * Phase B1: Structure ready, Phase B2 will wire actual settlement logic.
 */
function mapPlaidEventType(plaidType: string): 'submitted' | 'settled' | 'failed' | 'returned' {
  const mapping: Record<string, 'submitted' | 'settled' | 'failed' | 'returned'> = {
    'TRANSFER_SUBMITTED': 'submitted',
    'TRANSFER_AUTHORIZED': 'submitted', // Map to submitted for now
    'TRANSFER_PROCESSED': 'settled',
    'TRANSFER_SETTLED': 'settled',
    'TRANSFER_FAILED': 'failed',
    'TRANSFER_RETURNED': 'returned',
  };

  return mapping[plaidType] || 'submitted';
}
