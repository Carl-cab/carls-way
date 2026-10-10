import { randomUUID } from 'node:crypto';

/**
 * Fixed-window rate limiting.
 *
 * Backed by Redis when REDIS_URL is set, and by an in-process map otherwise.
 *
 * The in-process fallback is honest about what it is: on a serverless platform
 * each instance keeps its own counter, so the effective limit is
 * `limit x instances`. That is meaningfully weaker than a shared counter and is
 * NOT sufficient on its own for a production auth endpoint. It exists so local
 * development and tests behave sensibly, and so a Redis outage degrades to
 * "weaker limiting" rather than "no service".
 *
 * Redis is loaded lazily and only when configured, so the dependency stays
 * optional and nothing changes for deployments that do not use it.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Unix ms when the current window resets. */
  resetAt: number;
}

export interface RateLimitRule {
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Default rules per endpoint class.
 *
 * Auth endpoints are tightest because they are the brute-force target; money
 * movement is limited to blunt abusive automation without impeding a person
 * making several genuine payments.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  'auth:login': { limit: 5, windowSeconds: 900 },
  'auth:register': { limit: 3, windowSeconds: 3600 },
  'auth:password-reset': { limit: 3, windowSeconds: 3600 },
  'auth:2fa': { limit: 5, windowSeconds: 900 },
  'money:send': { limit: 20, windowSeconds: 3600 },
  'money:split-pay': { limit: 30, windowSeconds: 3600 },
  // Submitting a confirmed transfer to a real payment rail. Keyed on the user
  // id, not the IP, because this is always an authenticated call and the limit
  // should follow the account rather than the network it dials from.
  //
  // Lower than money:send because each submission is one bank instruction, and
  // a legitimate person executes a handful of transfers an hour at most. The
  // claim already stops a single intent being submitted twice — this bounds how
  // many *different* intents one account can push at a rail in a burst, which
  // the claim says nothing about.
  'money:transfer-execute': { limit: 10, windowSeconds: 3600 },
  'contacts:add': { limit: 30, windowSeconds: 3600 },
  // Provider webhooks are server-to-server and signature-verified, but an
  // unauthenticated flood still burns compute before verification rejects it.
  // 120/hour per source IP is far above legitimate provider burst traffic.
  'webhook:events': { limit: 120, windowSeconds: 3600 },
  default: { limit: 100, windowSeconds: 900 },
};

// ── In-process fallback ──────────────────────────────────────────────────────

const memoryCounters = new Map<string, { count: number; resetAt: number }>();

function checkInMemory(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const existing = memoryCounters.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    memoryCounters.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: rule.limit - 1, limit: rule.limit, resetAt };
  }

  existing.count += 1;
  const allowed = existing.count <= rule.limit;
  return {
    allowed,
    remaining: Math.max(0, rule.limit - existing.count),
    limit: rule.limit,
    resetAt: existing.resetAt,
  };
}

/** Drop expired entries so the fallback map cannot grow without bound. */
function pruneMemory(): void {
  const now = Date.now();
  for (const [key, value] of memoryCounters) {
    if (value.resetAt <= now) memoryCounters.delete(key);
  }
}

// ── Redis backend ────────────────────────────────────────────────────────────

export type RateLimitRedisClient = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  set(key: string, value: string, ...args: string[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
};

let redisClient: RateLimitRedisClient | null = null;
let redisUnavailable = false;

async function getRedis(): Promise<RateLimitRedisClient | null> {
  if (redisUnavailable) return null;
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) return null;

  try {
    // Optional dependency: only required when REDIS_URL is configured.
    const mod = (await import('ioredis')) as unknown as {
      default: new (url: string) => RateLimitRedisClient;
    };
    redisClient = new mod.default(process.env.REDIS_URL);
    return redisClient;
  } catch {
    // A missing package or unreachable server must not take the app down; fall
    // back to in-process counting. Do not log the connection error: it can
    // contain a Redis URL with credentials.
    console.error('Rate limiter: Redis unavailable, falling back to in-process counters.');
    redisUnavailable = true;
    return null;
  }
}

const REDIS_VERIFICATION_TTL_MS = 5_000;

export interface RateLimitBackendVerification {
  /** Whether REDIS_URL was present. The URL itself is never returned. */
  configured: boolean;
  /** Whether Redis completed the isolated write/read/delete check. */
  reachable: boolean;
  /** The backend that rate limiting must currently rely on. */
  activeBackend: 'redis' | 'in_memory_fallback';
  /** A terse, non-secret result for an authorized operational caller. */
  verification: 'set_get_delete' | 'not_run' | 'failed';
  /** Cleanup state of the isolated key; TTL bounds any failed cleanup. */
  cleanup: 'confirmed' | 'not_required' | 'ttl_fallback';
}

function inMemoryVerification(
  configured: boolean,
  verification: RateLimitBackendVerification['verification'],
  cleanup: RateLimitBackendVerification['cleanup'],
): RateLimitBackendVerification {
  return {
    configured,
    reachable: false,
    activeBackend: 'in_memory_fallback',
    verification,
    cleanup,
  };
}

/**
 * Verify the shared Redis backend without reading or disclosing its URL.
 *
 * This function is deliberately intended for a protected operations endpoint,
 * not a liveness probe. When configured, it writes a random, namespaced key
 * with NX and a five-second TTL, reads back only the random marker it wrote,
 * then deletes the key. The TTL is a bounded cleanup backstop if the process or
 * Redis connection fails between write and delete. It never touches rate-limit
 * counters and never returns an error, host, username, password, or URL.
 */
