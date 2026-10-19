/**
 * The control flow of POST /api/migrate on its anonymous paths.
 *
 * The companion file lib/__tests__/anonymous-schema-repair.test.ts covers the
 * repair helper against a real database. That is not enough on its own: the
 * helper never ran the pipeline, so asserting it doesn't proves nothing about
 * the defect. The defect was in the ROUTE — it decided an anonymous caller on a
 * populated database was entitled to the whole pipeline.
 *
 * So these mock the schema layer and assert what the handler actually invokes.
 * `initializeSchema` and `upgradeLegacyMoneyColumns` must not be called at all
 * on the repair path, and a test that only inspected the response body would
 * pass while both still ran.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getAuthUser = vi.hoisted(() => vi.fn());
const anonymousRecoveryMode = vi.hoisted(() => vi.fn());
const repairAuthCriticalColumns = vi.hoisted(() => vi.fn());
const initializeSchema = vi.hoisted(() => vi.fn());
const upgradeLegacyMoneyColumns = vi.hoisted(() => vi.fn());
const checkRateLimit = vi.hoisted(() => vi.fn());
const resolveAdminBySessionId = vi.hoisted(() => vi.fn());
const recordConvergenceRun = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  anonymousRecoveryMode,
  repairAuthCriticalColumns,
  initializeSchema,
  upgradeLegacyMoneyColumns,
  // The pipeline issues its statements through this; a thrower would make a
  // leaked pipeline look like an error rather than the silent success it was.
  getSql: () => {
    const tag = () => Promise.resolve([]);
    (tag as unknown as { unsafe: unknown }).unsafe = () => Promise.resolve([]);
    return tag;
  },
}));

vi.mock('@/lib/auth', () => ({
  getAuthUser,
  auditLog: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit,
  clientIdentifier: () => '203.0.113.7',
  rateLimitHeaders: () => ({}),
}));

vi.mock('@/lib/rbac/admin-middleware', () => ({
  resolveAdminBySessionId,
}));

vi.mock('@/lib/migrations/tracking', () => ({
  recordConvergenceRun,
}));

import { POST } from '@/app/api/migrate/route';

function request(adminSession?: string): NextRequest {
  return new NextRequest('https://manna.example.test/api/migrate', {
    // POST, because that is the only method the route accepts. The handler
    // does not inspect req.method, so a GET-shaped fixture passes anyway —
    // which is precisely why it should not be left wrong.
    method: 'POST',
    headers: adminSession ? { cookie: `admin_session=${adminSession}` } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 2, limit: 3, resetAt: Date.now() });
  repairAuthCriticalColumns.mockResolvedValue(['token_version']);
  recordConvergenceRun.mockResolvedValue(undefined);
  initializeSchema.mockResolvedValue(undefined);
  upgradeLegacyMoneyColumns.mockResolvedValue([]);
  resolveAdminBySessionId.mockResolvedValue(null);
});

afterEach(() => {
  vi.resetModules();
});

describe('anonymous caller on a populated database (auth-repair)', () => {
  beforeEach(() => {
    getAuthUser.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue('auth-repair');
  });

  it('repairs the auth columns', async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      repair: true,
      columnsRestored: ['token_version'],
    });
    expect(repairAuthCriticalColumns).toHaveBeenCalledTimes(1);
  });

  it('never runs the full pipeline', async () => {
    await POST(request());

    // The assertion the defect would fail. Both of these ran anonymously
    // against live customer data before.
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(upgradeLegacyMoneyColumns).not.toHaveBeenCalled();
  });

  it('is still rate limited', async () => {
    await POST(request());
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('returns 429 without repairing when the limit is spent', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, limit: 3, resetAt: Date.now() });

    const res = await POST(request());

    expect(res.status).toBe(429);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
    expect(initializeSchema).not.toHaveBeenCalled();
  });

  it('reports plainly when there was nothing to repair', async () => {
    repairAuthCriticalColumns.mockResolvedValue([]);

    const res = await POST(request());

    await expect(res.json()).resolves.toMatchObject({ success: true, repair: true });
    expect(initializeSchema).not.toHaveBeenCalled();
  });
});

describe('anonymous caller on an empty database (full-bootstrap)', () => {
  beforeEach(() => {
    getAuthUser.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue('full-bootstrap');
  });

  it('runs the pipeline, because creating the schema is the only way out', async () => {
    // Narrowing the populated case must not strand a genuinely new deployment —
    // that would recreate the deadlock this window exists to break.
    await POST(request());

    expect(initializeSchema).toHaveBeenCalledTimes(1);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
  });
});

describe('anonymous caller with no recovery warranted', () => {
  it('is rejected with 401 and touches nothing', async () => {
    getAuthUser.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue(null);

    const res = await POST(request());

    expect(res.status).toBe(401);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('authenticated customer', () => {
  it('is refused with 403 and the pipeline does not run', async () => {
    getAuthUser.mockResolvedValue({ userId: 1, email: 'customer@example.test', username: 'customer' });

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(upgradeLegacyMoneyColumns).not.toHaveBeenCalled();
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
    expect(anonymousRecoveryMode).not.toHaveBeenCalled();
  });
});

describe('administrator', () => {
  it('runs the full pipeline for an operations administrator', async () => {
    getAuthUser.mockResolvedValue(null);
    resolveAdminBySessionId.mockResolvedValue({
      id: 7,
      role: 'SuperAdmin',
      status: 'active',
      email: 'ops@example.test',
      name: 'Ops',
    });

    const res = await POST(request('session.token'));

    expect(res.status).toBe(200);
    expect(initializeSchema).toHaveBeenCalledTimes(1);
    expect(upgradeLegacyMoneyColumns).toHaveBeenCalledTimes(1);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
    expect(anonymousRecoveryMode).not.toHaveBeenCalled();
    // Phase 1 added a limiter to the operator path, which previously had none.
    // Keyed on the admin id, so the assertion names it rather than just
    // counting calls — a limiter keyed on something else would be a different
    // control.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith('schema:migrate-operator', '7');
  });

  it('refuses a read-only administrator', async () => {
    getAuthUser.mockResolvedValue(null);
    resolveAdminBySessionId.mockResolvedValue({
      id: 8,
      role: 'ReadOnlyAuditor',
      status: 'active',
      email: 'audit@example.test',
      name: 'Audit',
    });

    const res = await POST(request('session.token'));

    expect(res.status).toBe(403);
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(upgradeLegacyMoneyColumns).not.toHaveBeenCalled();
  });
});

describe('convergence recording is scoped to runs that actually began', () => {
  /**
   * `recordConvergenceRun('failed', …)` writes status 'failed' on the fixed id
   * `convergent_api_migrate`, and 'failed' is in BLOCKING_STATUSES — so
   * `assertSafeToProceed()` would refuse every financial migration until
   * someone reran this route successfully. Recording it for an error that
   * never reached the pipeline turns an unrelated transient fault into a
   * migration freeze. These assert the flag that prevents that.
   */

  it('does not record a failed run when the error precedes the pipeline', async () => {
    // A Redis problem inside the rate limiter: nothing has touched the schema.
    getAuthUser.mockResolvedValue(null);
    resolveAdminBySessionId.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue('full-bootstrap');
    checkRateLimit.mockRejectedValue(new Error('redis unavailable'));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(recordConvergenceRun).not.toHaveBeenCalled();
  });

  it('does not record a failed run when the anonymous repair path fails', async () => {
    // The repair path returns without running the reconciler at all, so a
    // failure in it says nothing about whether the schema is converged.
    getAuthUser.mockResolvedValue(null);
    resolveAdminBySessionId.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue('auth-repair');
    repairAuthCriticalColumns.mockRejectedValue(new Error('column repair failed'));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(recordConvergenceRun).not.toHaveBeenCalled();
  });

  it('does record a failed run once the pipeline has started', async () => {
    getAuthUser.mockResolvedValue(null);
    resolveAdminBySessionId.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue('full-bootstrap');
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 2, limit: 3, resetAt: Date.now() });
    initializeSchema.mockRejectedValue(new Error('DDL blew up mid-pipeline'));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(initializeSchema).toHaveBeenCalled();
    expect(recordConvergenceRun).toHaveBeenCalledWith(
      'failed',
      expect.any(String),
      expect.any(String),
    );
  });

  it('attributes a mid-pipeline failure to the operator, not a generic label', async () => {
    // The identity is resolved long before the pipeline but was previously
    // assigned only on the success path, so a failure *during* the pipeline —
    // precisely the run worth attributing — fell back to 'migrate-route'.
    const admin = { id: 42, role: 'OperationsAdmin' };
    getAuthUser.mockResolvedValue(null);
    resolveAdminBySessionId.mockResolvedValue(admin);
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 5, limit: 6, resetAt: Date.now() });
    initializeSchema.mockRejectedValue(new Error('DDL blew up mid-pipeline'));

    const res = await POST(request('admin-session-token'));

    expect(res.status).toBe(500);
    expect(recordConvergenceRun).toHaveBeenCalledWith(
      'failed',
      'admin:42',
      expect.any(String),
    );
  });

  it('attributes an anonymous bootstrap failure to the bootstrap path', async () => {
    getAuthUser.mockResolvedValue(null);
    resolveAdminBySessionId.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue('full-bootstrap');
    checkRateLimit.mockResolvedValue({ allowed: true, remaining: 2, limit: 3, resetAt: Date.now() });
    initializeSchema.mockRejectedValue(new Error('DDL blew up mid-pipeline'));

    const res = await POST(request());

    expect(res.status).toBe(500);
    expect(recordConvergenceRun).toHaveBeenCalledWith(
      'failed',
      'anonymous-bootstrap',
      expect.any(String),
    );
  });
});
