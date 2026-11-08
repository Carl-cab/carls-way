/**
 * `money:send` and request-accept — the velocity status contract.
 *
 * Decision 0008 moved velocity admission inside each money transaction, which
 * meant a `VelocityLimitError` now travels *out of* `sql.begin` and has to be
 * recognised by the same `catch (txErr)` block that handles
 * `INSUFFICIENT_BALANCE` and `ALREADY_PROCESSED`. Those two branches are new
 * code on paths that had no route test at all, and getting one wrong is not a
 * cosmetic failure:
 *
 *   - fall through to the generic rethrow and the caller gets **500**, which
 *     says "the system is broken" when the truth is "you have hit your
 *     ceiling". A client that cannot tell those apart retries immediately.
 *   - match too broadly and a real fault is reported as the caller's fault.
 *
 * `split-pay-route-status.test.ts` covers the third path. This file covers the
 * other two, so all three money paths answer **429** for one condition.
 *
 * Pure route tests, no database: what is under examination is the mapping from
 * a thrown error to an HTTP status, and whether the error escapes the
 * transaction at all.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  auditLog: vi.fn(),
  admitVelocity: vi.fn(),
  checkRateLimit: vi.fn(),
  createNotification: vi.fn(),
  buildFxQuote: vi.fn(),
  createLedgerPair: vi.fn(),
  createCrossBorderLedgerPair: vi.fn(),
  sqlTag: vi.fn() as ReturnType<typeof vi.fn> & { begin?: unknown },
}));

// The real VelocityLimitError, so each route's `instanceof` check behaves as
// it does in production; only the functions the routes call are replaced.
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getAuthUser: mocks.getAuthUser,
  auditLog: mocks.auditLog,
  admitVelocity: mocks.admitVelocity,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitHeaders: () => ({}),
}));
vi.mock('@/lib/notifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('@/lib/fx', () => ({ buildFxQuote: mocks.buildFxQuote }));
vi.mock('@/lib/ledger', () => ({
  createLedgerPair: mocks.createLedgerPair,
  createCrossBorderLedgerPair: mocks.createCrossBorderLedgerPair,
}));
vi.mock('@/lib/db', () => ({ getSql: () => mocks.sqlTag }));

const { VelocityLimitError } = await import('../auth');
const { POST: sendPost } = await import('@/app/api/transactions/route');
const { PATCH: requestPatch } = await import('@/app/api/transactions/[id]/route');

/**
 * Stands in for the `sql.begin` the routes use. The callback runs with a
 * tagged-template `tx`, so admission is reached and its error propagates out
 * of `begin` exactly as postgres.js would let it — which is the behaviour
 * these tests are actually about.
 */
function installSqlBegin() {
  const tx = vi.fn().mockResolvedValue([{ id: 1 }]);
  (mocks.sqlTag as unknown as { begin: unknown }).begin = vi.fn(
    (cb: (t: unknown) => unknown) => Promise.resolve(cb(tx)),
  );
  return tx;
}

function jsonRequest(body: unknown) {
  return new Request('https://manna.example.test/api/transactions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as NextRequest;
}

const SENDER = {
  id: 9112, username: 'velpayer', balance: '500.00',
  balance_cad: '500.00', balance_usd: '0.00', country: 'CA', kyc_status: 'verified',
};
const RECEIVER = {
  id: 9111, username: 'velcreator', balance: '0.00',
  balance_cad: '0.00', balance_usd: '0.00', country: 'CA', kyc_status: 'verified',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthUser.mockResolvedValue({ userId: SENDER.id, username: SENDER.username });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  mocks.admitVelocity.mockResolvedValue(undefined);
});

