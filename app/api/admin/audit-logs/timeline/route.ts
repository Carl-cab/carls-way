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
    const resourceType = searchParams.get('resource_type');
    const resourceId = searchParams.get('resource_id');

    if (!resourceType || !resourceId) {
      return NextResponse.json(
        { error: 'resource_type and resource_id are required' },
        { status: 400 }
      );
    }

    const parsedResourceId = parseInt(resourceId, 10);
    if (isNaN(parsedResourceId)) {
      return NextResponse.json(
        { error: 'Invalid resource_id' },
        { status: 400 }
      );
    }

    const service = getAdminAuditService();
    const timeline = await service.getTimeline(resourceType, parsedResourceId);

    return NextResponse.json(timeline);
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
        action: 'view_timeline',
        resourceType: 'audit_log',
      })
  );
