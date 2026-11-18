/**
 * Restricted internal beta — the three withheld capabilities, and the
 * bypass attempts.
 *
 * The owner approved a P2P-only internal sandbox beta (2026-11-18) and
 * required funding, cash-out and cross-currency payments disabled
 * SERVER-SIDE, with direct API bypass attempts tested. This file is that
 * test: every case calls a real route handler, because a restriction that
 * only holds in the interface is not a restriction.
 *
 * WHAT EACH CAPABILITY IS WITHHELD FOR, since they are not interchangeable
 * and a future reader may be tempted to re-enable one:
 *
 *   funding         — no capacity control exists. Decision 0013 is that
 *                     control and is blocked on independent validation.
 *                     Measured: CA$1,850 funded across five confirmations
 *                     against an approved CA$100 cumulative ceiling.
 *   cash_out        — design-blocked in CLAUDE.md, yet fully reachable:
 *                     measured, a sandbox cash_out of CA$500 settled and
 *                     debited a balance.
 *   cross_currency  — excluded from every per-payment reconciliation
 *                     invariant, so it is money movement no control examines.
 *
 * THE RESOLUTION RULE THIS PINS. Sandbox defaults to RESTRICTED. Forgetting
 * `MANNA_BETA_PROFILE` leaves a beta restricted rather than open, which is
 * the opposite posture from an opt-in flag and is the point of the design.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function sandbox() {
  process.env.MANNA_ENV = 'sandbox';
  delete process.env.VERCEL_ENV;
  delete process.env.MANNA_BETA_PROFILE;
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('profile resolution', () => {
  it('sandbox defaults to RESTRICTED with no variable set', async () => {
    sandbox();
    const { betaProfile, isRestrictedBeta } = await import('../beta-restrictions');
    expect(betaProfile()).toBe('p2p_only');
    expect(isRestrictedBeta()).toBe(true);
  });

  it('an unrecognised value in sandbox still resolves to RESTRICTED', async () => {
    // A typo must fail safe where the beta runs. This is the case an opt-in
    // flag gets wrong.
    sandbox();
    process.env.MANNA_BETA_PROFILE = 'p2ponly';
    const { betaProfile } = await import('../beta-restrictions');
    expect(betaProfile()).toBe('p2p_only');
  });

  it('requires an EXPLICIT opt-out to lift the restriction in sandbox', async () => {
    sandbox();
    process.env.MANNA_BETA_PROFILE = 'unrestricted';
    const { betaProfile } = await import('../beta-restrictions');
    expect(betaProfile()).toBe('unrestricted');
  });

  it('restricts nothing in production, where the live-rail flags govern instead', async () => {
    // Scoped deliberately: this is a beta control and must not be read as
    // standing in for PLAID_TRANSFER_LIVE / CA_EFT_LIVE or decision 0010.
    delete process.env.MANNA_ENV;
    delete process.env.MANNA_BETA_PROFILE;
    const { isRestrictedBeta } = await import('../beta-restrictions');
    expect(isRestrictedBeta()).toBe(false);
  });

  it('applies in production when explicitly asked for', async () => {
    delete process.env.MANNA_ENV;
    process.env.MANNA_BETA_PROFILE = 'p2p_only';
    const { isRestrictedBeta } = await import('../beta-restrictions');
    expect(isRestrictedBeta()).toBe(true);
  });

  it('VERCEL_ENV=production makes the environment production, so sandbox default does not apply', async () => {
    process.env.MANNA_ENV = 'sandbox';
    process.env.VERCEL_ENV = 'production';
    delete process.env.MANNA_BETA_PROFILE;
    const { isRestrictedBeta } = await import('../beta-restrictions');
    expect(isRestrictedBeta()).toBe(false);
  });
});

describe('direct API bypass attempts — POST /api/transfers/intent', () => {
  /**
   * Authentication and the database are mocked because the subject is the
   * GATE, not the transfer machinery. Each case asserts both the status AND
   * that nothing downstream was reached — a 403 that still wrote a row would
   * pass a status-only assertion.
   */
  async function intentRoute() {
    // The spy is the TAGGED TEMPLATE, not getSql(). getSql() merely returns
    // the handle and is called before any query runs, so asserting on it
    // proved nothing — corrected after it failed for that reason.
    const sqlTag = vi.fn();
    const getSql = vi.fn(() => sqlTag);
    vi.doMock('../auth', () => ({
      getAuthUser: vi.fn().mockResolvedValue({ userId: 1, email: 'a@b.test', username: 'u' }),
      checkVelocityLimit: vi.fn(),
      auditLog: vi.fn(),
    }));
    vi.doMock('../db', () => ({ getSql }));
    vi.doMock('../rate-limit', () => ({
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
      rateLimitHeaders: () => ({}),
    }));
    const mod = await import('../../app/api/transfers/intent/route');
    return { POST: mod.POST, sqlTag };
  }

  function req(body: Record<string, unknown>) {
    return new Request('http://localhost/api/transfers/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never;
  }

  it('refuses add_money with 403 BETA_RESTRICTED and touches no database', async () => {
    sandbox();
    const { POST, sqlTag } = await intentRoute();

    const res = await POST(req({ type: 'add_money', amount: 50, currency: 'CAD' }));
    const body = (await res.json()) as { code?: string; capability?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('BETA_RESTRICTED');
    expect(body.capability).toBe('funding');
    // No query ran at all: the gate sits ahead of every database read, so a
    // withheld capability creates no intent to clean up.
    expect(sqlTag).not.toHaveBeenCalled();
  });

  it('refuses cash_out with 403 BETA_RESTRICTED and touches no database', async () => {
    sandbox();
    const { POST, sqlTag } = await intentRoute();

    const res = await POST(req({ type: 'cash_out', amount: 500, currency: 'CAD' }));
    const body = (await res.json()) as { code?: string; capability?: string };

    expect(res.status).toBe(403);
    expect(body.capability).toBe('cash_out');
    expect(sqlTag).not.toHaveBeenCalled();
  });

  it('is not bypassed by casing, whitespace or an unexpected extra field', async () => {
    // The gate reads the route's own validated `type`, not a client-chosen
    // string, so none of these reach it as something else.
    sandbox();
    const { POST } = await intentRoute();

    for (const body of [
      { type: 'ADD_MONEY', amount: 50, currency: 'CAD' },
      { type: ' add_money ', amount: 50, currency: 'CAD' },
      { type: 'add_money', amount: 50, currency: 'CAD', betaProfile: 'unrestricted' },
      { type: 'add_money', amount: 50, currency: 'CAD', MANNA_BETA_PROFILE: 'unrestricted' },
    ]) {
      const res = await POST(req(body));
      // 400 for the two that fail type validation first, 403 for the two
      // that reach the gate. What must never happen is 201.
      expect([400, 403]).toContain(res.status);
      expect(res.status).not.toBe(201);
    }
  });

  it('allows both types when the profile is explicitly unrestricted', async () => {
    // The restriction must be the profile's doing and not an unconditional
    // block, or this file would pass against a route that refused everything.
    sandbox();
    process.env.MANNA_BETA_PROFILE = 'unrestricted';
    const { POST } = await intentRoute();

    const res = await POST(req({ type: 'add_money', amount: 50, currency: 'CAD' }));
    // Past the gate: it now fails further down on the mocked database rather
    // than at the restriction.
    expect(res.status).not.toBe(403);
  });
});

