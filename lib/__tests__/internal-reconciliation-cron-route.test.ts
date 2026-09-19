import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getSql: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('@/lib/cron-auth', () => ({
  authorizeCronRequest: mocks.authorize,
}));

vi.mock('@/lib/db', () => ({
  getSql: mocks.getSql,
}));

vi.mock('@/lib/internal-reconciliation', () => ({
  reconcileInternalTransactions: mocks.reconcile,
}));

import { GET } from '@/app/api/cron/internal-reconciliation/route';

const passingResult = {
  passed: true,
  checks: [
    {
      checkName: 'payment_ledger_pair_cardinality',
      observedCount: 3,
      discrepancyCount: 0,
      status: 'PASS' as const,
    },
  ],
};

function cronRequest() {
  return new Request('https://manna.example.test/api/cron/internal-reconciliation', {
    headers: {
      authorization: 'Bearer test-secret',
      'x-vercel-cron-schedule': '0 15 * * *',
    },
  }) as NextRequest;
}

function mockTransaction() {
  const executor = vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve([]);
  });
  mocks.getSql.mockReturnValue({
    begin: async (callback: (transaction: unknown) => Promise<unknown>) => callback(executor),
  });
  return executor;
}

describe('GET /api/cron/internal-reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed before any database access when CRON_SECRET is absent', async () => {
    mocks.authorize.mockReturnValue('misconfigured');

    const response = await GET(cronRequest());

    expect(response.status).toBe(503);
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request before any database access', async () => {
    mocks.authorize.mockReturnValue('unauthorized');

    const response = await GET(cronRequest());

    expect(response.status).toBe(401);
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it('records a passing aggregate audit record and returns success', async () => {
    mocks.authorize.mockReturnValue('authorized');
    const executor = mockTransaction();
    mocks.reconcile.mockResolvedValue(passingResult);

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(passingResult);
    expect(mocks.reconcile).toHaveBeenCalledWith(executor);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('returns a non-2xx response when reconciliation finds a discrepancy', async () => {
    mocks.authorize.mockReturnValue('authorized');
    const executor = mockTransaction();
    const failingResult = {
      ...passingResult,
      passed: false,
      checks: [{ ...passingResult.checks[0], discrepancyCount: 1, status: 'FAIL' as const }],
    };
    mocks.reconcile.mockResolvedValue(failingResult);

    const response = await GET(cronRequest());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual(failingResult);
    expect(mocks.reconcile).toHaveBeenCalledWith(executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][1]).toBe('internal_reconciliation_failed');
  });
});
