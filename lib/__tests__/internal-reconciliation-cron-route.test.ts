import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getSql: vi.fn(),
  reconcile: vi.fn(),
  reconcileExternal: vi.fn(),
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
vi.mock('@/lib/external-settlement-reconciliation', () => ({
  reconcileExternalSettlements: mocks.reconcileExternal,
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
const passingExternal = {
  passed: true,
  checks: [{ checkName: 'provider_events_missing_intent', observedCount: 0, discrepancyCount: 0, status: 'PASS' as const }],
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
    mocks.reconcileExternal.mockResolvedValue(passingExternal);
  });

  it('keeps exactly one Vercel cron schedule (the combined reconciliation route)', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(vercel.crons).toEqual([{ path: '/api/cron/internal-reconciliation', schedule: '0 15 * * *' }]);
  });

  it('fails closed before any database access when CRON_SECRET is absent', async () => {
    mocks.authorize.mockReturnValue('misconfigured');

    const response = await GET(cronRequest());

    expect(response.status).toBe(503);
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.reconcileExternal).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request before any database access', async () => {
    mocks.authorize.mockReturnValue('unauthorized');

    const response = await GET(cronRequest());

    expect(response.status).toBe(401);
    expect(mocks.getSql).not.toHaveBeenCalled();
    expect(mocks.reconcileExternal).not.toHaveBeenCalled();
  });

  it('records a passing aggregate audit record and returns success', async () => {
    mocks.authorize.mockReturnValue('authorized');
    const executor = mockTransaction();
    mocks.reconcile.mockResolvedValue(passingResult);

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...passingResult, external: passingExternal });
    expect(mocks.reconcile).toHaveBeenCalledWith(executor);
    expect(mocks.reconcileExternal).toHaveBeenCalledWith(executor);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls.map((call) => call[1])).toEqual([
      'internal_reconciliation_passed', 'external_settlement_reconciliation_passed',
    ]);
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
    await expect(response.json()).resolves.toEqual({ ...failingResult, external: passingExternal });
    expect(mocks.reconcile).toHaveBeenCalledWith(executor);
    expect(mocks.reconcileExternal).toHaveBeenCalledWith(executor);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor.mock.calls[0][1]).toBe('internal_reconciliation_failed');
  });

  it('alerts on external discrepancies and never exposes raw provider data', async () => {
    mocks.authorize.mockReturnValue('authorized');
    const executor = mockTransaction();
    mocks.reconcile.mockResolvedValue(passingResult);
    mocks.reconcileExternal.mockResolvedValue({ ...passingExternal, passed: false,
      checks: [{ ...passingExternal.checks[0], status: 'FAIL', discrepancyCount: 1 }] });
    const response = await GET(cronRequest());
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('provider_events_missing_intent');
    expect(body).not.toMatch(/raw_payload|last_error|processing_error|secret/i);
    expect(executor.mock.calls[1][1]).toBe('external_settlement_reconciliation_failed');
  });

  it('sanitizes an infrastructure exception instead of exposing the SQL error', async () => {
    mocks.authorize.mockReturnValue('authorized');
    mockTransaction();
    mocks.reconcile.mockRejectedValue(new Error('postgres://hidden:secret@private'));
    const response = await GET(cronRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Reconciliation failed' });
  });
});