describe('POST /api/transactions (money:send) velocity status contract', () => {
  function stubSendQueries() {
    mocks.sqlTag
      .mockResolvedValueOnce([SENDER])    // sender lookup
      .mockResolvedValueOnce([RECEIVER])  // receiver lookup
      .mockResolvedValue([{ id: 1 }]);    // anything after
    return installSqlBegin();
  }

  it('answers 429 when the velocity ceiling is hit, not 500', async () => {
    stubSendQueries();
    mocks.admitVelocity.mockRejectedValueOnce(
      new VelocityLimitError('Hourly limit of CAD 500 exceeded'),
    );

    const res = await sendPost(jsonRequest({
      receiverUsername: RECEIVER.username, amount: '40.00', type: 'pay',
    }));

    expect(res.status).toBe(429);
    const body = await res.json();
    // The reason reaches the caller: "slow down" and "we are broken" must not
    // look the same to a client deciding whether to retry.
    expect(body.error).toMatch(/limit/i);
  });

  it('admits inside the transaction, so a refusal moves no money', async () => {
    const tx = stubSendQueries();
    mocks.admitVelocity.mockRejectedValueOnce(new VelocityLimitError('nope'));

    await sendPost(jsonRequest({
      receiverUsername: RECEIVER.username, amount: '40.00', type: 'pay',
    }));

    // Admission ran on the transaction's executor, and nothing else did: the
    // debit statement is after it and was never reached. If admission were
    // still outside `sql.begin`, `tx` would hold no calls for a different
    // reason, so the executor identity is asserted too.
    expect(mocks.admitVelocity).toHaveBeenCalledWith(SENDER.id, 4000, 'CAD', tx);
    expect(tx).not.toHaveBeenCalled();
    expect(mocks.createLedgerPair).not.toHaveBeenCalled();
    // And no notification told the recipient about money that never moved.
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('still reports an insufficient balance as 400, not 429', async () => {
    // The two branches sit in the same catch block; a regression that matched
    // the wrong one first would be invisible without this.
    stubSendQueries();
    installSqlBegin();
    (mocks.sqlTag as unknown as { begin: unknown }).begin = vi.fn(() =>
      Promise.reject(new Error('INSUFFICIENT_BALANCE')),
    );

    const res = await sendPost(jsonRequest({
      receiverUsername: RECEIVER.username, amount: '40.00', type: 'pay',
    }));

    expect(res.status).toBe(400);
  });

  it('does not report an unexpected transaction failure as a 4xx', async () => {
    stubSendQueries();
    (mocks.sqlTag as unknown as { begin: unknown }).begin = vi.fn(() =>
      Promise.reject(new Error('connection terminated unexpectedly')),
    );

    const res = await sendPost(jsonRequest({
      receiverUsername: RECEIVER.username, amount: '40.00', type: 'pay',
    }));

    // Decision 0007 requires a money path to fail closed when velocity cannot
    // be evaluated; such a failure arrives here, and calling it 400 would tell
    // the caller to fix a request that was fine.
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/transactions/[id] (request accept) velocity status contract', () => {
  const REQUEST_ROW = {
    id: 77, sender_id: SENDER.id, receiver_id: RECEIVER.id, amount: '40.00',
    sender_currency: 'CAD', receiver_currency: 'CAD', is_cross_border: false,
  };

  function patchRequest() {
    return new Request('https://manna.example.test/api/transactions/77', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'accept' }),
      headers: { 'content-type': 'application/json' },
    }) as NextRequest;
  }

  const params = () => Promise.resolve({ id: '77' });

  beforeEach(() => {
    mocks.sqlTag
      .mockResolvedValueOnce([REQUEST_ROW])  // the pending request
      .mockResolvedValue([{ id: 1 }]);
  });

  it('answers 429 when the payer has hit their ceiling', async () => {
    installSqlBegin();
    mocks.admitVelocity.mockRejectedValueOnce(
      new VelocityLimitError('Daily limit of CAD 1,000 exceeded'),
    );

    const res = await requestPatch(patchRequest(), { params: params() });

    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/limit/i);
  });

  it('admits on the transaction and leaves the request unpaid when refused', async () => {
    const tx = installSqlBegin();
    mocks.admitVelocity.mockRejectedValueOnce(new VelocityLimitError('nope'));

    await requestPatch(patchRequest(), { params: params() });

    expect(mocks.admitVelocity).toHaveBeenCalledWith(SENDER.id, 4000, 'CAD', tx);
    expect(tx).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('keeps 409 for an already-processed request', async () => {
    (mocks.sqlTag as unknown as { begin: unknown }).begin = vi.fn(() =>
      Promise.reject(new Error('ALREADY_PROCESSED')),
    );

    const res = await requestPatch(patchRequest(), { params: params() });

    expect(res.status).toBe(409);
  });
});
