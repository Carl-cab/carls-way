import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { listOpenRecoveryFlags, runTransferRecoverySweep } from '@/lib/transfers/recovery';

/**
 * GET /api/admin/transfers/stuck
 *
 * List transfer intents flagged as stuck by the recovery sweep, with their
 * recommended recovery action. Read-only.
 *
 * POST /api/admin/transfers/stuck
 *
 * Run the stuck-transfer recovery sweep. Flags intents sitting in
 * non-terminal statuses past their timeouts (see RECOVERY_TIMEOUTS in
 * lib/transfers/recovery.ts). Flagging never mutates the intent itself.
 * Body: { "dryRun": true } to scan without flagging.
 *
 * Authorization: GET needs 'transfers:view'; POST needs 'exceptions:manage'
 * (same bar as the manual reconcile endpoint — this drives operational
 * remediation of real money movement).
 */
async function listHandler(): Promise<NextResponse> {
  requirePermission('transfers:view');
  const flags = await listOpenRecoveryFlags();
  return NextResponse.json({ flags });
}

async function sweepHandler(req: NextRequest): Promise<NextResponse> {
  requirePermission('exceptions:manage');
  const body = (await req.json().catch(() => ({}))) as { dryRun?: boolean };
  const result = await runTransferRecoverySweep({ dryRun: body.dryRun ?? false });
  return NextResponse.json(result);
}

export const GET = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, listHandler, {
      action: 'list_stuck_transfers',
      resourceType: 'transfer_intent',
    }),
  );

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, sweepHandler, {
      action: 'run_transfer_recovery_sweep',
      resourceType: 'transfer_intent',
    }),
  );
