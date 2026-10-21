/**
 * Redis degradation, recovery and concurrency in the rate limiter.
 *
 * ## The defect these cover
 *
 * `redisUnavailable` was a boolean set on the first failure with no production
 * reset path. One transient command error demoted an instance to in-process
 * counting **permanently** — it stayed demoted after Redis recovered, until the
 * instance happened to recycle. Every shared limit on that instance became
 * `limit × instances` for the rest of its life, `money:send` and
 * `money:transfer-execute` included.
 *
 * The mutation that proves these tests bite: replace the cooldown comparison in
 * `getRedis()` with a permanent flag again and "retries once the cooldown has
 * elapsed" fails.
 *
 * Time is driven with fake timers rather than real sleeps, so the cooldown is
 * exercised deterministically instead of by waiting 30 seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRateLimitBackendForTests,
  __setRedisClientForTests,
  checkRateLimit,
  rateLimitBackendHealth,
  verifyRateLimitBackend,
} from '../rate-limit';
import type { RateLimitRedisClient } from '../rate-limit';

/** Non-routable, and only ever paired with an injected double. */
const TEST_REDIS_URL = 'redis://user:password@redis.invalid:6379/0';

function redisDouble(overrides: Partial<RateLimitRedisClient> = {}): RateLimitRedisClient {
  return {
    incr: vi.fn().mockResolvedValue(1),
    pexpire: vi.fn().mockResolvedValue(1),
    pttl: vi.fn().mockResolvedValue(5_000),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.REDIS_URL;
  __resetRateLimitBackendForTests();
  // Silence the degradation lines; their content is asserted explicitly below.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.REDIS_URL;
  __resetRateLimitBackendForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('degradation is recorded rather than silent', () => {
  it('falls back to in-process counting when a command fails', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(new Error('ECONNRESET')) }));

    const result = await checkRateLimit('auth:login', 'client-a');

    // Availability is preserved: the caller still gets a decision.
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);

    const health = rateLimitBackendHealth();
    expect(health.activeBackend).toBe('in_memory_fallback');
    expect(health.degradations).toBe(1);
    expect(health.inCooldown).toBe(true);
    expect(health.lastDegradationAt).toBeTypeOf('number');
  });

  it('names the stage and the count, and never the connection URL', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(new Error('boom')) }));
    const logged = vi.mocked(console.error);

    await checkRateLimit('money:send', 'user-7');

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(line).toContain('command');
    expect(line).toContain('degradation_count=1');
    // The whole reason the raw error is withheld.
    expect(line).not.toContain('password');
    expect(line).not.toContain('redis.invalid');
    expect(line).not.toContain('boom');
  });

  it('counts repeated degradations so a flapping backend is visible', async () => {
    vi.useFakeTimers();
    process.env.REDIS_URL = TEST_REDIS_URL;
    const failing = redisDouble({ incr: vi.fn().mockRejectedValue(new Error('down')) });

    __setRedisClientForTests(failing);
    await checkRateLimit('auth:login', 'client-b');
    expect(rateLimitBackendHealth().degradations).toBe(1);

    // A second failure only happens once the cooldown lets a retry through.
    vi.advanceTimersByTime(30_001);
    __setRedisClientForTests(failing);
    await checkRateLimit('auth:login', 'client-b');
    expect(rateLimitBackendHealth().degradations).toBe(2);
  });
});

