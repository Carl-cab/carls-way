import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminTransferService } from '@/lib/services';
import { isPermissionDenied } from '@/lib/errors';

async function handler(request: NextRequest): Promise<NextResponse> {
  if (request.method !== 'GET') {
    return NextResponse.json(
      { error: 'Method not allowed' },
      { status: 405 }
    );
  }

  try {
    const { pathname } = new URL(request.url);
    const id = pathname.split('/').pop();
    const transferId = parseInt(id || '', 10);

    if (isNaN(transferId)) {
      return NextResponse.json(
        { error: 'Invalid transfer ID' },
        { status: 400 }
      );
    }

    const service = getAdminTransferService();
    const transfer = await service.getTransferById(transferId);

    if (!transfer) {
      return NextResponse.json(
        { error: 'Transfer not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(transfer);
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
        action: 'view_transfer',
        resourceType: 'transfer_intent',
      })
  );
