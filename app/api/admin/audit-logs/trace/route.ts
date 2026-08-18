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
    const correlationId = searchParams.get('correlation_id');

    if (!correlationId) {
      return NextResponse.json(
        { error: 'correlation_id is required' },
        { status: 400 }
      );
    }

    const service = getAdminAuditService();
    const timeline = await service.traceByCorrelationId(correlationId);

    return NextResponse.json(timeline);
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
        action: 'trace_correlation',
        resourceType: 'audit_log',
      })
  );
