import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import type postgres from 'postgres';
import bcrypt from 'bcryptjs';
import { getSql } from '@/lib/db';
import { jsonbParam } from '@/lib/jsonb';
import {
  type MinorUnits, MoneyValidationError, parsePositiveMoney, parseSignedDatabaseMoney,
  toDatabaseDecimal, toSignedDatabaseDecimal,
} from '@/lib/money';

export const COOKIE_NAME = 'manna-token';

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is not set. This is required in production.');
    }
    return 'dev-secret-change-in-production';
  }
  return secret;
}

// ─── Velocity Limits ────────────────────────────────────────────────────────
// Public limit constants remain major-unit integers for existing consumers and
// human-readable errors. check/record/reverse APIs below take integer cents.
export const VELOCITY_LIMITS = {
  new_user: {
    hourly_max_amount: 500,
    daily_max_amount: 1000,
    daily_max_count: 5,
    weekly_max_amount: 2500,
  },
  verified_user: {
    hourly_max_amount: 5000,
    daily_max_amount: 10000,
    daily_max_count: 25,
    weekly_max_amount: 25000,
  },
} as const;

/**
 * Ceiling applied to a single velocity reversal. Preserves the cap the
 * previous implementation carried inline, so one malformed return cannot
 * release unbounded headroom.
 */
export const MAX_SINGLE_TRANSFER_AMOUNT = 100000;

export interface JWTPayload {
  userId: number;
  email: string;
  username: string;
  /**
   * The account's token version at the moment this token was issued.
   *
   * A signed JWT is otherwise valid until it expires — there was no way to
   * revoke one, so a stolen token stayed usable for a full seven days and
   * changing the password did nothing to it. Comparing this against
   * `users.token_version` on each request makes a bump an immediate,
   * account-wide logout.
   */
  tv?: number;
}

// ─── Token helpers ───────────────────────────────────────────────────────────
export function signToken(payload: JWTPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * Issue a token carrying the account's current version.
 *
 * Every login path should use this rather than signToken directly, so the
 * version is never omitted by accident — a token without one is rejected.
 */
export async function signTokenForUser(
  payload: Omit<JWTPayload, 'tv'>,
): Promise<string> {
  const sql = getSql();
  const rows = await sql<{ token_version: number }[]>`
    SELECT token_version FROM users WHERE id = ${payload.userId}
  `;
  return signToken({ ...payload, tv: Number(rows[0]?.token_version ?? 0) });
}

/**
 * Invalidate every token already issued for an account.
 *
 * Called on password reset: a password change that leaves the attacker's
 * existing session alive is not a recovery.
 */
export async function revokeUserSessions(
  userId: number,
  executor?: postgres.ISql,
): Promise<void> {
  const sql = executor ?? getSql();
  await sql`UPDATE users SET token_version = token_version + 1 WHERE id = ${userId}`;
}

export async function getAuthUser(): Promise<JWTPayload | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return null;

    const payload = verifyToken(token);
    if (!payload) return null;

    // A token with no version predates revocation support and cannot be
    // checked, so it is refused. Deploying this logs everyone in once more;
    // that is the intended one-time cost of being able to revoke at all.
    if (typeof payload.tv !== 'number') return null;

    const sql = getSql();
    const rows = await sql<{ token_version: number }[]>`
      SELECT token_version FROM users WHERE id = ${payload.userId}
    `;
    // Unknown account, or a version that has moved on: fail closed.
    if (!rows[0]) return null;
    if (Number(rows[0].token_version) !== payload.tv) return null;

    return payload;
  } catch {
    return null;
  }
}

// ─── Account lockout ─────────────────────────────────────────────────────────
export async function checkAccountLocked(userId: number): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`SELECT locked_until FROM users WHERE id = ${userId}`;
  if (!rows[0]) return false;
  const lockedUntil = rows[0].locked_until as Date | null;
  if (lockedUntil && new Date(lockedUntil) > new Date()) return true;
  return false;
}

export async function recordFailedLogin(userId: number): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE users
    SET failed_login_attempts = failed_login_attempts + 1,
        locked_until = CASE
          WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '30 minutes'
          ELSE locked_until
        END
    WHERE id = ${userId}
  `;
}

export async function resetFailedLogins(userId: number): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE users
    SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
    WHERE id = ${userId}
  `;
}

