import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminSettlementService } from '@/lib/services';
import { isPermissionDenied } from '@/lib/errors';

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
    const senderId = searchParams.get('sender_id');
    const receiverId = searchParams.get('receiver_id');
    const status = searchParams.get('status');
    const currency = searchParams.get('currency');
    const correlationId = searchParams.get('correlation_id');
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

    const service = getAdminSettlementService();
    const filters = {
      senderId: senderId ? parseInt(senderId, 10) : undefined,
      receiverId: receiverId ? parseInt(receiverId, 10) : undefined,
      status: status || undefined,
      currency: currency || undefined,
      correlationId: correlationId || undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    };

    const result = await service.searchTransactions(filters, page, pageSize);
    return NextResponse.json(result);
  } catch (error: unknown) {
    if (isPermissionDenied(error)) {
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
        action: 'list_settlements',
        resourceType: 'transaction',
      })
  );
