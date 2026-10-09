/**
 * Plaid's SDK throws Axios errors whose `config.headers` hold PLAID-CLIENT-ID
 * and PLAID-SECRET. Logging that object writes both into the platform logs.
 * The helper must return only Plaid's public error fields.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logRedactedError, plaidErrorDetails, redactedErrorLog } from '@/lib/plaid-error';

const CLIENT_ID = 'client-id-do-not-log-8f3a';
const SECRET = 'plaid-secret-do-not-log-91c2';
const STRIPE_SECRET = 'sk_live_do_not_log_44ab';
const WISE_SECRET = 'wise-key-do-not-log-77de';
const RESEND_SECRET = 're_do_not_log_12ff';

function axiosPlaidError() {
  return Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    config: {
      method: 'post',
      url: '/link/token/create',
      headers: {
        'PLAID-CLIENT-ID': CLIENT_ID,
        'PLAID-SECRET': SECRET,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        client_id: CLIENT_ID,
        secret: SECRET,
        access_token: 'access-sandbox-should-not-log',
      }),
    },
    request: {
      _header: `PLAID-CLIENT-ID: ${CLIENT_ID}\r\nPLAID-SECRET: ${SECRET}\r\n`,
    },
    response: {
      status: 400,
      headers: {
        'plaid-client-id': CLIENT_ID,
        'plaid-secret': SECRET,
      },
      data: {
        error_type: 'INVALID_REQUEST',
        error_code: 'INVALID_API_KEYS',
        error_message: 'invalid client_id or secret provided',
        display_message: null,
        request_id: 'req-abc',
        // A nested copy of the credentials must not be copied through.
        causes: [{ secret: SECRET }],
      },
    },
  });
}

function assertNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(CLIENT_ID);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(STRIPE_SECRET);
  expect(serialized).not.toContain(WISE_SECRET);
  expect(serialized).not.toContain(RESEND_SECRET);
  expect(serialized).not.toContain('access-sandbox-should-not-log');
  expect(serialized).not.toContain('PLAID-SECRET');
  expect(serialized).not.toContain('PLAID-CLIENT-ID');
  expect(serialized).not.toMatch(/"config"/);
  expect(serialized).not.toMatch(/"headers"/);
}

describe('plaidErrorDetails', () => {
  it('keeps Plaid public fields and drops headers, config, and the request body', () => {
    const details = plaidErrorDetails(axiosPlaidError());

    expect(details).toEqual({
      error_type: 'INVALID_REQUEST',
      error_code: 'INVALID_API_KEYS',
      error_message: 'invalid client_id or secret provided',
      display_message: null,
      request_id: 'req-abc',
      status: 400,
    });
    assertNoSecrets(details);
  });

  it('drops credentials when the failure has no response body', () => {
    const err = Object.assign(new Error('timeout'), {
      isAxiosError: true,
      config: { headers: { 'PLAID-SECRET': SECRET, 'PLAID-CLIENT-ID': CLIENT_ID } },
      request: { _header: SECRET },
    });

    const details = plaidErrorDetails(err);
    expect(details).toEqual({
      error_type: null,
      error_code: null,
      error_message: null,
      display_message: null,
      request_id: null,
      status: null,
    });
    assertNoSecrets(details);
  });

  it('does not stringify a non-string body field that embeds the secret', () => {
    const err = {
      isAxiosError: true,
      config: { headers: { 'PLAID-SECRET': SECRET } },
      response: {
        status: 400,
        data: {
          error_code: 'INVALID_FIELD',
          error_message: { secret: SECRET, client_id: CLIENT_ID },
          display_message: ['show', SECRET],
        },
      },
    };

    const details = plaidErrorDetails(err);
    expect(details.error_code).toBe('INVALID_FIELD');
    expect(details.error_message).toBeNull();
    expect(details.display_message).toBeNull();
    assertNoSecrets(details);
  });
});

describe('redactedErrorLog', () => {
  it('logs the Plaid summary and never the Axios error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = axiosPlaidError();

    logRedactedError('Plaid link token error:', err);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('Plaid link token error:');
    expect(spy.mock.calls[0][1]).toEqual(plaidErrorDetails(err));
    expect(spy.mock.calls[0]).toHaveLength(2);
    assertNoSecrets(spy.mock.calls[0][1]);
    expect(spy.mock.calls[0]).not.toContain(err);
    spy.mockRestore();
  });

  it('drops a Stripe error payload, raw body, and request headers', () => {
    const err = Object.assign(new Error('Invalid API Key provided'), {
      name: 'StripeAuthenticationError',
      type: 'StripeAuthenticationError',
      code: 'api_key_expired',
      requestId: 'req_stripe_1',
      statusCode: 401,
      raw: {
        message: 'Invalid API Key provided',
        headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
      },
      headers: { Authorization: `Bearer ${STRIPE_SECRET}` },
      payload: `{"secret":"${STRIPE_SECRET}"}`,
      header: `t=1,v1=${STRIPE_SECRET}`,
    });

    const logged = redactedErrorLog(err);
    expect(logged).toEqual({
      message: 'Invalid API Key provided',
      type: 'StripeAuthenticationError',
      code: 'api_key_expired',
      request_id: 'req_stripe_1',
      status: 401,
    });
    assertNoSecrets(logged);
  });

  it('logs only the message of a Wise or Resend failure', () => {
    const wise = Object.assign(new Error('Wise API error: 401'), {
      headers: { Authorization: `Bearer ${WISE_SECRET}` },
      request: { body: WISE_SECRET },
    });
    const resend = Object.assign(new Error('Email configuration incomplete'), {
      headers: { Authorization: `Bearer ${RESEND_SECRET}` },
      key: RESEND_SECRET,
    });

    assertNoSecrets(redactedErrorLog(wise));
    assertNoSecrets(redactedErrorLog(resend));
    expect(redactedErrorLog(wise)).toEqual({
      message: 'Wise API error: 401',
      type: null,
      code: null,
      request_id: null,
      status: null,
    });
    expect(redactedErrorLog(resend)).toMatchObject({
      message: 'Email configuration incomplete',
    });
  });

  it('does not call toString on a non-Error that could dump credentials', () => {
    const err = {
      toString() {
        return SECRET;
      },
      headers: { 'PLAID-SECRET': SECRET },
    };

    expect(redactedErrorLog(err)).toEqual({
      message: null,
      type: null,
      code: null,
      request_id: null,
      status: null,
    });
    assertNoSecrets(redactedErrorLog(err));
  });
});

describe('provider catch sites', () => {
  const root = join(__dirname, '../..');
  const files = [
    'app/api/plaid/create-link-token/route.ts',
    'app/api/plaid/exchange-token/route.ts',
    'app/api/transfers/[id]/execute/route.ts',
    'app/api/admin/transfers/[id]/reconcile/route.ts',
    'app/api/webhooks/plaid/route.ts',
    'app/api/webhooks/stripe/route.ts',
    'app/api/stripe/setup-intent/route.ts',
    'app/api/stripe/confirm-setup/route.ts',
    'app/api/kyc/create-session/route.ts',
    'lib/fx.ts',
    'app/api/auth/forgot-password/route.ts',
    'lib/providers/PlaidTransferProvider.ts',
    'lib/providers/CanadianEFTProvider.ts',
  ];

  it('does not pass a caught error object to the logger', () => {
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).not.toMatch(/console\.(error|warn)\([^)]*,\s*(err|handlerErr)\s*[,)]/);
    }
  });
});

const getAuthUser = vi.hoisted(() => vi.fn());
const linkTokenCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({ getAuthUser }));
vi.mock('@/lib/plaid', () => ({
  plaidClient: { linkTokenCreate },
  PLAID_PRODUCTS: ['auth'],
  PLAID_COUNTRY_CODES: ['US'],
}));

import { POST as createLinkToken } from '@/app/api/plaid/create-link-token/route';

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/plaid/create-link-token', () => {
  it('returns Plaid error_code and logs no credentials', async () => {
    getAuthUser.mockResolvedValue({ userId: 7 });
    linkTokenCreate.mockRejectedValue(axiosPlaidError());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await createLinkToken();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'Failed to create link token',
      code: 'INVALID_API_KEYS',
    });
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    assertNoSecrets(body);
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      assertNoSecrets(call);
      expect(call).not.toContainEqual(expect.objectContaining({ config: expect.anything() }));
    }
    spy.mockRestore();
  });
});