export async function verifyRateLimitBackend(): Promise<RateLimitBackendVerification> {
  const configured = Boolean(process.env.REDIS_URL);
  if (!configured) {
    return inMemoryVerification(false, 'not_run', 'not_required');
  }

  const redis = await getRedis();
  if (!redis) {
    return inMemoryVerification(true, 'not_run', 'not_required');
  }

  const key = `ratelimit:verification:${randomUUID()}`;
  const marker = randomUUID();
  let keyMayExist = false;

  try {
    const wrote = await redis.set(key, marker, 'PX', String(REDIS_VERIFICATION_TTL_MS), 'NX');
    if (wrote !== 'OK') {
      // A random UUID collision is not expected, but do not overwrite any key
      // if it somehow occurs. The key was not created by this check.
      return inMemoryVerification(true, 'failed', 'not_required');
    }
    keyMayExist = true;

    const observed = await redis.get(key);
    if (observed !== marker) {
      return inMemoryVerification(true, 'failed', 'ttl_fallback');
    }

    const deleted = await redis.del(key);
    keyMayExist = false;
    if (deleted !== 1) {
      return inMemoryVerification(true, 'failed', 'ttl_fallback');
    }

    return {
      configured: true,
      reachable: true,
      activeBackend: 'redis',
      verification: 'set_get_delete',
      cleanup: 'confirmed',
    };
  } catch {
    // Do not log the connection error. Client errors often embed a URL and
    // credentials. The running limiter will use its documented memory fallback.
    redisUnavailable = true;
    return inMemoryVerification(true, 'failed', keyMayExist ? 'ttl_fallback' : 'not_required');
  } finally {
    if (keyMayExist) {
      try {
        await redis.del(key);
      } catch {
        // The short TTL is the final cleanup guard. There is intentionally no
        // error detail here because Redis client errors can contain credentials.
      }
    }
  }
}

/**
 * Consume one unit against `identifier` for the given rule.
 *
 * `identifier` should be the most specific stable thing available — a user id
 * where the caller is authenticated, otherwise the client IP. Never a value the
 * client fully controls (a header it can set freely), or the limit is trivially
 * bypassed.
 */
export async function checkRateLimit(
  bucket: keyof typeof RATE_LIMITS | string,
  identifier: string,
  ruleOverride?: RateLimitRule,
): Promise<RateLimitResult> {
  const rule = ruleOverride ?? RATE_LIMITS[bucket] ?? RATE_LIMITS.default;
  const key = `ratelimit:${bucket}:${identifier}`;

  const redis = await getRedis();
  if (!redis) {
    pruneMemory();
    return checkInMemory(key, rule);
  }

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, rule.windowSeconds * 1000);
    }
    const ttl = await redis.pttl(key);
    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      limit: rule.limit,
      resetAt: Date.now() + (ttl > 0 ? ttl : rule.windowSeconds * 1000),
    };
  } catch {
    // Do not log `err`: a Redis client error can include its credential-bearing
    // connection URL. Preserve availability with the documented local fallback.
    console.error('Rate limiter: Redis command failed, using in-process counter.');
    redisUnavailable = true;
    pruneMemory();
    return checkInMemory(key, rule);
  }
}

/** Standard headers so clients can back off rather than hammer. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
    ...(result.allowed
      ? {}
      : { 'Retry-After': String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))) }),
  };
}

/**
 * Client identifier for an unauthenticated request.
 *
 * ## Which part of X-Forwarded-For can be trusted
 *
 * `X-Forwarded-For` is built left to right: each proxy appends the address it
 * received the connection from. The client controls what it sends, so the
 * *leftmost* entries are whatever the client made up, and only the entry
 * appended by the nearest trusted proxy is authentic — the rightmost one.
 *
 * This read the leftmost entry. Every rate limit keyed on it could therefore be
 * bypassed outright: send a different `X-Forwarded-For: <random>` per request
 * and each attempt looks like a new client, so the counter never accumulates.
 * That removes the ceiling from login, registration and password reset at once.
 *
 * `x-real-ip` is preferred where present because a proxy that sets it writes a
 * single address it observed directly, with no client-supplied prefix to strip.
 *
 * Falls back to a constant when no forwarding header is present, which makes the
 * limit global rather than per-client. That is the safe direction: it throttles
 * more, not less.
 *
 * This is correct for a deployment sitting behind exactly one trusted proxy,
 * which is how Vercel serves this app. Behind a chain of N trusted proxies the
 * authentic entry is the Nth from the right; that needs a configured hop count
 * rather than a fixed rule, and should be revisited if the topology changes.
 */
export function clientIdentifier(req: { headers: { get(name: string): string | null } }): string {
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return 'unknown-client';
}

/** Test-only: clear in-process counters between cases. */
export function __resetInMemoryCounters(): void {
  memoryCounters.clear();
}

/** Test-only: inject a Redis double without creating any network connection. */
export function __setRedisClientForTests(client: RateLimitRedisClient | null): void {
  redisClient = client;
  redisUnavailable = false;
}

/** Test-only: restore Redis module state between isolated tests. */
export function __resetRateLimitBackendForTests(): void {
  redisClient = null;
  redisUnavailable = false;
  memoryCounters.clear();
}
