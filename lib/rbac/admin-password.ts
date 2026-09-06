import { createHash, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';

/**
 * Administrator password and token hashing.
 *
 * Deliberately free of `server-only`, unlike lib/rbac/admin-auth.ts. These are
 * pure functions over strings with no request, cookie, or database context, and
 * the bootstrap CLI (scripts/bootstrap-admin.ts) has to hash a password without
 * running inside a React Server Component. The cookie and session primitives
 * keep the `server-only` guard, because those genuinely must never reach a
 * client bundle.
 */

/** bcrypt cost for administrator passwords. Higher than a customer password. */
const ADMIN_PASSWORD_ROUNDS = 12;

export async function hashAdminPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ADMIN_PASSWORD_ROUNDS);
}

// A valid bcrypt hash, at the same cost, of a random value that was discarded,
// so nothing can ever match it. It must be genuinely well-formed: a malformed
// string risks bcrypt rejecting it early and returning fast, which is the
// timing signal this exists to remove.
const ABSENT_ADMIN_DUMMY_HASH =
  '$2b$12$YTOGoEkyEnUL8zijqb.JDuRtcOSX1BDlwUSuyH9QsVuECh7KMT9ja';

/**
 * Verify an administrator password.
 *
 * Always runs a bcrypt comparison, even when there is no stored hash to check
 * against, so that a request for an address with no account takes the same time
 * as one for an address that exists. Otherwise the login endpoint answers "does
 * this administrator exist?" to anyone with a stopwatch.
 */
export async function verifyAdminPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (!storedHash) {
    await bcrypt.compare(password, ABSENT_ADMIN_DUMMY_HASH).catch(() => false);
    return false;
  }
  return bcrypt.compare(password, storedHash);
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare a presented token against a stored hash without leaking, through
 * timing, how much of the value matched.
 */
export function sessionTokenMatches(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSessionToken(token), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
