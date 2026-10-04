import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  listDeadLetters: vi.fn(),
  replay: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({
  withAdminAuth: async (request: NextRequest, handler: (request: NextRequest) => Promise<Response>) => handler(request),
  withAuditLog: async (request: NextRequest, handler: (request: NextRequest) => Promise<Response>) => handler(request),
  requirePermission: mocks.requirePermission,
  getCurrentAdmin: () => ({ id: 7 }),
}));
vi.mock('@/lib/webhooks/dlq', () => ({
  listDeadLetters: mocks.listDeadLetters,
}));
vi.mock('@/lib/webhooks/replay', () => ({
  replayDeadLetterForLocalSettlement: mocks.replay,
}));

import { GET, POST } from '@/app/api/admin/webhooks/dead-letters/route';

function request(method: 'GET' | 'POST', body?: unknown) {
  return new Request('https://manna.example.test/api/admin/webhooks/dead-letters', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as NextRequest;
}

describe('admin dead-letter replay route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockImplementation(() => undefined);
  });

  it('denies a caller without the replay permission before a local handler can run', async () => {
    mocks.requirePermission.mockImplementation(() => {
      throw new Error('This action requires the "events:replay" permission');
    });

    const response = await POST(request('POST', { provider: 'stripe', providerEventId: 'evt_1' }));

    expect(response.status).toBe(403);
    expect(mocks.replay).not.toHaveBeenCalled();
  });

  it('lists DLQ operational metadata without exposing raw webhook payloads', async () => {
    mocks.listDeadLetters.mockResolvedValue([{
      id: 1,
      provider: 'stripe',
      providerEventId: 'evt_1',
      eventType: 'payment_intent.succeeded',
      rawPayload: { customer_secret: 'must-not-leak' },
      failureCount: 5,
      lastError: 'retry exhausted',
      createdAt: '2026-01-01T00:00:00.000Z',
      requeuedAt: null,
    }]);

    const response = await GET(request('GET'));
    const body = await response.json() as { deadLetters: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.deadLetters).toHaveLength(1);
    expect(body.deadLetters[0]).not.toHaveProperty('rawPayload');
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });

  it('reports a successful local-only replay without a raw payload in the response', async () => {
    mocks.replay.mockResolvedValue({
      outcome: 'replayed',
      settlementOutcome: 'applied',
      markedProcessed: true,
    });

    const response = await POST(request('POST', { provider: 'stripe', providerEventId: 'evt_1' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      requeued: true,
      localHandler: 'verified_stripe_settlement',
      settlementOutcome: 'applied',
      markedProcessed: true,
    });
    expect(mocks.replay).toHaveBeenCalledWith('stripe', 'evt_1', { requeuedBy: '7' });
  });
});
