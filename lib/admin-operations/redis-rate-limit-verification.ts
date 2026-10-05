import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { verifyRateLimitBackend } from '@/lib/rate-limit';

/**
 * Execute the operations-only Redis rate-limit backend verification.
 *
 * This helper is intentionally separate from the App Router route module.
 * Next.js route modules may export only supported HTTP handlers and route
 * configuration, while unit tests need to exercise the permission boundary
 * directly without exporting an unsupported symbol from `route.ts`.
 */
export async function redisRateLimitVerificationHandler(
  request: NextRequest,
): Promise<NextResponse> {
  // Authorization/auditing is supplied by the route wrapper rather than request
  // data. Keep the handler signature compatible with the wrapper contract.
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
