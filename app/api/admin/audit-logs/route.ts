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
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('page_size') || '50', 10);
    const adminUserId = searchParams.get('admin_user_id');
    const action = searchParams.get('action');
    const resourceType = searchParams.get('resource_type');
    const status = searchParams.get('status');
    const correlationId = searchParams.get('correlation_id');
    const sessionId = searchParams.get('session_id');
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

    const service = getAdminAuditService();
    const filters = {
      adminUserId: adminUserId ? parseInt(adminUserId, 10) : undefined,
      action: action || undefined,
      resourceType: resourceType || undefined,
      status: status || undefined,
      correlationId: correlationId || undefined,
      sessionId: sessionId || undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    };

    const result = await service.queryAuditLogs(filters, page, pageSize);
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
        action: 'query_audit_logs',
        resourceType: 'audit_log',
      })
  );