describe('the cooldown bounds the degradation instead of latching it', () => {
  it('does not touch Redis again while the cooldown is open', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    const incr = vi.fn().mockRejectedValue(new Error('down'));
    __setRedisClientForTests(redisDouble({ incr }));

    await checkRateLimit('auth:login', 'client-c');
    await checkRateLimit('auth:login', 'client-c');
    await checkRateLimit('auth:login', 'client-c');

    // One attempt, then suppressed — the point of the cooldown is not to
    // hammer a backend that just failed.
    expect(incr).toHaveBeenCalledTimes(1);
    expect(rateLimitBackendHealth().inCooldown).toBe(true);
  });

  it('keeps the client across a command failure instead of orphaning it', async () => {
    vi.useFakeTimers();
    process.env.REDIS_URL = TEST_REDIS_URL;
    // One double, failing then healthy: if a command failure discarded the
    // client, the retry after the cooldown would construct a new one instead
    // of reaching this instance — and the old one would be left with its
    // socket and reconnect loop running, never disconnected.
    let fail = true;
    const incr = vi.fn(async () => {
      if (fail) throw new Error('ECONNRESET');
      return 1;
    });
    __setRedisClientForTests(redisDouble({ incr }));

    await checkRateLimit('auth:login', 'keepalive');
    expect(incr).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    fail = false;
    // No re-injection: the retry must reuse the client already held.
    const result = await checkRateLimit('auth:login', 'keepalive');

    expect(incr).toHaveBeenCalledTimes(2);
    expect(result.allowed).toBe(true);
    expect(rateLimitBackendHealth().activeBackend).toBe('redis');
  });

  it('reports the fallback during a cooldown even though the client is retained', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(new Error('down')) }));

    await checkRateLimit('auth:login', 'health-during-cooldown');

    // Retaining the client must not make health claim Redis is in use.
    expect(rateLimitBackendHealth().activeBackend).toBe('in_memory_fallback');
  });

  it('retries once the cooldown has elapsed, and recovers', async () => {
    vi.useFakeTimers();
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(new Error('down')) }));

    await checkRateLimit('money:transfer-execute', 'user-9');
    expect(rateLimitBackendHealth().activeBackend).toBe('in_memory_fallback');

    vi.advanceTimersByTime(30_001);

    // Redis is back. Under the old boolean latch this instance would have
    // stayed on in-process counters until it recycled.
    const healthy = redisDouble();
    __setRedisClientForTests(healthy);
    const result = await checkRateLimit('money:transfer-execute', 'user-9');

    expect(healthy.incr).toHaveBeenCalledTimes(1);
    expect(result.allowed).toBe(true);
    expect(rateLimitBackendHealth().activeBackend).toBe('redis');
    expect(rateLimitBackendHealth().inCooldown).toBe(false);
  });

  it('reports the remaining cooldown so it can be monitored', async () => {
    vi.useFakeTimers();
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(new Error('down')) }));

    await checkRateLimit('auth:register', 'client-d');
    expect(rateLimitBackendHealth().cooldownRemainingMs).toBeGreaterThan(0);

    vi.advanceTimersByTime(10_000);
    const remaining = rateLimitBackendHealth().cooldownRemainingMs;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(20_000);

    vi.advanceTimersByTime(20_001);
    expect(rateLimitBackendHealth().cooldownRemainingMs).toBe(0);
  });

  it('announces recovery exactly once, not on every later success', async () => {
    vi.useFakeTimers();
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(new Error('down')) }));
    await checkRateLimit('auth:login', 'client-e');

    vi.advanceTimersByTime(30_001);
    const logged = vi.mocked(console.error);
    logged.mockClear();

    __setRedisClientForTests(redisDouble());
    await checkRateLimit('auth:login', 'client-e');
    await checkRateLimit('auth:login', 'client-e');

    const recoveries = logged.mock.calls.filter((c) => String(c[0]).includes('recovered'));
    expect(recoveries).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('a burst during an outage degrades once, not once per request', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    const incr = vi.fn().mockRejectedValue(new Error('down'));
    __setRedisClientForTests(redisDouble({ incr }));

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => checkRateLimit('auth:login', `burst-${i}`)),
    );

    // Every caller is still served.
    expect(results.every((r) => r.allowed)).toBe(true);
    // All eight start before any has recorded the failure, so each in-flight
    // call reaches the client once; what must not happen is the count growing
    // after the cooldown is set.
    expect(rateLimitBackendHealth().inCooldown).toBe(true);
    expect(rateLimitBackendHealth().degradations).toBeLessThanOrEqual(results.length);
    expect(rateLimitBackendHealth().degradations).toBeGreaterThanOrEqual(1);
  });

  it('constructs the Redis client once under a concurrent cold start', async () => {
    // The real serialisation test. It has to mock `ioredis` and re-import the
    // module, because an injected double skips construction entirely and an
    // unconfigured module returns null before it ever reads
    // `redisConstruction` — so neither observes the thing being asserted.
    vi.resetModules();
    // A function declaration, not an arrow: `new mod.default(url)` cannot
    // construct an arrow function.
    const ctor = vi.fn(function constructed(this: unknown) {
      return redisDouble();
    });
    vi.doMock('ioredis', () => ({ default: ctor }));

    try {
      const isolated = await import('../rate-limit');
      process.env.REDIS_URL = TEST_REDIS_URL;

      await Promise.all(
        Array.from({ length: 5 }, (_, i) => isolated.checkRateLimit('auth:login', `cold-${i}`)),
      );

      // Five concurrent callers on a cold instance, one connection. Without the
      // in-flight promise each opens its own and all but the last leak.
      expect(ctor).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('ioredis');
      vi.resetModules();
    }
  });

  it('shares one in-process counter across concurrent callers when unconfigured', async () => {
    // No REDIS_URL and no injected client: getRedis() takes the unconfigured
    // path for every caller, which must stay allocation-free and consistent.
    // This says nothing about construction — see the test above.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkRateLimit('auth:login', 'shared-key')),
    );

    // One shared in-process counter, so the fifth call has consumed five units
    // of the 5/window login limit rather than each starting its own.
    expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0]);
    expect(rateLimitBackendHealth().activeBackend).toBe('in_memory_fallback');
    expect(rateLimitBackendHealth().degradations).toBe(0);
  });
});