// ─── Velocity check ──────────────────────────────────────────────────────────
/**
 * A caller's transaction, when the velocity read or write must run on the
 * connection the caller already holds. Same shape and purpose as
 * `LedgerExecutor` in lib/ledger.ts.
 *
 * This is not a convenience. `lib/db.ts` configures `max: 5`, so a caller that
 * holds a pool connection inside `sql.begin` and then lets this module call
 * `getSql()` is asking the same 5-connection pool for a second connection
 * while holding one. Five such callers in flight hold all five connections and
 * every one of them waits for a sixth, so none can finish and release — the
 * pool deadlocks and stalls every other query on that instance, not only the
 * money path. `paySplitPortion()` had exactly that shape for one commit.
 */
export type VelocityExecutor = postgres.ISql;

/**
 * Raised when an admission is refused because it would carry the payer past a
 * velocity ceiling.
 *
 * `admitVelocity()` signals refusal by throwing rather than returning, and
 * that is deliberate. Admission writes the increments BEFORE it verifies them
 * (see `admitVelocity()`), so a refusal has already consumed budget in the
 * open transaction; only a rollback releases it. A thrown error aborts the
 * caller's transaction by construction, which makes "a refused payment
 * consumes no budget" a property of control flow instead of a convention a
 * caller has to remember. A returned `{ admitted: false }` would leave the
 * increments committed by any caller that forgot to roll back.
 */
export class VelocityLimitError extends Error {
  readonly code = 'VELOCITY_EXCEEDED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VelocityLimitError';
  }
}

/** The three rolling windows velocity is accounted in, normalized to their boundaries. */
export function velocityWindows(now: Date = new Date()): ReadonlyArray<{ type: 'hourly' | 'daily' | 'weekly'; start: Date }> {
  const hourStart = new Date(now); hourStart.setMinutes(0, 0, 0);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
  // Fixed order. Each window is a distinct row and admission takes a row lock
  // on all three; a consistent order across callers is what keeps two payers'
  // concurrent admissions from deadlocking against each other.
  return [
    { type: 'hourly', start: hourStart },
    { type: 'daily', start: dayStart },
    { type: 'weekly', start: weekStart },
  ];
}

async function velocityLimitsFor(sql: VelocityExecutor, userId: number) {
  const userRows = await sql`SELECT kyc_status FROM users WHERE id = ${userId}`;
  const kycStatus = userRows[0]?.kyc_status as string;
  return kycStatus === 'verified' ? VELOCITY_LIMITS.verified_user : VELOCITY_LIMITS.new_user;
}

/**
 * Read-only velocity preview. **This is not an admission control.**
 *
 * It answers "would this amount be allowed if it were attempted now", which is
 * useful for a draft or quote step that moves no money. It must never be used
 * to gate a balance movement, and must never be paired with
 * `recordVelocity()` to do so: the read and the write are separate statements
 * on separate snapshots, so two concurrent payers both observe headroom that
 * only one of them can have (CWE-367). Every money path admits through
 * `admitVelocity()` instead, and
 * `lib/__tests__/velocity-admission-callers.test.ts` fails if one does not.
 *
 * Deliberately has no `try/catch`, and no caller may add one: decision 0007
 * requires a money path to refuse when velocity cannot be evaluated, and the
 * error propagating is what implements that.
 */
