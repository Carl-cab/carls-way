import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';
import { PlaidTransferProvider } from '@/lib/providers/PlaidTransferProvider';
import { errorMessage } from '@/lib/errors';

/**
 * POST /api/admin/transfers/[id]/reconcile
 *
 * Resolve a transfer whose provider outcome is unknown — an intent left in
 * `submitting` because the provider authorization was persisted but the
 * transfer reference never was.
 *
 * Authorization (both required):
 *   1. A valid admin session          (withAdminAuth)
 *   2. The 'exceptions:manage' permission — SuperAdmin / OperationsAdmin only.
 * Reconciliation replays a provider call against real money movement, so it is
 * held to the same bar as other privileged operational remediation. There is
 * deliberately no unauthenticated path to this operation.
 *
 * Only live-mode intents are reconcilable: sandbox transfers settle
 * synchronously at confirm and never enter `submitting`.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  try {
    requirePermission('exceptions:manage');

    const intentId = parseInt(req.nextUrl.pathname.split('/').at(-2) ?? '', 10);
    if (isNaN(intentId)) {
      return NextResponse.json({ error: 'Invalid intent ID' }, { status: 400 });
    }

    const sql = getSql();
    const rows = await sql`
      SELECT user_id, execution_mode, provider_name
      FROM transfer_intents
      WHERE id = ${intentId}
    `;
    if (!rows[0]) {
      return NextResponse.json({ error: 'Transfer intent not found' }, { status: 404 });
    }

    if (rows[0].execution_mode !== 'live' || rows[0].provider_name !== 'plaid_transfer') {
      return NextResponse.json(
        { error: 'Only live Plaid transfers require reconciliation' },
        { status: 400 },
      );
    }

    const provider = new PlaidTransferProvider();
    const result = await provider.reconcileTransfer(intentId, rows[0].user_id as number);

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Permission denied')) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    // Reconciliation failing leaves the intent exactly as it was — still in
    // `submitting`, still reconcilable. It is never downgraded to `failed`.
    console.error('Transfer reconciliation error:', err);
    return NextResponse.json(
      { error: 'Reconciliation failed', detail: errorMessage(err) },
      { status: 500 },
    );
  }
}

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, handler, {
      action: 'reconcile_transfer',
      resourceType: 'transfer_intent',
    }),
  );
