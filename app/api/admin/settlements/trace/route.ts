import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminSettlementService } from '@/lib/services';

async function handler(request: NextRequest): Promise<NextResponse> {
  if (request.method !== 'GET') {
    return NextResponse.json(
      { error: 'Method not allowed' },
      { status: 405 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const correlationId = searchParams.get('correlation_id');

    if (!correlationId) {
      return NextResponse.json(
        { error: 'correlation_id is required' },
        { status: 400 }
      );
    }

    const service = getAdminSettlementService();
    const transactions = await service.getTransactionsByCorrelationId(
      correlationId
    );

    return NextResponse.json({
      correlation_id: correlationId,
      transactions,
      count: transactions.length,
    });
  } catch (error: any) {
    if (error.message?.includes('Permission denied')) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export const GET = (req: NextRequest) =>
  withAdminAuth(
    req,
    (r) =>
      withAuditLog(r, handler, {
        action: 'trace_settlements',
        resourceType: 'transaction',
      })
  );