describe('the verification route shares the same degradation accounting', () => {
  it('records a degradation when the isolated check throws', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ set: vi.fn().mockRejectedValue(new Error('down')) }));

    const result = await verifyRateLimitBackend();

    expect(result.reachable).toBe(false);
    expect(result.verification).toBe('failed');
    expect(result.activeBackend).toBe('in_memory_fallback');
    expect(rateLimitBackendHealth().degradations).toBe(1);
    expect(rateLimitBackendHealth().inCooldown).toBe(true);
  });

  it('records a degradation when the read-back marker does not match', async () => {
    // Fails without throwing, so the catch never sees it. Before this, the
    // route answered verification:'failed' / in_memory_fallback while health
    // still said redis and the next checkRateLimit retried the client.
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(
      redisDouble({ set: vi.fn().mockResolvedValue('OK'), get: vi.fn().mockResolvedValue('someone-elses-marker') }),
    );

    const result = await verifyRateLimitBackend();

    expect(result.verification).toBe('failed');
    expect(result.activeBackend).toBe('in_memory_fallback');
    // The answer and the health report must agree.
    expect(rateLimitBackendHealth().activeBackend).toBe('in_memory_fallback');
    expect(rateLimitBackendHealth().degradations).toBe(1);
    expect(rateLimitBackendHealth().inCooldown).toBe(true);
  });

  it('records a degradation when the cleanup delete does not remove one key', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    const marker: { value?: string } = {};
    __setRedisClientForTests(
      redisDouble({
        set: vi.fn(async (_k: string, v: string) => {
          marker.value = v;
          return 'OK';
        }),
        get: vi.fn(async () => marker.value ?? null),
        del: vi.fn().mockResolvedValue(0),
      }),
    );

    const result = await verifyRateLimitBackend();

    expect(result.verification).toBe('failed');
    expect(rateLimitBackendHealth().degradations).toBe(1);
    expect(rateLimitBackendHealth().inCooldown).toBe(true);
  });

  it('does NOT record a degradation when NX refuses on a key collision', async () => {
    // The deliberate asymmetry. NX refusing means the key already existed,
    // which proves Redis answered correctly — the probe just could not claim
    // its name. Opening a cooldown here would demote a healthy backend on a
    // 1-in-2^122 clash, so this must not follow the two branches above.
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ set: vi.fn().mockResolvedValue(null) }));

    const result = await verifyRateLimitBackend();

    expect(result.verification).toBe('failed');
    expect(result.cleanup).toBe('not_required');
    expect(rateLimitBackendHealth().degradations).toBe(0);
    expect(rateLimitBackendHealth().inCooldown).toBe(false);
  });

  it('leaves health untouched when Redis is simply not configured', async () => {
    const result = await verifyRateLimitBackend();

    expect(result.configured).toBe(false);
    // Unconfigured is not a degradation; conflating the two would make the
    // counter useless as an outage signal.
    expect(rateLimitBackendHealth().degradations).toBe(0);
    expect(rateLimitBackendHealth().inCooldown).toBe(false);
  });
});

describe('fail-open is preserved deliberately', () => {
  it('still issues a decision for the schema break-glass during an outage', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(new Error('down')) }));

    // Refusing here would make REDIS_URL a hard dependency of the only
    // schema-migration path, which is the Release 1.0 lockout shape.
    const result = await checkRateLimit('schema:bootstrap', '203.0.113.7');

    expect(result.allowed).toBe(true);
  });
});
