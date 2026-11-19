/**
 * Containment: no participant action in the restricted beta reaches an
 * external provider.
 *
 * WHY THIS FILE IS SEPARATE FROM THE STATIC COVERAGE GUARD.
 * `beta-restriction-coverage.test.ts` proves that no route MOVES MONEY without
 * someone having decided what the profile does about it. That is a decision
 * guard, and it is explicitly not evidence of runtime enforcement: it reads
 * source text, so a route that imported `beta-restrictions` and never called
 * it would satisfy it. These cases call the real handlers and assert the
 * refusal AND that the provider client was never touched — because a 403
 * returned AFTER a Plaid or Stripe call has already done the thing the
 * containment claim denies.
 *
 * WHAT IS CONTAINED, AND WHY EACH.
 *   - Plaid link token / token exchange, and the two Stripe PAD-mandate steps
 *     that complete a CA link: bank linking serves no permitted purpose once
 *     funding and cash-out are withheld, and `PLAID_SECRET` on Preview is the
 *     PRODUCTION secret.
 *   - A CROSS-CURRENCY FX quote: it calls Wise for a payment that is refused.
 *
 * WHAT IS DELIBERATELY NOT CONTAINED, asserted here so a later reader does
 * not "tidy it up":
 *   - `GET /api/bank-accounts` — read-only; a participant may still see what
 *     is on file.
 *   - `DELETE /api/bank-accounts` — unlinking only REDUCES exposure. Gating it
 *     would trap an already-linked account in the beta, which is the opposite
 *     of containment. Same reasoning as leaving request `decline` ungated.
 *   - A SAME-CURRENCY FX quote — `buildFxQuote()` short-circuits it to the
 *     identity rate and contacts nobody, so it is neither external nor
 *     cross-currency.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function sandbox() {
  process.env.MANNA_ENV = 'sandbox';
  delete process.env.VERCEL_ENV;
  delete process.env.MANNA_BETA_PROFILE;
}

const AUTHED = { userId: 1, email: 'a@b.test', username: 'u' };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

/** Mocks shared by every case: auth succeeds, so the subject is the gate. */
function mockAuth(user: unknown = AUTHED) {
  vi.doMock('../auth', () => ({
    getAuthUser: vi.fn().mockResolvedValue(user),
    auditLog: vi.fn(),
  }));
}

function mockDb() {
  const sqlTag = vi.fn();
  vi.doMock('../db', () => ({ getSql: vi.fn(() => sqlTag) }));
  return sqlTag;
}

/**
 * Plaid is mocked at the module boundary rather than at the network, so a
 * call that should not happen is observable as a spy rather than as a failed
 * request that could be mistaken for an environment problem.
 */
function mockPlaid() {
  const linkTokenCreate = vi.fn().mockResolvedValue({ data: { link_token: 'link-sandbox-x' } });
  const itemPublicTokenExchange = vi
    .fn()
    .mockResolvedValue({ data: { access_token: 'access-x', item_id: 'item-x' } });
  const authGet = vi.fn().mockResolvedValue({ data: { accounts: [] } });
  vi.doMock('../plaid', () => ({
    plaidClient: { linkTokenCreate, itemPublicTokenExchange, authGet },
    PLAID_PRODUCTS: [],
    PLAID_COUNTRY_CODES: [],
  }));
  return { linkTokenCreate, itemPublicTokenExchange, authGet };
}

function mockStripe() {
  const retrieve = vi.fn().mockResolvedValue({ status: 'succeeded', payment_method: 'pm_x' });
  const create = vi.fn().mockResolvedValue({ client_secret: 'seti_x_secret' });
  const getStripe = vi.fn(() => ({
    setupIntents: { retrieve, create },
    customers: { create },
  }));
  vi.doMock('../stripe', () => ({ getStripe, isStripeLive: () => false }));
  return { getStripe, retrieve, create };
}

function post(url: string, body?: Record<string, unknown>) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
}

