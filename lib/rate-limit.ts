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
  'contacts:add': { limit: 30, windowSeconds: 3600 },
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

type RedisLike = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
};

let redisClient: RedisLike | null = null;
let redisUnavailable = false;

async function getRedis(): Promise<RedisLike | null> {
  if (redisUnavailable) return null;
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) return null;

  try {
    // Optional dependency: only required when REDIS_URL is configured.
    const mod = (await import('ioredis')) as unknown as {
      default: new (url: string) => RedisLike;
    };
    redisClient = new mod.default(process.env.REDIS_URL);
    return redisClient;
  } catch (err) {
    // A missing package or unreachable server must not take the app down; fall
    // back to in-process counting and say so once.
    console.error('Rate limiter: Redis unavailable, falling back to in-process counters.', err);
    redisUnavailable = true;
    return null;
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
  } catch (err) {
    console.error('Rate limiter: Redis command failed, using in-process counter.', err);
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
 * Falls back to a constant when no forwarding header is present, which makes the
 * limit global rather than per-client. That is the safe direction: it throttles
 * more, not less.
 */
export function clientIdentifier(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown-client';
}

/** Test-only: clear in-process counters between cases. */
export function __resetInMemoryCounters(): void {
  memoryCounters.clear();
}
