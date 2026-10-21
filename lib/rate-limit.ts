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
  // Schema migration by an authenticated operator. The pipeline is idempotent,
  // so repetition is not itself damaging — but it executes ~103 DDL statements
  // including a balance-table rewrite under ACCESS EXCLUSIVE, so an unbounded
  // loop is a self-inflicted outage. The anonymous recovery paths have their
  // own, tighter limit (`schema:bootstrap`, 3/hour); this one covers the
  // operator path, which previously had none at all.
  //
  // WHAT THIS ACTUALLY GUARANTEES. Without REDIS_URL the counter is
  // process-local, so on Vercel the effective limit is `6 x instances`, and a
  // cold start resets it. Read "6/hour" as "6 per instance per hour" unless a
  // shared Redis backend is confirmed. That is weaker than the number looks
  // and is recorded as an open gap in CLAUDE.md rather than papered over.
  //
  // Deliberately NOT fail-closed when shared state is unavailable. Refusing
  // the migration whenever Redis is absent would make REDIS_URL — documented
  // as optional — a hard dependency of the only schema-migration path, and
  // of the command-line auth-repair break-glass. That is the lockout shape
  // Release 1.0 already suffered once. The threat here is an authenticated
  // operator's runaway loop, not an unauthenticated attacker, so degrading to
  // a weaker limit is the safer failure direction than denying the only way
  // to repair a schema.
  //
  // The real fix is a counter in PostgreSQL, which this endpoint has by
  // definition — it cannot run without DATABASE_URL. That needs a counter
  // table created ahead of the migration it limits, so it belongs with the
  // migration-versioning work in decision 0005 Phase 2, not here.
  'schema:migrate-operator': { limit: 6, windowSeconds: 3600 },
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

/**
 * ## Why this is a cooldown and not a boolean
 *
 * This was `let redisUnavailable = false`, set on the first failure and reset
 * only by two test-only helpers. There was no production reset path, so the
 * flag **latched**: one transient command error demoted that instance to
 * in-process counting permanently, and it stayed demoted after Redis recovered
 * — until the instance happened to recycle.
 *
 * That is worse than it sounds, because `new Redis(url)` almost never throws.
 * ioredis connects lazily, so the construction `catch` below is not the path
 * that fires in an outage; the *command* catch in `checkRateLimit` is. A single
 * dropped connection was therefore enough to turn every shared limit on that
 * instance into `limit × instances` for the rest of its life, including
 * `money:send` and `money:transfer-execute`.
 *
 * A timestamp instead of a boolean gives the same protection against hammering
 * a dead backend — no attempt while in cooldown — and then retries. Recovery
 * becomes automatic rather than dependent on instance churn.
 */
let redisDownUntil = 0;
const REDIS_RETRY_COOLDOWN_MS = 30_000;

/** Non-secret degradation accounting, so a silent fallback becomes observable. */
let redisDegradations = 0;
let lastDegradationAt: number | null = null;
let degraded = false;

/**
 * Serialises client construction.
 *
 * Without this, N concurrent requests arriving on a cold instance each await
 * `import('ioredis')` and each run `new Redis(url)`, so the instance opens N
 * connections and keeps only the last in `redisClient`; the rest leak. One
 * in-flight promise means concurrent callers share a single construction.
 */
let redisConstruction: Promise<RateLimitRedisClient | null> | null = null;

/**
 * Record a degradation to in-process counting.
 *
 * `stage` says where it happened, which is the one piece of detail an operator
 * needs and the one piece that cannot embed a credential. The raw error is
 * still never logged: a Redis client error can carry its connection URL,
 * password included.
 */
function markRedisDegraded(stage: 'construct' | 'command' | 'verify'): void {
  // Only discard the client when construction itself failed — there is no
  // usable client in that case anyway.
  //
  // Dropping it on a *command* failure looks tidier and is a connection leak.
  // Nothing calls `quit()`/`disconnect()` on the abandoned instance, so its
  // socket and its own reconnect loop keep running while the next request
  // after the cooldown builds a brand new client; repeated outages accumulate
  // orphans. That is the same leak the serialised construction above exists to
  // prevent, reintroduced one function later. Keeping the client also keeps
  // ioredis's own reconnect machinery, which is better at recovering a
  // connection than discarding it and starting over.
  if (stage === 'construct') redisClient = null;
  redisDownUntil = Date.now() + REDIS_RETRY_COOLDOWN_MS;
  redisDegradations += 1;
  lastDegradationAt = Date.now();
  degraded = true;
  console.error(
    `Rate limiter: Redis ${stage} failed, using in-process counters; ` +
      `shared limits are degraded to per-instance for up to ${REDIS_RETRY_COOLDOWN_MS}ms. ` +
      `degradation_count=${redisDegradations}`,
  );
}

/** Note a successful Redis operation, so recovery is as visible as failure. */
function markRedisHealthy(): void {
  if (degraded) {
    degraded = false;
    console.error('Rate limiter: Redis recovered, shared limits are in effect again.');
  }
}

/**
 * The backend's health, with nothing secret in it.
 *
 * Exported so a monitored path can answer "are limits actually shared?" without
 * an operator running the verification route by hand — and without the route's
 * side effects. Still per-instance: that is a property of the deployment, not
 * of this function, and no value here describes any instance but this one.
 */
export interface RateLimitBackendHealth {
  configured: boolean;
  activeBackend: 'redis' | 'in_memory_fallback';
  /** True while a cooldown is suppressing reconnection attempts. */
  inCooldown: boolean;
  cooldownRemainingMs: number;
  /** Cumulative degradations on this instance since it started. */
  degradations: number;
  lastDegradationAt: number | null;
}

