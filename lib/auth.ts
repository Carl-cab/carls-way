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
    await sql`
      INSERT INTO velocity_checks (user_id, window_start, window_type, transaction_count, total_amount, currency)
      VALUES (${userId}, ${windowStart.toISOString()}, ${windowType}, 1, ${amount}, ${currency})
      ON CONFLICT DO NOTHING
    `;
    await sql`
      UPDATE velocity_checks
      SET transaction_count = transaction_count + 1, total_amount = total_amount + ${amount}, updated_at = NOW()
      WHERE user_id = ${userId} AND window_type = ${windowType}
        AND window_start = ${windowStart.toISOString()} AND currency = ${currency}
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
