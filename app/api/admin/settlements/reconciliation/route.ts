import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { reconcileExternalSettlements } from '@/lib/external-settlement-reconciliation';

/**
 * Run the same aggregate, read-only provider settlement reconciliation as cron.
 * Results deliberately contain no raw provider payload, provider secret, bank
 * identifier, or customer data.
 */
async function reconciliationHandler(): Promise<NextResponse> {
  try {
    requirePermission('settlements:view');
  } catch (error) {
    if (error instanceof Error && error.message.includes('requires')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    throw error;
  }

  const result = await reconcileExternalSettlements();
  return NextResponse.json(result, { status: result.passed ? 200 : 409 });
}

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (request) =>
    withAuditLog(request, reconciliationHandler, {
      action: 'run_external_settlement_reconciliation',
      resourceType: 'settlement_reconciliation',
    }),
  );