/**
 * Read this instance's backend health. Pure — no Redis contact, no side
 * effects, unlike `verifyRateLimitBackend()`, so a monitored path can poll it
 * freely.
 *
 * `activeBackend` is `'redis'` only on an *observation*: a client exists, no
 * cooldown is open, and some Redis operation has succeeded since the last
 * degradation. A retained client whose cooldown has merely elapsed still
 * reports the fallback, because a timer expiring is not evidence the backend
 * recovered.
 */
export function rateLimitBackendHealth(): RateLimitBackendHealth {
  const now = Date.now();
  const inCooldown = now < redisDownUntil;
  return {
    configured: Boolean(process.env.REDIS_URL),
    // `!degraded` matters as much as `!inCooldown`. When the cooldown expires
    // the client is still the one that just failed, and nothing has yet proved
    // it works — the next command may fall straight back to in-process
    // counting. Reporting `redis` in that window would claim shared limiting
    // on the strength of a timer rather than an observation. `degraded` clears
    // only when a real Redis operation succeeds.
    activeBackend: redisClient && !inCooldown && !degraded ? 'redis' : 'in_memory_fallback',
    inCooldown,
    cooldownRemainingMs: inCooldown ? redisDownUntil - now : 0,
    degradations: redisDegradations,
    lastDegradationAt,
  };
}

/**
 * The shared Redis client, or `null` when rate limiting must count in process.
 *
 * Returns `null` without contacting Redis while a cooldown is open, which is
 * what bounds a degradation instead of latching it (see `redisDownUntil`), and
 * when `REDIS_URL` is unset. Concurrent callers on a cold instance share one
 * construction through `redisConstruction` rather than each opening a
 * connection.
 */
async function getRedis(): Promise<RateLimitRedisClient | null> {
  if (Date.now() < redisDownUntil) return null;
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) return null;

  if (redisConstruction) return redisConstruction;

  redisConstruction = (async () => {
    try {
      // Optional dependency: only required when REDIS_URL is configured.
      const mod = (await import('ioredis')) as unknown as {
        default: new (url: string) => RateLimitRedisClient;
      };
      redisClient = new mod.default(process.env.REDIS_URL as string);
      return redisClient;
    } catch {
      // A missing package or unreachable server must not take the app down; fall
      // back to in-process counting. Do not log the connection error: it can
      // contain a Redis URL with credentials.
      markRedisDegraded('construct');
      return null;
    } finally {
      redisConstruction = null;
    }
  })();

  return redisConstruction;
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
      //
      // Deliberately does NOT record a degradation, unlike the two branches
      // below. `NX` refusing means the key already existed, which says Redis
      // answered correctly — the backend is healthy and the probe simply could
      // not claim its key. Opening a cooldown here would demote a working
      // backend on the strength of a 1-in-2^122 name clash. Do not add
      // `markRedisDegraded` for symmetry with the branches below.
      return inMemoryVerification(true, 'failed', 'not_required');
    }
    keyMayExist = true;

    // These two branches fail *without throwing*, so the catch below never
    // sees them. Recording the degradation here is what keeps the answer this
    // function returns — `verification: 'failed'`, `activeBackend:
    // 'in_memory_fallback'` — consistent with what `rateLimitBackendHealth()`
    // reports and with what the next `checkRateLimit()` actually does. Without
    // it the route says the backend failed while health still says redis and
    // the next call retries the retained client.
    const observed = await redis.get(key);
    if (observed !== marker) {
      markRedisDegraded('verify');
      return inMemoryVerification(true, 'failed', 'ttl_fallback');
    }

    const deleted = await redis.del(key);
    keyMayExist = false;
    if (deleted !== 1) {
      markRedisDegraded('verify');
      return inMemoryVerification(true, 'failed', 'ttl_fallback');
    }

    // A completed set/get/delete round trip is proof the backend works, so it
    // clears the degraded flag exactly as a successful rate-limit command
    // does. Without this, `rateLimitBackendHealth()` would keep reporting the
    // fallback after an operator's verification passed — the route and the
    // health report disagreeing about the same backend, which is the defect
    // this function already had once in the other direction.
    //
    // Placed after the delete check on purpose: neither an `NX` collision nor
    // a failed cleanup reaches here, and neither should clear a degradation.
    markRedisHealthy();
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
    markRedisDegraded('verify');
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
    markRedisHealthy();
    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      limit: rule.limit,
      resetAt: Date.now() + (ttl > 0 ? ttl : rule.windowSeconds * 1000),
    };
  } catch {
    // Do not log `err`: a Redis client error can include its credential-bearing
    // connection URL. Preserve availability with the documented local fallback.
    markRedisDegraded('command');
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
  redisConstruction = null;
  // Deliberately does NOT clear `redisDownUntil` or `degraded`. Injecting a
  // client is not a recovery event, and nothing in production clears either
  // flag as a side effect of acquiring one — a helper that did would hide the
  // very transition the degradation tests exist to observe. Use
  // `__resetRateLimitBackendForTests()` for isolation between cases.
}

/** Test-only: restore Redis module state between isolated tests. */
export function __resetRateLimitBackendForTests(): void {
  redisClient = null;
  redisDownUntil = 0;
  redisConstruction = null;
  redisDegradations = 0;
  lastDegradationAt = null;
  degraded = false;
  memoryCounters.clear();
}
