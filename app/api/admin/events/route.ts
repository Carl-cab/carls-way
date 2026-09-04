import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { getAdminProviderEventService } from '@/lib/services';
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
    const provider = searchParams.get('provider');
    const eventType = searchParams.get('event_type');
    const status = searchParams.get('status');
    const correlationId = searchParams.get('correlation_id');
    const startDate = searchParams.get('start_date');
    const endDate = searchParams.get('end_date');

    const service = getAdminProviderEventService();
    const filters = {
      provider: provider || undefined,
      eventType: eventType || undefined,
      status: status || undefined,
      correlationId: correlationId || undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    };

    const result = await service.searchProviderEvents(filters, page, pageSize);
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
        action: 'list_provider_events',
        resourceType: 'provider_event',
      })
  );
