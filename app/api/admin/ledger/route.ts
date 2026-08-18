import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminLedgerService } from '@/lib/services';

async function handler(request: NextRequest): Promise<NextResponse> {
  if (request.method !== 'GET') {
    return NextResponse.json(
      { error: 'Method not allowed' },
      { status: 405 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('page_size') || '50', 10);
    const userId = searchParams.get('user_id');
    const currency = searchParams.get('currency');
    const entryType = searchParams.get('entry_type');
    const provider = searchParams.get('provider');
    const correlationId = searchParams.get('correlation_id');
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

    const service = getAdminLedgerService();
    const filters = {
      userId: userId ? parseInt(userId, 10) : undefined,
      currency: currency || undefined,
      entryType: entryType || undefined,
      provider: provider || undefined,
      correlationId: correlationId || undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    };

    const result = await service.searchLedger(filters, page, pageSize);
    return NextResponse.json(result);
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
        action: 'list_ledger_entries',
        resourceType: 'ledger_entry',
      })
  );
