import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { listDeadLetters, requeueDeadLetter } from '@/lib/webhooks/dlq';

/**
 * GET /api/admin/webhooks/dead-letters
 *
 * List webhook events that exhausted their retries and were moved to the
 * dead-letter queue. ?include_requeued=1 also shows entries already sent
 * back for reprocessing.
 *
 * POST /api/admin/webhooks/dead-letters
 *
 * Send a dead-lettered event back for processing. Resets the event to
 * 'received' with a zeroed retry count, so the next provider redelivery
 * (or a manual re-post of the preserved payload) reprocesses it.
 * Body: { "provider": "plaid", "providerEventId": "..." }
 */
async function listHandler(req: NextRequest): Promise<NextResponse> {
  requirePermission('provider_events:view');
  const { searchParams } = new URL(req.url);
  const letters = await listDeadLetters({
    includeRequeued: searchParams.get('include_requeued') === '1',
  });
  return NextResponse.json({ deadLetters: letters });
}

async function requeueHandler(req: NextRequest): Promise<NextResponse> {
  requirePermission('events:replay');
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
  const requeued = await requeueDeadLetter(body.provider, body.providerEventId);
  if (!requeued) {
    return NextResponse.json(
      { error: 'No open dead-letter entry for that event' },
      { status: 404 }
    );
  }
  return NextResponse.json({ requeued: true });
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
