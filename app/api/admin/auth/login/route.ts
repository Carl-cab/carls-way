import { NextRequest, NextResponse } from 'next/server';
import { getAdminRepository } from '@/lib/rbac/AdminRepository';
import {
  ADMIN_MAX_FAILED_LOGINS,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_HOURS,
  adminSessionCookieOptions,
  issueSessionCredential,
  lockoutExpiryFrom,
  verifyAdminPassword,
} from '@/lib/rbac/admin-auth';
import { checkRateLimit, clientIdentifier, rateLimitHeaders } from '@/lib/rate-limit';
import { auditLog } from '@/lib/auth';

/**
 * Administrator login.
 *
 * Deliberately separate from customer login: a `manna-token` grants no admin
 * access and an `admin_session` grants no customer access, so a compromise of
 * one boundary does not cross into the other.
 *
 * Every failure returns the same message and the same status. Distinguishing
 * "no such administrator" from "wrong password" would turn this endpoint into a
 * way to enumerate who holds admin accounts, and those are the accounts worth
 * attacking. The password comparison runs even when no account exists, so the
 * response time does not answer the question either.
 */
const GENERIC_FAILURE = 'Invalid credentials.';

export async function POST(req: NextRequest) {
  const client = clientIdentifier(req);

  // Throttle before touching the database, so an unauthenticated caller cannot
  // drive bcrypt work or connection use by volume alone.
  const limit = await checkRateLimit('auth:admin-login', client, {
    limit: 5,
    windowSeconds: 900,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Please try again later.' },
      { status: 429, headers: rateLimitHeaders(limit) },
    );
  }

  try {
    const body = await req.json().catch(() => null);
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!email || !password) {
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
    }

    const adminRepo = getAdminRepository();
    const admin = await adminRepo.findAdminByEmail(email);

    // Locked and inactive accounts fail before the password is considered, but
    // still return the generic message.
    if (admin?.locked_until && new Date(admin.locked_until) > new Date()) {
      await auditLog(null, 'admin_login_blocked_locked', { email, client });
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
    }
    if (admin && admin.status !== 'active') {
      await auditLog(null, 'admin_login_blocked_inactive', { email, client });
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
    }

    // Runs a bcrypt comparison even when `admin` is null, to keep the timing of
    // an unknown address indistinguishable from a known one.
    const passwordOk = await verifyAdminPassword(password, admin?.password_hash);

    if (!admin || !passwordOk) {
      if (admin) {
        const attempts = (admin.failed_login_attempts ?? 0) + 1;
        await adminRepo.recordFailedLogin(admin.id, attempts, lockoutExpiryFrom(attempts));
        await auditLog(null, 'admin_login_failed', {
          email,
          client,
          attempts,
          locked: attempts >= ADMIN_MAX_FAILED_LOGINS,
        });
      } else {
        await auditLog(null, 'admin_login_failed_unknown_account', { email, client });
      }
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
    }

    const credential = issueSessionCredential();
    await adminRepo.createSession(
      credential.sessionId,
      admin.id,
      credential.tokenHash,
      credential.expiresAt,
    );
    await adminRepo.recordSuccessfulLogin(admin.id);
    await auditLog(null, 'admin_login_succeeded', {
      admin_user_id: admin.id,
      email: admin.email,
      session_id: credential.sessionId,
      client,
    });

    const res = NextResponse.json({
      success: true,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
      expires_at: credential.expiresAt,
    });
    res.cookies.set(
      ADMIN_SESSION_COOKIE,
      credential.cookieValue,
      adminSessionCookieOptions(ADMIN_SESSION_TTL_HOURS * 60 * 60),
    );
    return res;
  } catch (err) {
    console.error('Admin login error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
