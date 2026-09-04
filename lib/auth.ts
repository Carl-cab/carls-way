import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';
import { getSql } from '@/lib/db';

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

export async function getAuthUser(): Promise<JWTPayload | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(COOKIE_NAME)?.value;
    if (!token) return null;
    return verifyToken(token);
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
export async function checkVelocityLimit(
  userId: number,
  amount: number,
  currency: string
): Promise<{ allowed: boolean; reason?: string }> {
  const sql = getSql();
  const userRows = await sql`SELECT kyc_status FROM users WHERE id = ${userId}`;
  const kycStatus = userRows[0]?.kyc_status as string;
  const limits = kycStatus === 'verified'
    ? VELOCITY_LIMITS.verified_user
    : VELOCITY_LIMITS.new_user;

  const now = new Date();
  const hourStart = new Date(now); hourStart.setMinutes(0, 0, 0);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);

  const hourlyRows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) as total FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = 'hourly'
      AND window_start >= ${hourStart.toISOString()} AND currency = ${currency}
  `;
  if (parseFloat(hourlyRows[0]?.total || '0') + amount > limits.hourly_max_amount) {
    return { allowed: false, reason: `Hourly limit of ${currency} ${limits.hourly_max_amount.toLocaleString()} exceeded` };
  }

  const dailyRows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) as total, COALESCE(SUM(transaction_count), 0) as count
    FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = 'daily'
      AND window_start >= ${dayStart.toISOString()} AND currency = ${currency}
  `;
  if (parseFloat(dailyRows[0]?.total || '0') + amount > limits.daily_max_amount) {
    return { allowed: false, reason: `Daily limit of ${currency} ${limits.daily_max_amount.toLocaleString()} exceeded` };
  }
  if (parseInt(dailyRows[0]?.count || '0') + 1 > limits.daily_max_count) {
    return { allowed: false, reason: `Daily transaction count limit of ${limits.daily_max_count} exceeded` };
  }

  const weeklyRows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) as total FROM velocity_checks
    WHERE user_id = ${userId} AND window_type = 'weekly'
      AND window_start >= ${weekStart.toISOString()} AND currency = ${currency}
  `;
  if (parseFloat(weeklyRows[0]?.total || '0') + amount > limits.weekly_max_amount) {
    return { allowed: false, reason: `Weekly limit of ${currency} ${limits.weekly_max_amount.toLocaleString()} exceeded` };
  }

  return { allowed: true };
}

export async function recordVelocity(userId: number, amount: number, currency: string): Promise<void> {
  const sql = getSql();
  const now = new Date();
  const hourStart = new Date(now); hourStart.setMinutes(0, 0, 0);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);

  for (const [windowType, windowStart] of [
    ['hourly', hourStart] as const,
    ['daily', dayStart] as const,
    ['weekly', weekStart] as const,
  ]) {
    // Single atomic upsert. This was previously an INSERT ... ON CONFLICT DO
    // NOTHING followed by an unconditional UPDATE, which counted the first
    // transaction of every window twice: the INSERT seeded the row with
    // (1, amount) and the UPDATE then added (1, amount) to that same row.
    await sql`
      INSERT INTO velocity_checks (user_id, window_start, window_type, transaction_count, total_amount, currency)
      VALUES (${userId}, ${windowStart.toISOString()}, ${windowType}, 1, ${amount}, ${currency})
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
      VALUES (${userId}, ${action}, ${metadata ? JSON.stringify(metadata) : null})
    `;
  } catch { /* Non-blocking */ }
}

// ─── Velocity Reversal (Future Use: For Returned/Failed Transfers) ───────────
// Reverses velocity records when a transfer is returned or fails after velocity was recorded.
// IMPORTANT: Currently for future use only. Not called by P2P payments.
// Will be used by webhook handlers when transfers are returned (NSF, clawed back, etc.)
export async function reverseVelocity(
  userId: number,
  amount: number,
  currency: string,
  reason?: string,
  relatedEntityId?: number,
): Promise<void> {
  // Validation
  if (amount <= 0) {
    throw new Error('Reverse amount must be greater than zero');
  }

  if (currency !== 'CAD' && currency !== 'USD') {
    throw new Error(`Invalid currency: ${currency}. Must be CAD or USD.`);
  }

  const sql = getSql();

  // Create compensating negative velocity records (historical rows are never
  // deleted, so original + reversal nets to zero and both remain auditable).
  //
  // These are written with the same window_type / window_start / currency that
  // checkVelocityLimit() sums over, so the reversal actually releases the
  // user's headroom. The previous implementation inserted a single row with
  // columns that do not exist on this table (period_type, period_start,
  // hourly_amount, ...) under window_type 'reversal', which no query reads —
  // so every reversal threw, was swallowed by the catch below, and freed
  // nothing.
  //
  // Known limitation: the reversal is applied to the windows current at the
  // time of reversal, not the windows the original transaction fell into. A
  // return that arrives after the original window has rolled over therefore
  // credits a window that never carried the charge. Correcting that needs the
  // original transaction timestamp, which this signature does not carry; the
  // clamp below keeps the effect conservative in the meantime.
  const reversalAmount = Math.min(amount, MAX_SINGLE_TRANSFER_AMOUNT);
  const now = new Date();
  const hourStart = new Date(now); hourStart.setMinutes(0, 0, 0);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);

  try {
    for (const [windowType, windowStart] of [
      ['hourly', hourStart] as const,
      ['daily', dayStart] as const,
      ['weekly', weekStart] as const,
    ]) {
      // A window's recorded volume can never be driven below zero: a reversal
      // releases at most what that window currently holds.
      const recorded = await sql`
        SELECT COALESCE(SUM(total_amount), 0) AS total
        FROM velocity_checks
        WHERE user_id = ${userId} AND window_type = ${windowType}
          AND window_start >= ${windowStart.toISOString()} AND currency = ${currency}
      `;
      const releasable = Math.min(reversalAmount, parseFloat(recorded[0]?.total ?? '0'));
      if (releasable <= 0) continue;

      await sql`
        INSERT INTO velocity_checks (
          user_id, window_start, window_type, transaction_count, total_amount, currency
        )
        VALUES (
          ${userId}, ${windowStart.toISOString()}, ${windowType}, -1, ${-releasable}, ${currency}
        )
      `;
    }

    // Audit the reversal for compliance
    await auditLog(userId, 'velocity_reversed', {
      amount,
      currency,
      reason: reason || 'transfer_returned',
      relatedEntityId,
    });
  } catch (err) {
    // Log but don't block: reversal is for audit/compliance, not transaction-critical
    console.error('Velocity reversal failed (non-blocking):', err);
  }
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
