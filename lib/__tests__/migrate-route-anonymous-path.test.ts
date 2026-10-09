/**
 * The control flow of GET /api/migrate on its anonymous paths.
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
import type { NextRequest } from 'next/server';

const getAuthUser = vi.hoisted(() => vi.fn());
const anonymousRecoveryMode = vi.hoisted(() => vi.fn());
const repairAuthCriticalColumns = vi.hoisted(() => vi.fn());
const initializeSchema = vi.hoisted(() => vi.fn());
const upgradeLegacyMoneyColumns = vi.hoisted(() => vi.fn());
const checkRateLimit = vi.hoisted(() => vi.fn());

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

import { GET } from '@/app/api/migrate/route';

function request(): NextRequest {
  return new Request('https://manna.example.test/api/migrate') as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 2, limit: 3, resetAt: Date.now() });
  repairAuthCriticalColumns.mockResolvedValue(['token_version']);
  initializeSchema.mockResolvedValue(undefined);
  upgradeLegacyMoneyColumns.mockResolvedValue([]);
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
    const res = await GET(request());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      repair: true,
      columnsRestored: ['token_version'],
    });
    expect(repairAuthCriticalColumns).toHaveBeenCalledTimes(1);
  });

  it('never runs the full pipeline', async () => {
    await GET(request());

    // The assertion the defect would fail. Both of these ran anonymously
    // against live customer data before.
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(upgradeLegacyMoneyColumns).not.toHaveBeenCalled();
  });

  it('is still rate limited', async () => {
    await GET(request());
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('returns 429 without repairing when the limit is spent', async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, limit: 3, resetAt: Date.now() });

    const res = await GET(request());

    expect(res.status).toBe(429);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
    expect(initializeSchema).not.toHaveBeenCalled();
  });

  it('reports plainly when there was nothing to repair', async () => {
    repairAuthCriticalColumns.mockResolvedValue([]);

    const res = await GET(request());

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
    await GET(request());

    expect(initializeSchema).toHaveBeenCalledTimes(1);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
  });
});

describe('anonymous caller with no recovery warranted', () => {
  it('is rejected with 401 and touches nothing', async () => {
    getAuthUser.mockResolvedValue(null);
    anonymousRecoveryMode.mockResolvedValue(null);

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
    expect(initializeSchema).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('authenticated caller', () => {
  it('gets the full pipeline and is not diverted to the repair path', async () => {
    getAuthUser.mockResolvedValue({ userId: 1, email: 'ops@example.test', username: 'ops' });

    await GET(request());

    expect(initializeSchema).toHaveBeenCalledTimes(1);
    expect(repairAuthCriticalColumns).not.toHaveBeenCalled();
    // An authenticated caller is not subject to the anonymous window at all.
    expect(anonymousRecoveryMode).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