describe('bank linking — POST /api/plaid/create-link-token', () => {
  it('refuses with 403 BETA_RESTRICTED and never asks Plaid for a token', async () => {
    sandbox();
    mockAuth();
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/create-link-token/route');

    const res = await POST();
    const body = (await res.json()) as { code?: string; capability?: string; link_token?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('BETA_RESTRICTED');
    expect(body.capability).toBe('bank_linking');
    // No token is handed out even in the refusal body.
    expect(body.link_token).toBeUndefined();
    // The containment claim: the provider was not contacted.
    expect(plaid.linkTokenCreate).not.toHaveBeenCalled();
  });

  it('still answers 401 for an unauthenticated caller, so the gate is not the auth check', async () => {
    sandbox();
    mockAuth(null);
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/create-link-token/route');

    const res = await POST();
    expect(res.status).toBe(401);
    expect(plaid.linkTokenCreate).not.toHaveBeenCalled();
  });

  it('issues a token again when the restriction is explicitly lifted', async () => {
    // The counterpart case. Without it, a gate that refused unconditionally —
    // or one left on in an unrestricted deployment — would pass every
    // assertion above.
    sandbox();
    process.env.MANNA_BETA_PROFILE = 'unrestricted';
    mockAuth();
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/create-link-token/route');

    const res = await POST();
    expect(res.status).toBe(200);
    expect(plaid.linkTokenCreate).toHaveBeenCalledTimes(1);
  });
});

describe('bank linking — POST /api/plaid/exchange-token', () => {
  it('refuses before the exchange, so no access token is obtained or stored', async () => {
    sandbox();
    mockAuth();
    const sqlTag = mockDb();
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/exchange-token/route');

    const res = await POST(post('http://localhost/api/plaid/exchange-token', {
      public_token: 'public-sandbox-x',
      metadata: { institution: { name: 'Test Bank', country_codes: ['CA'] } },
    }));
    const body = (await res.json()) as { capability?: string };

    expect(res.status).toBe(403);
    expect(body.capability).toBe('bank_linking');
    expect(plaid.itemPublicTokenExchange).not.toHaveBeenCalled();
    expect(plaid.authGet).not.toHaveBeenCalled();
    // And no bank_accounts row: the gate precedes every query.
    expect(sqlTag).not.toHaveBeenCalled();
  });

  it('refuses a request with no body at all, since the gate precedes the parse', async () => {
    // Ordering matters here. A gate placed after `await req.json()` would
    // throw on a malformed body and the outer catch would answer 500 — a
    // participant probing the endpoint would learn nothing about the
    // restriction, and the log would carry a spurious error.
    sandbox();
    mockAuth();
    mockDb();
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/exchange-token/route');

    const res = await POST(post('http://localhost/api/plaid/exchange-token'));
    expect(res.status).toBe(403);
    expect(plaid.itemPublicTokenExchange).not.toHaveBeenCalled();
  });
});

describe('bank linking — the Stripe PAD mandate steps', () => {
  it('setup-intent refuses with 403 and creates no SetupIntent', async () => {
    sandbox();
    mockAuth();
    mockDb();
    const stripe = mockStripe();
    const { POST } = await import('../../app/api/stripe/setup-intent/route');

    const res = await POST();
    const body = (await res.json()) as { capability?: string; client_secret?: string };

    expect(res.status).toBe(403);
    expect(body.capability).toBe('bank_linking');
    expect(body.client_secret).toBeUndefined();
    expect(stripe.getStripe).not.toHaveBeenCalled();
  });

  it('setup-intent refuses a US caller with 403, not the CA-only 400', async () => {
    // The gate sits ahead of the CA-only check deliberately. A 400 saying
    // "only available for Canadian users" implies the beta would otherwise
    // allow it, which is the wrong thing for a US participant to be told.
    sandbox();
    mockAuth({ ...AUTHED, country: 'US' });
    mockDb();
    mockStripe();
    const { POST } = await import('../../app/api/stripe/setup-intent/route');

    const res = await POST();
    expect(res.status).toBe(403);
  });

  it('confirm-setup refuses before retrieving the SetupIntent or writing a payment method', async () => {
    sandbox();
    mockAuth();
    const sqlTag = mockDb();
    const stripe = mockStripe();
    const { POST } = await import('../../app/api/stripe/confirm-setup/route');

    const res = await POST(post('http://localhost/api/stripe/confirm-setup', {
      setup_intent_id: 'seti_x',
      bank_account_id: 7,
    }));
    const body = (await res.json()) as { capability?: string };

    expect(res.status).toBe(403);
    expect(body.capability).toBe('bank_linking');
    expect(stripe.getStripe).not.toHaveBeenCalled();
    expect(sqlTag).not.toHaveBeenCalled();
  });
});

describe('external FX — POST /api/fx/quote', () => {
  function mockFx() {
    const buildFxQuote = vi.fn().mockResolvedValue({
      fromCurrency: 'CAD',
      toCurrency: 'CAD',
      rate: '1.00000000',
      fee: 0,
      feeAmount: 0,
      receiverAmount: 50,
      senderAmount: 50,
      isCrossBorder: false,
      estimatedSettlement: new Date(0),
      provider: 'identity',
    });
    vi.doMock('../fx', () => ({ buildFxQuote }));
    return buildFxQuote;
  }

  it('refuses a CROSS-CURRENCY quote with 403 and never calls the FX provider', async () => {
    sandbox();
    mockAuth();
    const buildFxQuote = mockFx();
    const { POST } = await import('../../app/api/fx/quote/route');

    const res = await POST(post('http://localhost/api/fx/quote', {
      amount: 100,
      fromCurrency: 'CAD',
      toCurrency: 'USD',
    }));
    const body = (await res.json()) as { capability?: string; rate?: string };

    expect(res.status).toBe(403);
    expect(body.capability).toBe('external_fx');
    expect(body.rate).toBeUndefined();
    expect(buildFxQuote).not.toHaveBeenCalled();
  });

  it('still serves a SAME-CURRENCY quote, which reaches no external provider', async () => {
    // Scope assertion, not a convenience. buildFxQuote() short-circuits an
    // identical pair to the identity rate without contacting Wise, so
    // refusing it would withhold something the restriction is not about.
    sandbox();
    mockAuth();
    const buildFxQuote = mockFx();
    const { POST } = await import('../../app/api/fx/quote/route');

    const res = await POST(post('http://localhost/api/fx/quote', {
      amount: 100,
      fromCurrency: 'CAD',
      toCurrency: 'CAD',
    }));

    expect(res.status).toBe(200);
    expect(buildFxQuote).toHaveBeenCalledTimes(1);
  });

  it('answers 400 for an invalid currency rather than 403', async () => {
    // The refusal must not double as an input validator: a caller sending
    // "EUR" has made a bad request, and reporting it as a beta restriction
    // would tell them to wait for the beta to end instead of fixing the call.
    sandbox();
    mockAuth();
    mockFx();
    const { POST } = await import('../../app/api/fx/quote/route');

    const res = await POST(post('http://localhost/api/fx/quote', {
      amount: 100,
      fromCurrency: 'CAD',
      toCurrency: 'EUR',
    }));

    expect(res.status).toBe(400);
  });

  it('serves a cross-currency quote again when the restriction is lifted', async () => {
    sandbox();
    process.env.MANNA_BETA_PROFILE = 'unrestricted';
    mockAuth();
    const buildFxQuote = mockFx();
    const { POST } = await import('../../app/api/fx/quote/route');

    const res = await POST(post('http://localhost/api/fx/quote', {
      amount: 100,
      fromCurrency: 'CAD',
      toCurrency: 'USD',
    }));

    expect(res.status).toBe(200);
    expect(buildFxQuote).toHaveBeenCalledTimes(1);
  });
});

describe('what containment deliberately leaves reachable', () => {
  it('GET /api/bank-accounts still lists accounts — read-only', async () => {
    sandbox();
    mockAuth();
    const rows = [{ id: 1, institution_name: 'Test Bank' }];
    const sqlTag = vi.fn().mockResolvedValue(rows);
    vi.doMock('../db', () => ({ getSql: vi.fn(() => sqlTag) }));
    const { GET } = await import('../../app/api/bank-accounts/route');

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
  });

  it('DELETE /api/bank-accounts still unlinks, because that only reduces exposure', async () => {
    sandbox();
    mockAuth();
    const sqlTag = vi.fn().mockResolvedValue([]);
    vi.doMock('../db', () => ({ getSql: vi.fn(() => sqlTag) }));
    const { DELETE } = await import('../../app/api/bank-accounts/route');

    const res = await DELETE(
      new Request('http://localhost/api/bank-accounts', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(sqlTag).toHaveBeenCalled();
  });
});

describe('the profile reports the containment capabilities', () => {
  it('names bank_linking and external_fx as withheld, so the interface can reflect it', async () => {
    sandbox();
    const { betaRestrictionState } = await import('../beta-restrictions');
    const state = betaRestrictionState();

    expect(state.restricted).toBe(true);
    expect(state.capabilities).toEqual({
      funding: false,
      cash_out: false,
      cross_currency: false,
      bank_linking: false,
      external_fx: false,
    });
  });

  it('reports all five as available when unrestricted', async () => {
    sandbox();
    process.env.MANNA_BETA_PROFILE = 'unrestricted';
    const { betaRestrictionState } = await import('../beta-restrictions');
    expect(betaRestrictionState().capabilities).toEqual({
      funding: true,
      cash_out: true,
      cross_currency: true,
      bank_linking: true,
      external_fx: true,
    });
  });
});

describe('the beta profile cannot enable provider execution', () => {
  /**
   * The point of these two cases is the SEPARATION of controls, and it is
   * worth stating because the opposite reading is tempting: the beta profile
   * is NOT what keeps a live rail off, and lifting it must not turn one on.
   * Live execution is governed by `PLAID_TRANSFER_LIVE` / `CA_EFT_LIVE` and
   * by decision 0010's zero permitted throughput. So the assertion is made
   * with the profile at its most permissive value.
   */
  it('returns SANDBOX providers with the profile unrestricted and the flags off', async () => {
    sandbox();
    process.env.MANNA_BETA_PROFILE = 'unrestricted';
    delete process.env.PLAID_TRANSFER_LIVE;
    delete process.env.CA_EFT_LIVE;

    const { resolveExecutionMode, getProviderByCountry } = await import(
      '../providers/TransferProviderFactory'
    );

    expect(resolveExecutionMode('US')).toBe('sandbox');
    expect(resolveExecutionMode('CA')).toBe('sandbox');
    for (const country of ['US', 'CA']) {
      const provider = getProviderByCountry(country, resolveExecutionMode(country === 'US' ? 'US' : 'CA'));
      expect(provider.executionMode).toBe('sandbox');
      // Both sandbox providers throw rather than silently no-op, so an
      // accidental live call is loud.
      await expect(provider.executeTransfer(1, 1)).rejects.toThrow();
    }
  });

  it('is unaffected by MANNA_BETA_PROFILE in either direction', async () => {
    // Mutation bait: if someone ever wires the profile into provider
    // selection, this fails. The two mechanisms must stay independent.
    sandbox();
    delete process.env.PLAID_TRANSFER_LIVE;
    delete process.env.CA_EFT_LIVE;

    for (const profile of ['p2p_only', 'unrestricted']) {
      vi.resetModules();
      process.env.MANNA_BETA_PROFILE = profile;
      const { resolveExecutionMode } = await import('../providers/TransferProviderFactory');
      expect(resolveExecutionMode('US'), `profile ${profile}`).toBe('sandbox');
      expect(resolveExecutionMode('CA'), `profile ${profile}`).toBe('sandbox');
    }
  });
});

describe('production is untouched by the containment gates', () => {
  /**
   * Verified SEPARATELY from the sandbox cases, and deliberately so. This
   * module is a beta control; if it silently started refusing bank linking or
   * FX in production it would be a regression dressed as a safety feature.
   * Production's protection against live money movement is
   * `PLAID_TRANSFER_LIVE` / `CA_EFT_LIVE` and decision 0010 — not this.
   */
  function production() {
    delete process.env.MANNA_ENV;
    delete process.env.MANNA_BETA_PROFILE;
    delete process.env.VERCEL_ENV;
  }

  it('bank linking is not gated in production', async () => {
    production();
    mockAuth();
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/create-link-token/route');

    const res = await POST();
    expect(res.status).toBe(200);
    expect(plaid.linkTokenCreate).toHaveBeenCalledTimes(1);
  });

  it('a cross-currency FX quote is not gated in production', async () => {
    production();
    mockAuth();
    const buildFxQuote = vi.fn().mockResolvedValue({
      fromCurrency: 'CAD', toCurrency: 'USD', rate: '0.73', fee: 0, feeAmount: 0,
      receiverAmount: 73, senderAmount: 100, isCrossBorder: true,
      estimatedSettlement: new Date(0), provider: 'wise',
    });
    vi.doMock('../fx', () => ({ buildFxQuote }));
    const { POST } = await import('../../app/api/fx/quote/route');

    const res = await POST(post('http://localhost/api/fx/quote', {
      amount: 100, fromCurrency: 'CAD', toCurrency: 'USD',
    }));
    expect(res.status).toBe(200);
    expect(buildFxQuote).toHaveBeenCalledTimes(1);
  });

  it('VERCEL_ENV=production overrides MANNA_ENV=sandbox, so a mislabelled production deploy is not restricted', async () => {
    process.env.MANNA_ENV = 'sandbox';
    process.env.VERCEL_ENV = 'production';
    delete process.env.MANNA_BETA_PROFILE;
    mockAuth();
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/create-link-token/route');

    expect((await POST()).status).toBe(200);
    expect(plaid.linkTokenCreate).toHaveBeenCalledTimes(1);
  });

  it('but an EXPLICIT p2p_only still restricts in production, if someone asks for it', async () => {
    // The escape hatch in the other direction. Not a recommendation — just
    // the honest behaviour of the resolver, pinned so it is not surprising.
    production();
    process.env.MANNA_BETA_PROFILE = 'p2p_only';
    mockAuth();
    const plaid = mockPlaid();
    const { POST } = await import('../../app/api/plaid/create-link-token/route');

    expect((await POST()).status).toBe(403);
    expect(plaid.linkTokenCreate).not.toHaveBeenCalled();
  });
});

describe('the interface fails closed — clientCapabilityAvailable()', () => {
  /**
   * THE DEFECT THIS PINS. PlaidLinkButton first held `boolean | null` and
   * disabled its control only on an explicit `false`. So a failed
   * /api/beta-profile request, a non-ok response, or a body missing the field
   * all left the "+ Link Account" button live — offering the user an action
   * the server answers with 403, and showing an operator a beta that looked
   * unrestricted.
   *
   * The asymmetry is the reason to fail closed. A UI more restrictive than the
   * server costs a disabled button during an outage. A UI LESS restrictive
   * than the server misrepresents the restriction, which is the thing the beta
   * is supposed to be able to state truthfully.
   *
   * Tested as a pure function rather than by rendering: there is no DOM test
   * stack in this repository (node environment, *.test.ts only), and adding
   * jsdom plus a rendering library to assert one branch would be a larger
   * change than the fix. The function is the whole decision — the component
   * does nothing with its answer but choose which span to render — and the
   * rendered strings are asserted by the browser smoke script.
   */
  it('returns true ONLY for an explicit boolean true', async () => {
    const { clientCapabilityAvailable } = await import('../beta-capability-client');
    expect(
      clientCapabilityAvailable({ capabilities: { bank_linking: true } }, 'bank_linking'),
    ).toBe(true);
  });

  it.each([
    ['null body, as a non-ok response produces', null],
    ['undefined', undefined],
    ['a string instead of an object', 'p2p_only'],
    ['an object with no capabilities key', { profile: 'p2p_only', restricted: true }],
    ['capabilities null', { capabilities: null }],
    ['capabilities a string', { capabilities: 'all' }],
    ['the capability key absent', { capabilities: { funding: true } }],
    ['the value undefined', { capabilities: { bank_linking: undefined } }],
    ['the value the STRING "true"', { capabilities: { bank_linking: 'true' }}],
    ['the value 1', { capabilities: { bank_linking: 1 } }],
    ['the value an empty object', { capabilities: { bank_linking: {} } }],
  ])('withholds when the payload is %s', async (_label, payload) => {
    // The string "true" and 1 are the cases a loose `if (value)` would let
    // through, and a JSON body is exactly where a stringified boolean shows up.
    const { clientCapabilityAvailable } = await import('../beta-capability-client');
    expect(clientCapabilityAvailable(payload, 'bank_linking')).toBe(false);
  });

  it('withholds an explicit false', async () => {
    const { clientCapabilityAvailable } = await import('../beta-capability-client');
    expect(
      clientCapabilityAvailable({ capabilities: { bank_linking: false } }, 'bank_linking'),
    ).toBe(false);
  });

  it('reads the named capability and not another one', async () => {
    // A copy-paste of the wrong key would otherwise pass every case above.
    const { clientCapabilityAvailable } = await import('../beta-capability-client');
    const payload = { capabilities: { bank_linking: false, cross_currency: true } };
    expect(clientCapabilityAvailable(payload, 'bank_linking')).toBe(false);
    expect(clientCapabilityAvailable(payload, 'cross_currency')).toBe(true);
  });

  it('agrees with the server resolver on a real /api/beta-profile body', async () => {
    // The one-resolver rule end to end: the client helper fed the exact object
    // the route serialises must reach the same answer as the server's own
    // isCapabilityRestricted() for all five capabilities.
    sandbox();
    const { betaRestrictionState, isCapabilityRestricted } = await import('../beta-restrictions');
    const { clientCapabilityAvailable } = await import('../beta-capability-client');
    const body = JSON.parse(JSON.stringify(betaRestrictionState()));

    for (const capability of [
      'funding',
      'cash_out',
      'cross_currency',
      'bank_linking',
      'external_fx',
    ] as const) {
      expect(clientCapabilityAvailable(body, capability), capability).toBe(
        !isCapabilityRestricted(capability),
      );
    }
  });

  it('the two capability-gated components use the shared resolver, not an inline check', async () => {
    // Static, and deliberately so: the fix is only worth anything if the
    // components actually call it. Both held the fail-open `boolean | null`
    // shape, and `=== false` is the exact comparison that caused it.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    for (const rel of ['components/PlaidLinkButton.tsx', 'app/(app)/send/page.tsx']) {
      const src = readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(src, `${rel} must import the shared resolver`).toContain(
        'clientCapabilityAvailable',
      );
      expect(src, `${rel} must not gate on \`=== false\` (fail-open shape)`).not.toMatch(
        /(linkingAllowed|crossCurrencyAllowed)\s*===\s*false/,
      );
    }
  });
});