export async function checkVelocityLimit(
  userId: number,
  amount: MinorUnits,
  currency: string,
  executor?: VelocityExecutor
): Promise<{ allowed: boolean; reason?: string }> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new MoneyValidationError('Velocity amount must be positive integer minor units.');
  // Validates currency without ever interpreting cents as major units.
  parsePositiveMoney(toDatabaseDecimal(amount), currency);
  const sql = executor ?? getSql();
  const limits = await velocityLimitsFor(sql, userId);
  // Shared with admitVelocity() rather than recomputed. These boundaries must
  // agree across preview, admission and reversal: a reversal computed on a
  // different boundary stops matching the rows admission wrote, so it releases
  // nothing. Four copies of this definition existed before PR #75.
  const [hourly, daily, weekly] = velocityWindows();

  const hourlyRows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) as total FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = 'hourly'
      AND window_start >= ${hourly.start.toISOString()} AND currency = ${currency}
  `;
  if (parseSignedDatabaseMoney(String(hourlyRows[0]?.total ?? '0'), currency) + amount > limits.hourly_max_amount * 100) {
    return { allowed: false, reason: `Hourly limit of ${currency} ${limits.hourly_max_amount.toLocaleString()} exceeded` };
  }

  const dailyRows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) as total, COALESCE(SUM(transaction_count), 0) as count
    FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = 'daily'
      AND window_start >= ${daily.start.toISOString()} AND currency = ${currency}
  `;
  if (parseSignedDatabaseMoney(String(dailyRows[0]?.total ?? '0'), currency) + amount > limits.daily_max_amount * 100) {
    return { allowed: false, reason: `Daily limit of ${currency} ${limits.daily_max_amount.toLocaleString()} exceeded` };
  }
  if (parseInt(dailyRows[0]?.count || '0') + 1 > limits.daily_max_count) {
    return { allowed: false, reason: `Daily transaction count limit of ${limits.daily_max_count} exceeded` };
  }

  const weeklyRows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) as total FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = 'weekly'
      AND window_start >= ${weekly.start.toISOString()} AND currency = ${currency}
  `;
  if (parseSignedDatabaseMoney(String(weeklyRows[0]?.total ?? '0'), currency) + amount > limits.weekly_max_amount * 100) {
    return { allowed: false, reason: `Weekly limit of ${currency} ${limits.weekly_max_amount.toLocaleString()} exceeded` };
  }

  return { allowed: true };
}

/**
 * Atomically admit `amount` against the payer's rolling velocity budget.
 *
 * Replaces the `checkVelocityLimit()` → move money → `recordVelocity()`
 * sequence every money path used to run. That sequence read the totals on one
 * snapshot and wrote them later, with nothing holding the payer's rows in
 * between, so two concurrent payments by one payer each saw the pre-payment
 * total and both were admitted — a time-of-check/time-of-use race (CWE-367)
 * on the control that bounds how much an account can move. The ceiling was
 * enforced per request, not per account.
 *
 * The fix is ordering plus a lock that outlives the decision: **write first,
 * then verify.**
 *
 *   1. Upsert the three window rows, incrementing count and amount. Each
 *      upsert takes a row lock that PostgreSQL holds until the transaction
 *      ends — not until the statement ends.
 *   2. Re-read the window totals. Being after the write and in the same
 *      transaction, this read sees this admission's own increments plus every
 *      committed one.
 *   3. Over budget → throw, which rolls the increments back with the payment.
 *
 * A concurrent admission for the same payer blocks at step 1 on the row this
 * one holds, and resumes only once this transaction commits or aborts — so it
 * increments on top of a settled total and step 2 refuses it if that puts the
 * payer over. There is no window in which both observe the same headroom,
 * because the total is published by the same commit that releases the lock.
 * The previous design's lock, had one been added around the check alone, would
 * have been released before `recordVelocity()` ran and protected nothing.
 *
 * Reading cannot be folded into the writing statement: a data-modifying CTE's
 * effects are not visible to sibling CTEs in the same statement, so a single
 * `INSERT ... RETURNING` + `SELECT SUM(...)` statement would verify against
 * the pre-write snapshot. And `RETURNING` alone is not guaranteed to be the
 * window total: the partial unique index excludes rows with
 * `transaction_count < 0`, so any legacy compensating row left behind by the
 * deleted `reverseVelocity()` is an additional row in the same window. Summing
 * stays correct whether or not such rows remain, where `RETURNING` would not.
 * Nothing writes them any more — `releaseVelocityClaim()` writes to
 * `velocity_checks` not at all. Hence two statements, in one transaction, in
 * this order.
 *
 * Pass `executor` whenever the caller is already inside `sql.begin`, and do
 * pass it on a money path: it is what makes consumption commit with the
 * money — a rollback consumes no budget, and a commit cannot leave the money
 * moved with the budget unconsumed. It is also required to avoid pool
 * exhaustion; see `VelocityExecutor`. Without it, this opens its own
 * transaction, which is atomic but commits consumption independently of
 * whatever the caller does next.
 *
 * Deliberately has no `try/catch`, and no caller may add one — see decision
 * 0007. If velocity cannot be evaluated, the money path must refuse.
 *
 * @throws {VelocityLimitError} if the admission would breach a ceiling.
 */
export async function admitVelocity(
  userId: number,
  amount: MinorUnits,
  currency: string,
  executor?: VelocityExecutor
): Promise<void> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new MoneyValidationError('Velocity amount must be positive integer minor units.');
  parsePositiveMoney(toDatabaseDecimal(amount), currency);
  if (executor) return admitVelocityWithin(executor, userId, amount, currency);
  return getSql().begin((tx) => admitVelocityWithin(tx as unknown as VelocityExecutor, userId, amount, currency)) as Promise<void>;
}

async function admitVelocityWithin(
  sql: VelocityExecutor,
  userId: number,
  amount: MinorUnits,
  currency: string,
): Promise<void> {
  const limits = await velocityLimitsFor(sql, userId);
  const amountDecimal = toDatabaseDecimal(amount);
  const windows = velocityWindows();

  // Step 1 — claim. Row locks taken here are held to transaction end.
  for (const { type, start } of windows) {
    await sql`
      INSERT INTO velocity_checks (user_id, window_start, window_type, transaction_count, total_amount, currency)
      VALUES (${userId}, ${start.toISOString()}, ${type}, 1, ${amountDecimal}, ${currency})
      ON CONFLICT (user_id, window_type, window_start, currency) WHERE transaction_count >= 0
      DO UPDATE SET
        transaction_count = velocity_checks.transaction_count + 1,
        total_amount = velocity_checks.total_amount + EXCLUDED.total_amount,
        updated_at = NOW()
    `;
  }

  // Step 2 — verify the post-claim totals, including this claim.
  const [hourly, daily, weekly] = windows;
  const rows = await sql`
    SELECT window_type,
           COALESCE(SUM(total_amount), 0) AS total,
           COALESCE(SUM(transaction_count), 0) AS count
    FROM velocity_checks
    WHERE user_id = ${userId} AND currency = ${currency}
      AND (
        (window_type = 'hourly' AND window_start >= ${hourly.start.toISOString()})
        OR (window_type = 'daily' AND window_start >= ${daily.start.toISOString()})
        OR (window_type = 'weekly' AND window_start >= ${weekly.start.toISOString()})
      )
    GROUP BY window_type
  `;
  const totals = new Map<string, { total: MinorUnits; count: number }>();
  for (const row of rows) {
    totals.set(String(row.window_type), {
      total: parseSignedDatabaseMoney(String(row.total ?? '0'), currency),
      count: parseInt(String(row.count ?? '0'), 10),
    });
  }
  const windowOf = (type: string) => totals.get(type) ?? { total: 0, count: 0 };

  // Step 3 — refuse by throwing, so the claim above rolls back.
  if (windowOf('hourly').total > limits.hourly_max_amount * 100) {
    throw new VelocityLimitError(`Hourly limit of ${currency} ${limits.hourly_max_amount.toLocaleString()} exceeded`);
  }
  if (windowOf('daily').total > limits.daily_max_amount * 100) {
    throw new VelocityLimitError(`Daily limit of ${currency} ${limits.daily_max_amount.toLocaleString()} exceeded`);
  }
  if (windowOf('daily').count > limits.daily_max_count) {
    throw new VelocityLimitError(`Daily transaction count limit of ${limits.daily_max_count} exceeded`);
  }
  if (windowOf('weekly').total > limits.weekly_max_amount * 100) {
    throw new VelocityLimitError(`Weekly limit of ${currency} ${limits.weekly_max_amount.toLocaleString()} exceeded`);
  }
}

/**
 * Low-level, unconditional velocity write.
 *
 * **Not for a money path.** Writing without verifying is half of the race
 * `admitVelocity()` exists to close; pairing this with
 * `checkVelocityLimit()` reproduces it exactly. It has **no counterpart that
 * credits `velocity_checks`** — `releaseVelocityClaim()` is a different
 * accounting domain in `lib/velocity-claims.ts` and writes nothing here. It
 * remains exported because it is covered by
 * `velocity.test.ts`, and because a future non-money accounting caller may
 * legitimately want to record volume it has already authorized by other
 * means. `lib/__tests__/velocity-admission-callers.test.ts` fails if a money
 * path calls it.
 */
export async function recordVelocity(
  userId: number,
  amount: MinorUnits,
  currency: string,
  executor?: VelocityExecutor
): Promise<void> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new MoneyValidationError('Velocity amount must be positive integer minor units.');
  parsePositiveMoney(toDatabaseDecimal(amount), currency);
  // Passing the caller's transaction makes the record commit WITH the payment:
  // a rollback leaves no consumed budget, and a successful commit cannot leave
  // the payment recorded but the budget unconsumed. Without it the two land
  // separately and a failure here reports 500 for a payment that succeeded.
  const sql = executor ?? getSql();
  const amountDecimal = toDatabaseDecimal(amount);

  for (const { type: windowType, start: windowStart } of velocityWindows()) {
    // Single atomic upsert. This was previously an INSERT ... ON CONFLICT DO
    // NOTHING followed by an unconditional UPDATE, which counted the first
    // transaction of every window twice: the INSERT seeded the row with
    // (1, amount) and the UPDATE then added (1, amount) to that same row.
    await sql`
      INSERT INTO velocity_checks (user_id, window_start, window_type, transaction_count, total_amount, currency)
      VALUES (${userId}, ${windowStart.toISOString()}, ${windowType}, 1, ${amountDecimal}, ${currency})
      ON CONFLICT (user_id, window_type, window_start, currency) WHERE transaction_count >= 0
      DO UPDATE SET
        transaction_count = velocity_checks.transaction_count + 1,
        total_amount = velocity_checks.total_amount + EXCLUDED.total_amount,
        updated_at = NOW()
    `;
  }
}

// ─── Audit logging ───────────────────────────────────────────────────────────
export async function auditLog(userId: number | null, action: string, metadata?: Record<string, unknown>): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      INSERT INTO audit_logs (user_id, action, metadata)
      VALUES (${userId}, ${action}, ${jsonbParam(sql, metadata)})
    `;
  } catch (err) {
    // Non-blocking by design: a failed audit write must not fail the action
    // being audited. But it was previously swallowed in total silence, so a
    // lost audit record left no trace anywhere — an FK violation on a stale
    // user_id, for instance, discarded the record and reported success.
    // Losing audit evidence quietly is worse than the noise of saying so.
    // The action and user id are logged; `metadata` is NOT, because callers
    // put request-shaped values in it.
    console.warn(
      `auditLog: failed to record action=${action} user_id=${userId ?? 'null'}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─── Velocity reversal: removed ──────────────────────────────────────────────
// `reverseVelocity()` lived here and has been DELETED, not deprecated.
//
// It released `min(amount, current window total)` — and that window total is
// the user's volume from EVERY money path, so a returned transfer freed budget
// `money:send` and `money:split-pay` had genuinely consumed. The owner
// classified that as a critical financial-control defect. A function that can
// do it must not remain reachable, so there is no compatibility shim: the
// callers moved to `releaseVelocityClaim()` in `lib/velocity-claims.ts`, which
// can only retire its own claim, by moving that one row out of the reserved
// set. It returns nothing to any window: it writes to `velocity_checks` not at
// all, which is the domain rule rather than a bound on the amount.
//
// Two further defects died with it, both of which the owner's requirements
// name independently. Its three window inserts ran in no transaction, so a
// failure part-way left a partial release committed; and its `catch` logged
// and reported success, so that partial release was silent. The replacement
// runs as one transaction and deliberately does not catch.
//
// See `docs/decisions/0012-claim-bounded-velocity-release.md`.

// ─── Password verification ───────────────────────────────────────────────────

/** Cost factor for customer password hashes. Must match app/api/auth/register. */
export const USER_PASSWORD_ROUNDS = 12;

/**
 * A valid bcrypt hash, at the same cost as a real one, of a random value that
 * was generated once and discarded. Nothing can ever match it.
 *
 * Being well-formed is the entire point. The login route previously compared
 * against the string '$2b$10$invalidhashfortimingnormalization', which is not a
 * valid bcrypt digest — bcrypt rejects it immediately instead of running the
 * 2^12 rounds, so the comparison returned in roughly 0ms against ~315ms for a
 * real account. That is a 300-millisecond answer to "is this email
 * registered?", readable by anyone with a stopwatch, and the code carried a
 * comment claiming it prevented exactly that.
 *
 * The cost here must track USER_PASSWORD_ROUNDS. A dummy at a lower cost is a
 * quieter version of the same leak.
 */
const ABSENT_USER_DUMMY_HASH =
  '$2b$12$Whhtn9J4nkw6o6lG1y3PSOSEDwYNjgeTliCsXTDCqorkSkIwpvoH6';

/**
 * Verify a password against a stored hash, taking the same time whether or not
 * the account exists.
 *
 * Pass `null`/`undefined` for an unknown account: the bcrypt work still runs,
 * against a hash nothing matches, and the answer is false.
 */
export async function verifyUserPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (!storedHash) {
    await bcrypt.compare(password, ABSENT_USER_DUMMY_HASH).catch(() => false);
    return false;
  }
  return bcrypt.compare(password, storedHash).catch(() => false);
}

// ─── Input validation ────────────────────────────────────────────────────────
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password: string): { valid: boolean; reason?: string } {
  if (password.length < 8) return { valid: false, reason: 'Password must be at least 8 characters' };
  if (!/[A-Z]/.test(password)) return { valid: false, reason: 'Password must contain at least one uppercase letter' };
  if (!/[0-9]/.test(password)) return { valid: false, reason: 'Password must contain at least one number' };
  return { valid: true };
}

export function sanitizeString(input: string, maxLength = 255): string {
  return input.trim().slice(0, maxLength);
}
