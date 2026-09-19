import { afterEach, describe, expect, it } from 'vitest';
import { authorizeCronRequest } from '@/lib/cron-auth';

const originalSecret = process.env.CRON_SECRET;

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalSecret;
  }
});

describe('authorizeCronRequest', () => {
  it('fails closed when the server-only cron secret is absent', () => {
    delete process.env.CRON_SECRET;
    expect(authorizeCronRequest('Bearer any-value')).toBe('misconfigured');
  });

  it('rejects a missing or incorrect authorization header', () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    expect(authorizeCronRequest(null)).toBe('unauthorized');
    expect(authorizeCronRequest('Bearer wrong-secret')).toBe('unauthorized');
  });

  it('accepts only the exact Vercel Bearer credential', () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    expect(authorizeCronRequest('Bearer test-cron-secret')).toBe('authorized');
  });
});
