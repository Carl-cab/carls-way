import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission, getCurrentAdmin } from '@/lib/rbac';
import { listDeadLetters } from '@/lib/webhooks/dlq';
import { replayDeadLetterForLocalSettlement } from '@/lib/webhooks/replay';

/**
 * GET /api/admin/webhooks/dead-letters
 *
 * List webhook events that exhausted their retries and were moved to the
 * dead-letter queue. ?include_requeued=1 also shows entries already sent
 * back for reprocessing.
 *
 * POST /api/admin/webhooks/dead-letters
 *
 * Atomically claim an existing dead letter and replay it only through the local
 * verified Stripe settlement handler. This does not POST a payload to a provider
 * or webhook route, and it never creates an external rail request.
 * Body: { "provider": "stripe", "providerEventId": "..." }
 */
async function listHandler(req: NextRequest): Promise<NextResponse> {
  try {
    requirePermission('provider_events:view');
  } catch (error) {
    if (error instanceof Error && error.message.includes('requires')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    throw error;
  }
  const { searchParams } = new URL(req.url);
  const letters = await listDeadLetters({
    includeRequeued: searchParams.get('include_requeued') === '1',
  });
  // DLQ payloads can contain provider and customer data. Listing is an
  // operational status endpoint, not a payload export path.
  return NextResponse.json({
    deadLetters: letters.map((letter) => ({
      id: letter.id,
      provider: letter.provider,
      providerEventId: letter.providerEventId,
      eventType: letter.eventType,
      failureCount: letter.failureCount,
      createdAt: letter.createdAt,
      requeuedAt: letter.requeuedAt,
    })),
  });
}

async function requeueHandler(req: NextRequest): Promise<NextResponse> {
  try {
    requirePermission('events:replay');
  } catch (error) {
    if (error instanceof Error && error.message.includes('requires')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    throw error;
  }
  const body = (await req.json().catch(() => ({}))) as {
    provider?: string;
    providerEventId?: string;
  };
  if (!body.provider || !body.providerEventId) {
    return NextResponse.json(
      { error: 'provider and providerEventId are required' },
      { status: 400 }
    );
  }
  let result;
  try {
    result = await replayDeadLetterForLocalSettlement(body.provider, body.providerEventId, {
      requeuedBy: String(getCurrentAdmin()?.id ?? 'admin'),
    });
  } catch {
    // The audit wrapper persists thrown Error.message. Do not let an exception
    // carrying a SQL connection string, payload or PII reach it or the client.
    return NextResponse.json({ error: 'Local replay unavailable' }, { status: 500 });
  }
  if (result.outcome === 'not_found_or_already_replayed') {
    return NextResponse.json(
      { error: 'No open dead-letter entry for that event' },
      { status: 404 }
    );
  }
  if (result.outcome === 'not_replayable') {
    return NextResponse.json(
      { error: 'This event has no supported local verified settlement handler' },
      { status: 422 },
    );
  }
  if (result.outcome === 'stored_event_invalid') {
    return NextResponse.json(
      { error: 'Stored event cannot be safely replayed' },
      { status: 422 },
    );
  }
  if (result.outcome === 'replay_failed') {
    return NextResponse.json({ error: 'Local replay did not complete' }, { status: 500 });
  }
  return NextResponse.json({
    requeued: true,
    localHandler: 'verified_stripe_settlement',
    settlementOutcome: result.settlementOutcome,
    markedProcessed: result.markedProcessed,
  });
}

export const GET = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, listHandler, {
      action: 'list_webhook_dead_letters',
      resourceType: 'webhook',
    }),
  );

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, requeueHandler, {
      action: 'requeue_webhook_dead_letter',
      resourceType: 'webhook',
    }),
  );
