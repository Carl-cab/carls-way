import 'server-only';
import { randomBytes } from 'crypto';
import {
  hashAdminPassword,
  hashSessionToken,
  sessionTokenMatches,
  verifyAdminPassword,
} from './admin-password';

// Re-exported so callers have one import site for administrator auth.
export { hashAdminPassword, hashSessionToken, sessionTokenMatches, verifyAdminPassword };

/**
 * Administrator session credentials.
 *
 * The cookie carries two parts, `<sessionId>.<token>`:
 *
 *   sessionId  a lookup key, stored in the clear as admin_sessions.id
 *   token      the secret, stored only as a SHA-256 hash
 *
 * Splitting them is the point. Before this, `admin_sessions.token_hash` was
 * written at creation and never read: verification looked a session up by id
 * alone, so the id in the cookie *was* the bearer credential and the column was
 * decoration. Anyone who could read the table — a backup, a log, a dump, an
 * injected SELECT — held usable admin sessions for every signed-in operator.
 *
 * Now a row discloses nothing usable. The stored hash cannot be replayed, and
 * the token that would satisfy it exists only in the operator's cookie.
 *
 * SHA-256 rather than bcrypt for the token specifically: the token is 32 bytes
 * of CSPRNG output, so it has no guessable structure for an attacker to search
 * and a slow KDF buys nothing, while being fast matters on a hash checked on
 * every admin request. Passwords are the opposite case and use bcrypt below.
 */

const SESSION_ID_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;

/** How long a new administrator session stays valid. */
export const ADMIN_SESSION_TTL_HOURS = 12;

export interface IssuedSessionCredential {
  /** Stored in the clear as the primary key. */
  sessionId: string;
  /** Stored only as a hash. Never persisted in raw form. */
  tokenHash: string;
  /** The value to set in the cookie. Never logged, never persisted. */
  cookieValue: string;
  /** Absolute expiry, ISO 8601. */
  expiresAt: string;
}

export function issueSessionCredential(
  ttlHours: number = ADMIN_SESSION_TTL_HOURS,
): IssuedSessionCredential {
  const sessionId = randomBytes(SESSION_ID_BYTES).toString('hex');
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  return {
    sessionId,
    tokenHash: hashSessionToken(token),
    cookieValue: `${sessionId}.${token}`,
    expiresAt,
  };
}

/**
 * Split a cookie value into its lookup key and secret.
 *
 * Returns null for anything malformed rather than guessing, so a cookie from an
 * older scheme — a bare session id with no token — is rejected outright instead
 * of being treated as a session whose secret happens to be empty.
 */
export function parseSessionCookie(
  cookieValue: string | undefined | null,
): { sessionId: string; token: string } | null {
  if (!cookieValue) return null;

  const separator = cookieValue.indexOf('.');
  if (separator <= 0 || separator === cookieValue.length - 1) return null;

  const sessionId = cookieValue.slice(0, separator);
  const token = cookieValue.slice(separator + 1);

  // Both halves are hex of a known length. Anything else is not ours.
  if (!/^[0-9a-f]+$/.test(sessionId) || !/^[0-9a-f]+$/.test(token)) return null;
  if (sessionId.length !== SESSION_ID_BYTES * 2) return null;
  if (token.length !== SESSION_TOKEN_BYTES * 2) return null;

  return { sessionId, token };
}

// ── Lockout policy ───────────────────────────────────────────────────────────

/** Failed attempts before an administrator account locks. */
export const ADMIN_MAX_FAILED_LOGINS = 5;

/** How long an administrator stays locked after crossing that threshold. */
export const ADMIN_LOCKOUT_MINUTES = 30;

export function lockoutExpiryFrom(attempts: number): string | null {
  if (attempts < ADMIN_MAX_FAILED_LOGINS) return null;
  return new Date(Date.now() + ADMIN_LOCKOUT_MINUTES * 60 * 1000).toISOString();
}

/** Cookie attributes for the administrator session. */
export const ADMIN_SESSION_COOKIE = 'admin_session';

export function adminSessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    // Secure is unconditional in production. Omitting it on a plain-HTTP local
    // dev server is the only reason this is conditional at all.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
