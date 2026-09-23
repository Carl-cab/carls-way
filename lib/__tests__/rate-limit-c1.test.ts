/**
 * C1.1: rate limiting on money-movement and webhook endpoints.
 *
 * The limiter itself is in-memory here (no REDIS_URL in tests), which is
 * exactly the fallback path production degrades to — the enforcement
 * semantics are identical.
 */
import {
  RATE_LIMITS,
  checkRateLimit,
  rateLimitHeaders,
  __resetInMemoryCounters,
} from '../rate-limit';

beforeEach(() => {
  __resetInMemoryCounters();
});

describe('C1.1 rate limit rules', () => {
  it('defines a webhook:events rule', () => {
    expect(RATE_LIMITS['webhook:events']).toBeDefined();
    expect(RATE_LIMITS['webhook:events'].limit).toBeGreaterThan(0);
    expect(RATE_LIMITS['webhook:events'].windowSeconds).toBeGreaterThan(0);
  });

  it('keeps the money-movement rules the routes rely on', () => {
    expect(RATE_LIMITS['money:send']).toBeDefined();
    expect(RATE_LIMITS['money:split-pay']).toBeDefined();
  });
});

describe('money:send enforcement (transfers/intent, transactions)', () => {
  const rule = RATE_LIMITS['money:send'];

  it(`allows ${20} requests then blocks the 21st for the same user`, async () => {
    const key = 'user:4242';
    let result = await checkRateLimit('money:send', key);
    for (let i = 1; i < rule.limit; i++) {
      result = await checkRateLimit('money:send', key);
      expect(result.allowed).toBe(true);
    }
    result = await checkRateLimit('money:send', key);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('isolates users: one blocked user does not block another', async () => {
    const rule = RATE_LIMITS['money:send'];
    for (let i = 0; i <= rule.limit; i++) {
      await checkRateLimit('money:send', 'user:blocked');
    }
    const other = await checkRateLimit('money:send', 'user:innocent');
    expect(other.allowed).toBe(true);
  });
});

describe('money:split-pay enforcement (splits/[id]/pay)', () => {
  it('blocks after its own limit', async () => {
    const rule = RATE_LIMITS['money:split-pay'];
    for (let i = 0; i < rule.limit; i++) {
      const r = await checkRateLimit('money:split-pay', 'user:4242');
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit('money:split-pay', 'user:4242');
    expect(blocked.allowed).toBe(false);
  });
});

describe('webhook:events enforcement (plaid/stripe webhooks)', () => {
  it('blocks a flooding source IP after the limit', async () => {
    const rule = RATE_LIMITS['webhook:events'];
    for (let i = 0; i < rule.limit; i++) {
      const r = await checkRateLimit('webhook:events', '203.0.113.9');
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit('webhook:events', '203.0.113.9');
    expect(blocked.allowed).toBe(false);
  });

  it('does not throttle a different source IP', async () => {
    const rule = RATE_LIMITS['webhook:events'];
    for (let i = 0; i <= rule.limit; i++) {
      await checkRateLimit('webhook:events', '203.0.113.9');
    }
    const other = await checkRateLimit('webhook:events', '198.51.100.7');
    expect(other.allowed).toBe(true);
  });
});

describe('429 response headers', () => {
  it('includes Retry-After when the request is denied', async () => {
    const rule = RATE_LIMITS['money:send'];
    let result = await checkRateLimit('money:send', 'user:99');
    for (let i = 0; i < rule.limit; i++) {
      result = await checkRateLimit('money:send', 'user:99');
    }
    expect(result.allowed).toBe(false);
    const headers = rateLimitHeaders(result);
    expect(headers['X-RateLimit-Limit']).toBe(String(rule.limit));
    expect(headers['X-RateLimit-Remaining']).toBe('0');
    expect(headers['Retry-After']).toBeDefined();
  });
});
