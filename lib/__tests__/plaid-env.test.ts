/**
 * PLAID_ENV has one resolver. The API client and the webhook verifier both
 * used to default it, in opposite directions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaidEnvironments } from 'plaid';
import {
  plaidApiBasePath,
  plaidWebhookJwksUrl,
  resolvePlaidEnvironment,
} from '@/lib/plaid-env';

const ORIGINAL = process.env.PLAID_ENV;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLAID_ENV;
  else process.env.PLAID_ENV = ORIGINAL;
});

describe('resolvePlaidEnvironment', () => {
  it('uses sandbox when PLAID_ENV is unset', () => {
    delete process.env.PLAID_ENV;
    expect(resolvePlaidEnvironment()).toBe('sandbox');
    expect(plaidApiBasePath()).toBe(PlaidEnvironments.sandbox);
    expect(plaidWebhookJwksUrl()).toBe('https://sandbox.plaid.com/.well-known/jwks.json');
  });

  it('uses sandbox for an empty, unknown, or development value', () => {
    process.env.PLAID_ENV = '   ';
    expect(resolvePlaidEnvironment()).toBe('sandbox');
    process.env.PLAID_ENV = 'prod';
    expect(resolvePlaidEnvironment()).toBe('sandbox');
    process.env.PLAID_ENV = 'development';
    expect(resolvePlaidEnvironment()).toBe('sandbox');
    expect(plaidApiBasePath()).toBe(PlaidEnvironments.sandbox);
    expect(plaidWebhookJwksUrl()).toBe('https://sandbox.plaid.com/.well-known/jwks.json');
  });

  it('uses production only when PLAID_ENV is exactly production', () => {
    process.env.PLAID_ENV = ' Production ';
    expect(resolvePlaidEnvironment()).toBe('production');
    expect(plaidApiBasePath()).toBe(PlaidEnvironments.production);
    expect(plaidWebhookJwksUrl()).toBe('https://production.plaid.com/.well-known/jwks.json');
  });

  it('is the only default used by the client and the webhook route', () => {
    const root = join(__dirname, '../..');
    const client = readFileSync(join(root, 'lib/plaid.ts'), 'utf8');
    const webhook = readFileSync(join(root, 'app/api/webhooks/plaid/route.ts'), 'utf8');

    expect(client).toContain('resolvePlaidEnvironment');
    expect(webhook).toContain('resolvePlaidEnvironment');
    expect(client).not.toMatch(/PLAID_ENV\s*\|\|\s*['"]production['"]/);
    expect(webhook).not.toMatch(/PLAID_ENV\s*\|\|\s*['"]sandbox['"]/);
    expect(webhook).not.toContain('PLAID_JWKS_URL');
    expect(webhook).not.toContain('PLAID_JWKS_WELL_KNOWN');
  });
});
