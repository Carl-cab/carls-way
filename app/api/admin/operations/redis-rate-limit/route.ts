import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog } from '@/lib/rbac';
import { redisRateLimitVerificationHandler } from '@/lib/admin-operations/redis-rate-limit-verification';

/**
 * POST /api/admin/operations/redis-rate-limit
 *
 * Runs an isolated Redis set/get/delete verification for the shared rate-limit
 * backend. This is deliberately an operations-only, audited POST: it performs a
 * harmless ephemeral write and must never become an unauthenticated health
 * signal that reveals whether Redis (or REDIS_URL) is configured.
 */

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (request) =>
    withAuditLog(request, redisRateLimitVerificationHandler, {
      action: 'verify_rate_limit_redis_backend',
      resourceType: 'rate_limit_backend',
    }),
  );
