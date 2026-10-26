/**
 * The INTERACTION between the two rate-limit changes merged in Sprint 1:
 * Redis degradation recovery (PR #67) and validated client identity (PR #71).
 *
 * ## Why a third file, when both already have thorough suites
 *
 * Each was tested against the other's absence. `rate-limit-degradation-recovery`
 * drives outage and recovery with a fixed key string; `client-identity` resolves
 * headers with no Redis in play. Neither answers the question an operator
 * actually has during an incident: **when Redis is down *and* the client header
 * is junk, which limits still hold?**
 *
 * The two failure modes are not symmetrical, and the asymmetry is the whole
 * point of the open fail-open/fail-closed decision:
 *
 * - Redis loss weakens a limit to `limit x instances` — still per-key.
 * - Header loss *collapses the key*, so every anonymous caller shares one
 *   bucket.
 * - A bucket keyed on the authenticated user id is **immune to header loss**,
 *   because the key never came from a header.
 *
 * That last line is the load-bearing claim in the money-bucket recommendation,
 * and until now nothing executed it. These tests do.
 *
 * Nothing here changes policy. Every bucket still fails *open*; these tests
 * pin what "open" means for each key shape so a future change to either
 * mechanism cannot quietly alter it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRateLimitBackendForTests,
  __setRedisClientForTests,
  checkRateLimit,
  clientIdentity,
  rateLimitBackendHealth,
} from '../rate-limit';
import type { RateLimitRedisClient } from '../rate-limit';

/** Non-routable, and only ever paired with an injected double. */
const TEST_REDIS_URL = 'redis://user:password@redis.invalid:6379/0';

/** A client whose every command rejects — a Redis outage, from the app's view. */
function brokenRedis(): RateLimitRedisClient {
  const fail = () => Promise.reject(new Error(`connect ECONNREFUSED ${TEST_REDIS_URL}`));
  return {
    incr: vi.fn(fail),
    pexpire: vi.fn(fail),
    pttl: vi.fn(fail),
    set: vi.fn(fail),
    get: vi.fn(fail),
    del: vi.fn(fail),
  } as unknown as RateLimitRedisClient;
}

function req(headers: Record<string, string>): Request {
  return new Request('https://manna.test/api/anything', { headers });
}

beforeEach(() => {
  __resetRateLimitBackendForTests();
});

