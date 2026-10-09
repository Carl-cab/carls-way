/**
 * Credential diagnostics must describe the shape of PLAID_CLIENT_ID and
 * PLAID_SECRET without ever printing the values or any piece of them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanPlaidCredential,
  logPlaidCredentialDiagnostic,
  plaidCredentialDiagnostic,
} from '@/lib/plaid-credentials';

const CLIENT_ID = 'a1b2c3d4e5f678901234abcd';
const SECRET = 'z'.repeat(32);
const OPAQUE_CLIENT_ID = 'j'.repeat(24);

const ORIGINAL = {
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
  PLAID_SECRET: process.env.PLAID_SECRET,
  PLAID_ENV: process.env.PLAID_ENV,
};

afterEach(() => {
  restore('PLAID_CLIENT_ID', ORIGINAL.PLAID_CLIENT_ID);
  restore('PLAID_SECRET', ORIGINAL.PLAID_SECRET);
  restore('PLAID_ENV', ORIGINAL.PLAID_ENV);
});

function restore(name: 'PLAID_CLIENT_ID' | 'PLAID_SECRET' | 'PLAID_ENV', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function assertOmitsValue(serialized: string, value: string) {
  expect(value.length).toBeGreaterThan(0);
  expect(serialized).not.toContain(value);
  if (new Set(value).size === 1) {
    expect(serialized).not.toContain(value[0]);
    return;
  }
  for (let size = 6; size <= value.length; size += 1) {
    for (let index = 0; index + size <= value.length; index += 1) {
      expect(serialized).not.toContain(value.slice(index, index + size));
    }
  }
}

describe('cleanPlaidCredential', () => {
  it('trims whitespace and strips one matching pair of quotes', () => {
    expect(cleanPlaidCredential(undefined)).toBe('');
    expect(cleanPlaidCredential('  abc  ')).toBe('abc');
    expect(cleanPlaidCredential(`"${CLIENT_ID}"`)).toBe(CLIENT_ID);
    expect(cleanPlaidCredential(`'${CLIENT_ID}'`)).toBe(CLIENT_ID);
    expect(cleanPlaidCredential(` " ${CLIENT_ID} " \n`)).toBe(CLIENT_ID);
    expect(cleanPlaidCredential(`'"${CLIENT_ID}"'`)).toBe(`"${CLIENT_ID}"`);
    expect(cleanPlaidCredential(`"${CLIENT_ID}'`)).toBe(`"${CLIENT_ID}'`);
  });
});

describe('plaidCredentialDiagnostic', () => {
  it('describes a quoted client id and never includes the value', () => {
    process.env.PLAID_ENV = 'production';
    process.env.PLAID_CLIENT_ID = ` "${CLIENT_ID}" \n`;
    process.env.PLAID_SECRET = ` '${SECRET}' `;

    const diagnostic = plaidCredentialDiagnostic();
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toEqual({
      environment: 'production',
      clientId: {
        raw: {
          present: true,
          length: CLIENT_ID.length + 5,
          matchesClientIdFormat: false,
          leadingOrTrailingWhitespace: true,
          surroundingQuotes: true,
        },
        cleaned: {
          present: true,
          length: CLIENT_ID.length,
          matchesClientIdFormat: true,
          leadingOrTrailingWhitespace: false,
          surroundingQuotes: false,
        },
      },
      secret: {
        raw: { present: true, length: SECRET.length + 4 },
        cleaned: { present: true, length: SECRET.length },
      },
    });
    assertOmitsValue(serialized, CLIENT_ID);
    assertOmitsValue(serialized, SECRET);
    expect(serialized).not.toMatch(/"PLAID-CLIENT-ID"|"PLAID-SECRET"/);
  });

  it('logs no substring of an opaque client id or secret', () => {
    delete process.env.PLAID_ENV;
    process.env.PLAID_CLIENT_ID = ` '${OPAQUE_CLIENT_ID}'\n`;
    process.env.PLAID_SECRET = `"${SECRET}"`;
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logPlaidCredentialDiagnostic('link_token_failure');
    logPlaidCredentialDiagnostic('link_token_failure');

    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      const serialized = JSON.stringify(call);
      assertOmitsValue(serialized, OPAQUE_CLIENT_ID);
      assertOmitsValue(serialized, SECRET);
      expect(call[1]).toMatchObject({
        when: 'link_token_failure',
        environment: 'sandbox',
        clientId: {
          cleaned: {
            present: true,
            length: OPAQUE_CLIENT_ID.length,
            matchesClientIdFormat: false,
          },
        },
        secret: { cleaned: { present: true, length: SECRET.length } },
      });
    }
    spy.mockRestore();
  });

  it('logs the init diagnostic only once', () => {
    process.env.PLAID_CLIENT_ID = OPAQUE_CLIENT_ID;
    process.env.PLAID_SECRET = SECRET;
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logPlaidCredentialDiagnostic('init');
    logPlaidCredentialDiagnostic('init');
    logPlaidCredentialDiagnostic('link_token_failure');

    const inits = spy.mock.calls.filter((call) => call[1]?.when === 'init');
    expect(inits).toHaveLength(1);
    assertOmitsValue(JSON.stringify(inits), OPAQUE_CLIENT_ID);
    assertOmitsValue(JSON.stringify(inits), SECRET);
    spy.mockRestore();
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

describe('POST /api/plaid/create-link-token credential diagnostic', () => {
  it('logs the diagnostic on failure without the credential text', async () => {
    process.env.PLAID_CLIENT_ID = `'${OPAQUE_CLIENT_ID}'`;
    process.env.PLAID_SECRET = SECRET;
    getAuthUser.mockResolvedValue({ userId: 7 });
    linkTokenCreate.mockRejectedValue(new Error('Request failed with status code 400'));
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await createLinkToken();

    expect(response.status).toBe(500);
    const diagnostic = spy.mock.calls.find((call) => call[0] === 'Plaid credential diagnostic');
    expect(diagnostic).toBeTruthy();
    const serialized = JSON.stringify(diagnostic);
    assertOmitsValue(serialized, OPAQUE_CLIENT_ID);
    assertOmitsValue(serialized, SECRET);
    expect(diagnostic?.[1]).toMatchObject({ when: 'link_token_failure' });
    spy.mockRestore();
  });
});