describe('direct API bypass attempts — POST /api/transfers/[id]/confirm', () => {
  /**
   * Defence in depth, and NOT redundant with the intent gate. Confirm is
   * where the money moves. An intent created while the profile was
   * unrestricted — or before the restriction was deployed — would otherwise
   * still settle, and that is the realistic bypass: not a crafted request,
   * but a stale draft.
   */
  it('refuses to confirm a pre-existing add_money draft with 403', async () => {
    sandbox();

    const rows = [{ provider_region: 'CA', execution_mode: 'sandbox', status: 'draft', type: 'add_money' }];
    const sqlTag = vi.fn().mockResolvedValue(rows);
    const confirmTransfer = vi.fn();

    vi.doMock('../auth', () => ({
      getAuthUser: vi.fn().mockResolvedValue({ userId: 1, email: 'a@b.test', username: 'u' }),
    }));
    vi.doMock('../db', () => ({ getSql: () => sqlTag }));
    vi.doMock('../transfers/router', () => ({
      getTransferProvider: () => ({ confirmTransfer }),
      toExecutionMode: (m: string) => m,
    }));

    const { POST } = await import('../../app/api/transfers/[id]/confirm/route');
    const res = await POST(
      new Request('http://localhost/api/transfers/1/confirm', { method: 'POST' }) as never,
      { params: Promise.resolve({ id: '1' }) } as never,
    );
    const body = (await res.json()) as { code?: string; capability?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('BETA_RESTRICTED');
    expect(body.capability).toBe('funding');
    // The decisive assertion: the provider was never asked to settle, so no
    // balance moved and no ledger entry was written.
    expect(confirmTransfer).not.toHaveBeenCalled();
  });
});

describe('direct API bypass attempts — cross-currency payment', () => {
  /**
   * The gate reads the two users' `country` columns, so a caller cannot
   * present themselves as same-currency. That is what makes it
   * server-enforced rather than a client-side convenience.
   */
  it('refuses a CA -> US payment with 403 and admits no velocity', async () => {
    sandbox();

    const admitVelocity = vi.fn();
    const buildFxQuote = vi.fn();
    const begin = vi.fn();

    const sqlTag = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      // The route issues TWO separate user lookups — sender by id, receiver
      // by username — so they must be answered separately. Returning both
      // rows to either query made the receiver resolve to the sender and the
      // route answered 400 "Cannot send to yourself", never reaching the
      // gate under test.
      if (text.includes('FROM users') && text.includes('WHERE id =')) {
        return Promise.resolve([
          { id: 1, username: 'sender', country: 'CA', balance_cad: '500.00', balance_usd: '0.00' },
        ]);
      }
      if (text.includes('FROM users') && text.includes('WHERE username =')) {
        // Receiver in the US: a genuine cross-currency pair, derived from the
        // country columns rather than anything the caller supplied.
        return Promise.resolve([
          { id: 2, username: 'receiver', country: 'US', balance_cad: '0.00', balance_usd: '0.00' },
        ]);
      }
      return Promise.resolve([]);
    }) as ReturnType<typeof vi.fn> & { begin?: unknown };
    sqlTag.begin = begin;

    vi.doMock('../auth', () => ({
      getAuthUser: vi.fn().mockResolvedValue({ userId: 1, email: 'a@b.test', username: 'sender' }),
      admitVelocity,
      VelocityLimitError: class extends Error {},
      auditLog: vi.fn(),
      sanitizeString: (v: string) => v,
    }));
    vi.doMock('../db', () => ({ getSql: () => sqlTag }));
    vi.doMock('../fx', () => ({ buildFxQuote }));
    vi.doMock('../rate-limit', () => ({
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
      rateLimitHeaders: () => ({}),
    }));
    vi.doMock('../notifications', () => ({ createNotification: vi.fn() }));

    const { POST } = await import('../../app/api/transactions/route');
    const res = await POST(
      new Request('http://localhost/api/transactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ receiverUsername: 'receiver', amount: 10, type: 'pay' }),
      }) as never,
    );
    const body = (await res.json()) as { code?: string; capability?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('BETA_RESTRICTED');
    expect(body.capability).toBe('cross_currency');

    // Three things that must NOT have happened, each asserted rather than
    // assumed: no FX rate requested, no velocity budget consumed, and no
    // money transaction opened.
    expect(buildFxQuote).not.toHaveBeenCalled();
    expect(admitVelocity).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });
});

describe('the interface and the routes read one resolver', () => {
  it('betaRestrictionState() agrees with the enforcement helpers', async () => {
    // A separate UI-side constant would be free to drift. A page that hid a
    // button the API still honoured would merely LOOK controlled, which is
    // worse than no restriction.
    sandbox();
    const { betaRestrictionState, isCapabilityRestricted } = await import('../beta-restrictions');
    const state = betaRestrictionState();

    expect(state.restricted).toBe(true);
    expect(state.capabilities.funding).toBe(!isCapabilityRestricted('funding'));
    expect(state.capabilities.cash_out).toBe(!isCapabilityRestricted('cash_out'));
    expect(state.capabilities.cross_currency).toBe(!isCapabilityRestricted('cross_currency'));
    expect(state.capabilities).toEqual({
      funding: false,
      cash_out: false,
      cross_currency: false,
    });
  });
});
