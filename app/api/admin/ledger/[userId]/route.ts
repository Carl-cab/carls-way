import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminLedgerService } from '@/lib/services';
import { isPermissionDenied } from '@/lib/errors';

async function handler(request: NextRequest): Promise<NextResponse> {
  if (request.method !== 'GET') {
    return NextResponse.json(
      { error: 'Method not allowed' },
      { status: 405 }
    );
  }

  try {
    const { pathname, searchParams } = new URL(request.url);
    const userId = pathname.split('/').pop();
    const parsedUserId = parseInt(userId || '', 10);

    if (isNaN(parsedUserId)) {
      return NextResponse.json(
        { error: 'Invalid user ID' },
        { status: 400 }
      );
    }

    const currency = searchParams.get('currency');
    const service = getAdminLedgerService();

    if (currency) {
      const balance = await service.getUserBalance(parsedUserId, currency);
      return NextResponse.json({
        user_id: parsedUserId,
        currency,
        ...balance,
      });
    }

    const entries = await service.getUserLedger(parsedUserId);
    return NextResponse.json({
      user_id: parsedUserId,
      entries,
      count: entries.length,
    });
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
        action: 'view_user_ledger',
        resourceType: 'ledger_entry',
      })
  );