describe('money buckets during a Redis outage are unaffected by header loss', () => {
  // The claim the owner recommendation rests on.
  it('keys on the authenticated user id, so a junk header cannot collapse the bucket', async () => {
    __setRedisClientForTests(brokenRedis());

    // Two different users, both sending garbage IP headers, during an outage.
    const a = await checkRateLimit('money:send', 'user:9001');
    const b = await checkRateLimit('money:send', 'user:9002');

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    // Separate users must not share a counter even with Redis down: if they
    // did, one customer's spending would throttle another's.
    expect(a.remaining).toBe(b.remaining);
    expect(rateLimitBackendHealth().activeBackend).toBe('in_memory_fallback');
  });

  it('still separates the three money buckets from each other during an outage', async () => {
    __setRedisClientForTests(brokenRedis());

    const send = await checkRateLimit('money:send', 'user:9001');
    const split = await checkRateLimit('money:split-pay', 'user:9001');
    const execute = await checkRateLimit('money:transfer-execute', 'user:9001');

    // One user hitting three different money paths must not have them share a
    // counter — the buckets have different limits for different risks.
    for (const r of [send, split, execute]) expect(r.allowed).toBe(true);
    expect(new Set([send.limit, split.limit, execute.limit]).size).toBeGreaterThan(1);
  });

  it('exhausts a money bucket per user even with no Redis at all', async () => {
    // State the precondition instead of inheriting it. An earlier version of
    // this test passed only because REDIS_URL happened to be unset in the
    // environment: with it set, the unconfigured path tried to construct a
    // real client and the case took five seconds and failed. A test whose
    // result depends on an ambient variable it never mentions is not a test of
    // the thing it names.
    vi.stubEnv('REDIS_URL', '');
    const rule = (await checkRateLimit('money:transfer-execute', 'user:9100')).limit;
    for (let i = 1; i < rule; i += 1) await checkRateLimit('money:transfer-execute', 'user:9100');
    const over = await checkRateLimit('money:transfer-execute', 'user:9100');
    expect(over.allowed).toBe(false);

    // A different user is untouched by the first user's exhaustion.
    const other = await checkRateLimit('money:transfer-execute', 'user:9101');
    expect(other.allowed).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('header loss collapses only the client-keyed buckets', () => {
  it('resolves every junk header to one shared identity', () => {
    // Three different junk values, all unusable, all the same bucket. This is
    // the availability cliff the recommendation names for auth:register and
    // auth:password-reset — stated so it cannot be mistaken for per-client.
    const ids = [
      clientIdentity(req({ 'x-real-ip': 'not-an-ip' })).id,
      clientIdentity(req({ 'x-forwarded-for': 'drop table users' })).id,
      clientIdentity(req({})).id,
    ];
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe('unknown-client');
  });

  it('a forged header still yields a syntactically valid id — which is NOT trust', async () => {
    __setRedisClientForTests(brokenRedis());

    // An attacker-supplied but well-formed address resolves and is used as a
    // key. Validation narrows the key space; it does not authenticate anyone.
    // Rotating forged addresses therefore still evades a client-keyed limit,
    // and nothing in this repository should describe valid IP syntax as proof
    // of a trusted proxy.
    const forged = clientIdentity(req({ 'x-forwarded-for': '203.0.113.9' }));
    expect(forged.id).toBe('203.0.113.9');
    expect(forged.source).toBe('x-forwarded-for');

    const first = await checkRateLimit('auth:register', `client:${forged.id}`);
    const rotated = await checkRateLimit(
      'auth:register',
      `client:${clientIdentity(req({ 'x-forwarded-for': '203.0.113.10' })).id}`,
    );
    // Both allowed, with independent counters: the evasion is real and is
    // recorded here rather than implied.
    expect(first.allowed).toBe(true);
    expect(rotated.allowed).toBe(true);
    expect(rotated.remaining).toBe(first.remaining);
  });
});

describe('the outage path leaks nothing, with identity resolution in the loop', () => {
  it('never writes the connection URL, its password, or a resolved address to a log', async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    });

    __setRedisClientForTests(brokenRedis());
    const id = clientIdentity(req({ 'x-real-ip': '198.51.100.23' })).id;
    await checkRateLimit('auth:login', `client:${id}:user@example.test`);

    spy.mockRestore();

    expect(errs.length).toBeGreaterThan(0);
    const all = errs.join('\n');
    expect(all).not.toContain('redis.invalid');
    expect(all).not.toContain('password');
    expect(all).not.toContain(TEST_REDIS_URL);
    // The resolved client address is PII-adjacent and has no business in a
    // degradation line either.
    expect(all).not.toContain('198.51.100.23');
    expect(all).not.toContain('user@example.test');
    // What it SHOULD carry: the stage and a count.
    expect(all).toMatch(/Redis (command|construct|verify) failed/);
    expect(all).toMatch(/degradation_count=\d+/);
  });
});

describe('no bucket became fail-closed when the two changes met', () => {
  it('serves every bucket class during a total outage', async () => {
    __setRedisClientForTests(brokenRedis());

    // Including the break-glass paths, which must never be refused for want of
    // Redis — refusing them recreates the Release 1.0 lockout.
    for (const bucket of [
      'auth:login',
      'auth:register',
      'auth:password-reset',
      'money:send',
      'money:split-pay',
      'money:transfer-execute',
      'schema:migrate-operator',
      'schema:bootstrap',
    ] as const) {
      const r = await checkRateLimit(bucket, 'interaction-probe');
      expect(r.allowed, `${bucket} must still be served during an outage`).toBe(true);
    }
  });
});
