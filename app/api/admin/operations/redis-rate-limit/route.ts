import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { verifyRateLimitBackend } from '@/lib/rate-limit';

/**
 * POST /api/admin/operations/redis-rate-limit
 *
 * Runs an isolated Redis set/get/delete verification for the shared rate-limit
 * backend. This is deliberately an operations-only, audited POST: it performs a
 * harmless ephemeral write and must never become an unauthenticated health
 * signal that reveals whether Redis (or REDIS_URL) is configured.
 */
export async function redisRateLimitVerificationHandler(
  request: NextRequest,
): Promise<NextResponse> {
  // Preserve the standard route-handler contract; authorization/auditing is
  // supplied by the wrapper below rather than from request data here.
  void request;

  try {
    // The check performs a short-lived Redis write, so restrict it to the same
    // operations roles allowed to perform explicitly approved remediation.
    requirePermission('exceptions:manage');

    // The helper deliberately returns only booleans/enums. Do not add URL,
    // hostname, connection errors, or environment values to this response.
    const verification = await verifyRateLimitBackend();
    return NextResponse.json({ verification });
  } catch (error) {
    if (error instanceof Error && error.message.includes('requires the "exceptions:manage" permission')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Verification is designed to absorb Redis errors. Retain this generic
    // boundary in case a future code change fails unexpectedly; never return
    // the underlying exception because provider connection errors may be secret.
    console.error('Redis rate-limit verification failed unexpectedly.');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (request) =>
    withAuditLog(request, redisRateLimitVerificationHandler, {
      action: 'verify_rate_limit_redis_backend',
      resourceType: 'rate_limit_backend',
    }),
  );
