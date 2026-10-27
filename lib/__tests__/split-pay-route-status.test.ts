/**
 * `POST /api/splits/[id]/pay` — the status contract.
 *
 * `split-pay-velocity.test.ts` calls `paySplitPortion()` directly and asserts
 * the `VELOCITY_EXCEEDED` code. It never goes through the route, so a
 * regression that mapped that code to 400 instead of 429 would leave it green
 * — while `CLAUDE.md` claimed the mapping was pinned. This file closes that
 * gap: one status means one thing across every money path, and `transactions`
 * and `transfers/intent` both answer 429 when the velocity ceiling is hit.
 *
 * Pure route test, no database: the mapping from error code to HTTP status is
 * all that is under examination here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  auditLog: vi.fn(),
  checkRateLimit: vi.fn(),
  paySplitPortion: vi.fn(),
  createNotification: vi.fn(),
  sqlTag: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getAuthUser: mocks.getAuthUser,
  auditLog: mocks.auditLog,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitHeaders: () => ({}),
}));
vi.mock('@/lib/notifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('@/lib/db', () => ({ getSql: () => mocks.sqlTag }));

// The real SplitPaymentError, so the route's `instanceof` check behaves as it
// does in production; only paySplitPortion itself is replaced.
vi.mock('@/lib/splits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../splits')>();
  return { ...actual, paySplitPortion: mocks.paySplitPortion };
});

const { SplitPaymentError } = await import('../splits');
const { POST } = await import('@/app/api/splits/[id]/pay/route');

function request() {
  return new Request('https://manna.example.test/api/splits/1/pay', {
    method: 'POST',
  }) as NextRequest;
}

const params = Promise.resolve({ id: '1' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthUser.mockResolvedValue({ userId: 9112, username: 'velpayer' });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 29 });
  // The route reads the split creator for its notification; one empty result
  // is enough, and the notification path is not what this file tests.
  mocks.sqlTag.mockResolvedValue([]);
});

describe('POST /api/splits/[id]/pay status contract', () => {
  it('maps VELOCITY_EXCEEDED to 429, as every other money path does', async () => {
    mocks.paySplitPortion.mockRejectedValue(
      new SplitPaymentError('VELOCITY_EXCEEDED', 'Hourly limit of CAD 5,000 exceeded'),
    );

    const res = await POST(request(), { params });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('VELOCITY_EXCEEDED');
    // The reason reaches the caller: a client that cannot tell "slow down"
    // from "something is broken" will retry immediately.
    expect(body.error).toMatch(/limit/i);
  });

  it.each([
    ['NOT_PARTICIPANT', 403],
    ['ALREADY_PAID', 409],
    ['SPLIT_CLOSED', 409],
    ['INSUFFICIENT_BALANCE', 400],
  ] as const)('maps %s to %i', async (code, status) => {
    mocks.paySplitPortion.mockRejectedValue(new SplitPaymentError(code, 'x'));

    const res = await POST(request(), { params });

    expect(res.status).toBe(status);
  });

  it('does not leak an internal error as a 4xx', async () => {
    // A non-SplitPaymentError must not be mistaken for a client problem: a
    // velocity-evaluation failure arrives this way (0007 requires the money
    // path to fail closed), and reporting it as 400 would tell the caller to
    // fix their request when the fault is ours.
    mocks.paySplitPortion.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await POST(request(), { params });

    expect(res.status).toBe(500);
  });
});
