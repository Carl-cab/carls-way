import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { adminContextStorage } from '@/lib/rbac/admin-middleware';
import { ROLE_PERMISSIONS } from '@/lib/rbac/types';
import type { AdminContext, AdminRole, AdminUser } from '@/lib/rbac/types';

const verification = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rate-limit', () => ({
  verifyRateLimitBackend: verification,
}));

import { POST } from '@/app/api/admin/operations/redis-rate-limit/route';
import { redisRateLimitVerificationHandler } from '@/lib/admin-operations/redis-rate-limit-verification';

const REDIS_URL_SENTINEL = 'redis://operator:never-return-this-secret@redis.example.test:6379/0';

function context(role: AdminRole): AdminContext {
  const admin: AdminUser = {
    id: 1,
    email: 'ops@example.test',
    name: 'Operations Admin',
    password_hash: 'not-used',
    role,
    status: 'active',
    failed_login_attempts: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  return {
    adminUser: admin,
    sessionId: 'test-session',
    permissions: ROLE_PERMISSIONS[role],
  };
}

function request(): NextRequest {
  const base = new Request('https://manna.example.test/api/admin/operations/redis-rate-limit', {
    method: 'POST',
  });
  // A plain Request has no NextRequest.cookies API. The route's auth wrapper
  // reads it before considering the Authorization header, so provide the
  // minimal empty cookie facade an anonymous Next request would have.
  return Object.assign(base, {
    cookies: { get: () => undefined },
  }) as NextRequest;
}

beforeEach(() => {
  process.env.REDIS_URL = REDIS_URL_SENTINEL;
  verification.mockResolvedValue({
    configured: true,
    reachable: true,
    activeBackend: 'redis',
    verification: 'set_get_delete',
    cleanup: 'confirmed',
  });
});

afterEach(() => {
  delete process.env.REDIS_URL;
  vi.clearAllMocks();
});

describe('staff-only Redis rate-limit verification handler', () => {
  it('rejects an anonymous public request before the verification can disclose configuration', async () => {
    const response = await POST(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(verification).not.toHaveBeenCalled();
  });

  it('fails closed without an admin context and does not run a check', async () => {
    const response = await redisRateLimitVerificationHandler(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(verification).not.toHaveBeenCalled();
  });

  it('rejects an authenticated but under-privileged administrator', async () => {
    const response = await adminContextStorage.run(
      context('FinancialInvestigator'),
      () => redisRateLimitVerificationHandler(request()),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    expect(verification).not.toHaveBeenCalled();
  });

  it('allows OperationsAdmin and returns the non-secret verification summary', async () => {
    const response = await adminContextStorage.run(
      context('OperationsAdmin'),
      () => redisRateLimitVerificationHandler(request()),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      verification: {
        configured: true,
        reachable: true,
        activeBackend: 'redis',
        verification: 'set_get_delete',
        cleanup: 'confirmed',
      },
    });
    expect(JSON.stringify(body)).not.toContain(REDIS_URL_SENTINEL);
    expect(verification).toHaveBeenCalledOnce();
  });
});
