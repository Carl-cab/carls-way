import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminAuditService } from '@/lib/services';

async function handler(request: NextRequest): Promise<NextResponse> {
  if (request.method !== 'GET') {
    return NextResponse.json(
      { error: 'Method not allowed' },
      { status: 405 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100', 10);

    const service = getAdminAuditService();
    const activity = await service.getMyActivity(Math.min(limit, 500));

    return NextResponse.json({
      audit_logs: activity,
      count: activity.length,
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
        action: 'view_my_activity',
        resourceType: 'audit_log',
      })
  );
