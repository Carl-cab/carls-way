import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminAuditService } from '@/lib/services';
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
    const statType = searchParams.get('type');
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

    const service = getAdminAuditService();
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    if (statType === 'performance') {
      const stats = await service.getPerformanceStats(start, end);
      return NextResponse.json({ type: 'performance', ...stats });
    }

    if (statType === 'suspicious') {
      const suspicious = await service.findSuspiciousActivity(start, end);
      return NextResponse.json({
        type: 'suspicious',
        ...suspicious,
      });
    }

    const summary = await service.getSummary(start, end);
    return NextResponse.json({ type: 'summary', ...summary });
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
        action: 'view_audit_stats',
        resourceType: 'audit_log',
      })
  );
