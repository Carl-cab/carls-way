/**
 * KYC fail-closed security regression tests.
 *
 * These exist to prove one property:
 *
 *   No production configuration failure can result in automatic identity
 *   approval.
 *
 * The decision point is lib/environment.ts. Auto-verification is permitted only
 * by canAutoVerifyIdentity(), which consults the declared environment and never
 * a credential. These tests pin that behaviour against regression.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getDeploymentEnvironment,
  isSandboxEnvironment,
  isProductionEnvironment,
  canAutoVerifyIdentity,
  assertKycProviderConfigured,
  ConfigurationError,
} from '../environment';

const REPO_ROOT = join(__dirname, '..', '..');

/** Env keys these tests manipulate; restored after each case. */
const MANAGED_KEYS = ['MANNA_ENV', 'VERCEL_ENV', 'STRIPE_SECRET_KEY', 'NODE_ENV'] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of MANAGED_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('KYC fail-closed security', () => {
  describe('environment resolution', () => {
    it('defaults to production when no environment is declared', () => {
      expect(getDeploymentEnvironment()).toBe('production');
      expect(isProductionEnvironment()).toBe(true);
      expect(isSandboxEnvironment()).toBe(false);
    });

    it('resolves sandbox only for an exact MANNA_ENV=sandbox opt-in', () => {
      process.env.MANNA_ENV = 'sandbox';
      expect(getDeploymentEnvironment()).toBe('sandbox');
      expect(canAutoVerifyIdentity()).toBe(true);
    });

    it('tolerates surrounding whitespace and casing on the opt-in', () => {
      process.env.MANNA_ENV = '  SandBox ';
      expect(getDeploymentEnvironment()).toBe('sandbox');
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['development', 'development'],
      ['dev', 'dev'],
      ['test', 'test'],
      ['staging', 'staging'],
      ['typo', 'sandbx'],
      ['prefix match', 'sandbox-ish'],
      ['suffix match', 'not-sandbox'],
      ['boolean-ish', 'true'],
      ['production', 'production'],
    ])('treats MANNA_ENV=%s as production (never sandbox)', (_label, value) => {
      process.env.MANNA_ENV = value;
      expect(getDeploymentEnvironment()).toBe('production');
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('never allows a Vercel production deployment to be downgraded to sandbox', () => {
      process.env.VERCEL_ENV = 'production';
      process.env.MANNA_ENV = 'sandbox';
      expect(getDeploymentEnvironment()).toBe('production');
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('does not treat NODE_ENV as an environment signal', () => {
      process.env.NODE_ENV = 'development';
      // NODE_ENV=development must NOT imply sandbox.
      expect(getDeploymentEnvironment()).toBe('production');
      expect(canAutoVerifyIdentity()).toBe(false);
    });
  });

  describe('credentials are never an environment signal', () => {
    it('production + missing STRIPE_SECRET_KEY does not become sandbox', () => {
      // The exact historical fail-open: absent credential implying sandbox.
      expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('production + test-mode key does not become sandbox', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('production + live key does not enable auto-verification either', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
      expect(canAutoVerifyIdentity()).toBe(false);
    });

    it('sandbox opt-in does not require any credential', () => {
      process.env.MANNA_ENV = 'sandbox';
      expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
      expect(() => assertKycProviderConfigured()).not.toThrow();
      expect(canAutoVerifyIdentity()).toBe(true);
    });
  });

  describe('production provider configuration assertions', () => {
    it('production + valid live configuration passes', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
      expect(() => assertKycProviderConfigured()).not.toThrow();
    });

    it('production + valid test-mode configuration passes the shape check', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
      expect(() => assertKycProviderConfigured()).not.toThrow();
    });

    it('production + missing secret throws ConfigurationError', () => {
      expect(() => assertKycProviderConfigured()).toThrow(ConfigurationError);
    });

    it('production + empty secret throws ConfigurationError', () => {
      process.env.STRIPE_SECRET_KEY = '   ';
      expect(() => assertKycProviderConfigured()).toThrow(ConfigurationError);
    });

    it.each([
      ['garbage', 'not-a-key'],
      ['publishable key', 'pk_live_abc123'],
      ['truncated prefix', 'sk_live_'],
      ['wrong mode', 'sk_prod_abc123'],
      ['leading junk', 'xsk_live_abc123'],
    ])('production + invalid secret (%s) throws ConfigurationError', (_label, value) => {
      process.env.STRIPE_SECRET_KEY = value;
      expect(() => assertKycProviderConfigured()).toThrow(ConfigurationError);
    });

    it('reports the failing capability so callers can fail closed deliberately', () => {
      try {
        assertKycProviderConfigured();
        throw new Error('expected assertKycProviderConfigured to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigurationError);
        expect((err as ConfigurationError).capability).toBe('kyc');
      }
    });
  });

  describe('route-level fail-closed wiring', () => {
    const routeSource = readFileSync(
      join(REPO_ROOT, 'app/api/kyc/create-session/route.ts'),
      'utf8',
    );

    it('gates auto-verification on canAutoVerifyIdentity, not on a credential', () => {
      expect(routeSource).toContain('canAutoVerifyIdentity()');
      // The historical fail-open helper must not come back.
      expect(routeSource).not.toContain('isStripeLive');
      expect(routeSource).not.toContain('sk_live_');
    });

    it('asserts provider configuration before taking the production path', () => {
      expect(routeSource).toContain('assertKycProviderConfigured()');
    });

    it('translates a configuration error into a failure, never an approval', () => {
      const handler = routeSource.slice(routeSource.indexOf('catch (err)'));
      expect(handler).toContain('ConfigurationError');
      expect(handler).toContain('503');
      // No status mutation may occur while handling a failure. Checked against
      // SQL verbs rather than the column name so prose comments do not match.
      expect(handler).not.toMatch(/UPDATE\s+users/i);
      expect(handler).not.toMatch(/SET\s+kyc_status/i);
    });

    it('performs auto-verification exactly once, inside the sandbox branch', () => {
      const autoVerifyStatements = routeSource.match(/kyc_status = 'verified'/g) ?? [];
      expect(autoVerifyStatements).toHaveLength(1);

      const gateIndex = routeSource.indexOf('canAutoVerifyIdentity()');
      const verifyIndex = routeSource.indexOf("kyc_status = 'verified'");
      expect(gateIndex).toBeGreaterThan(-1);
      expect(verifyIndex).toBeGreaterThan(gateIndex);
    });
  });

  describe('inventory of every path that can set a user verified', () => {
    it('only the sandbox-gated route and the signature-verified webhook set verified', () => {
      // Any new write of kyc_status='verified' must be reviewed and added here
      // deliberately. This test exists to make such a change impossible to land
      // silently.
      const kycRoute = readFileSync(
        join(REPO_ROOT, 'app/api/kyc/create-session/route.ts'),
        'utf8',
      );
      const webhook = readFileSync(
        join(REPO_ROOT, 'app/api/webhooks/stripe/route.ts'),
        'utf8',
      );

      // Path 1: sandbox-gated auto-verification.
      expect(kycRoute).toContain('canAutoVerifyIdentity()');

      // Path 2: Stripe Identity webhook — signature must be verified before any
      // status write, and the write must be scoped to the provider's session id.
      const sigIndex = webhook.indexOf('constructEvent');
      const verifiedWriteIndex = webhook.indexOf("kyc_status      = 'verified'");
      expect(sigIndex).toBeGreaterThan(-1);
      expect(verifiedWriteIndex).toBeGreaterThan(sigIndex);
      expect(webhook).toContain('WHERE kyc_session_id =');
    });
  });
});
