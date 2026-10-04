import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetRateLimitBackendForTests,
  __setRedisClientForTests,
  checkRateLimit,
  verifyRateLimitBackend,
} from '../rate-limit';
import type { RateLimitRedisClient } from '../rate-limit';

const TEST_REDIS_URL = 'redis://verification-user:verification-password@redis.invalid:6379/0';

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
  // This suite supplies a non-routable test URL only when a Redis double is
  // injected. It never initiates a network connection.
  delete process.env.REDIS_URL;
  __resetRateLimitBackendForTests();
});

afterEach(() => {
  delete process.env.REDIS_URL;
  __resetRateLimitBackendForTests();
  vi.restoreAllMocks();
});

describe('shared Redis rate-limit verification', () => {
  it('reports the in-memory fallback when Redis is not configured', async () => {
    const result = await verifyRateLimitBackend();

    expect(result).toEqual({
      configured: false,
      reachable: false,
      activeBackend: 'in_memory_fallback',
      verification: 'not_run',
      cleanup: 'not_required',
    });
  });

  it('performs an isolated NX/TTL set-get-delete verification and cleans up', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    const values = new Map<string, string>();
    const redis = redisDouble({
      set: vi.fn(async (key: string, value: string, ...args: string[]) => {
        expect(args).toEqual(['PX', '5000', 'NX']);
        if (values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      del: vi.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
    });
    __setRedisClientForTests(redis);

    const result = await verifyRateLimitBackend();

    expect(result).toEqual({
      configured: true,
      reachable: true,
      activeBackend: 'redis',
      verification: 'set_get_delete',
      cleanup: 'confirmed',
    });
    expect(redis.set).toHaveBeenCalledOnce();
    expect(redis.get).toHaveBeenCalledOnce();
    expect(redis.del).toHaveBeenCalledOnce();
    expect((redis.set as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(
      /^ratelimit:verification:/,
    );
    expect(values.size).toBe(0);
  });

  it('fails closed to the in-memory limiter when an isolated Redis check is unreachable', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    const redis = redisDouble({
      set: vi.fn().mockRejectedValue(new Error(`connection refused: ${TEST_REDIS_URL}`)),
    });
    __setRedisClientForTests(redis);

    const verification = await verifyRateLimitBackend();
    const fallback = await checkRateLimit('verification-unreachable', 'operator-test', {
      limit: 1,
      windowSeconds: 60,
    });

    expect(verification).toEqual({
      configured: true,
      reachable: false,
      activeBackend: 'in_memory_fallback',
      verification: 'failed',
      cleanup: 'not_required',
    });
    expect(fallback).toMatchObject({ allowed: true, remaining: 0, limit: 1 });
    // Redis is marked unavailable after the failed check, so normal rate
    // limiting is available from the in-process fallback without retrying it.
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('does not expose a configured Redis URL or error text in the public result or logs', async () => {
    process.env.REDIS_URL = TEST_REDIS_URL;
    const error = new Error(`connection refused: ${TEST_REDIS_URL}`);
    __setRedisClientForTests(redisDouble({ incr: vi.fn().mockRejectedValue(error) }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const rateLimitResult = await checkRateLimit('verification-secret', 'operator-test', {
      limit: 1,
      windowSeconds: 60,
    });

    expect(rateLimitResult.allowed).toBe(true);
    expect(JSON.stringify(rateLimitResult)).not.toContain(TEST_REDIS_URL);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(TEST_REDIS_URL);
  });
});
