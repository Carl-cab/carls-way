import { NextRequest, NextResponse } from 'next/server';
import { validatePassword } from '@/lib/auth';
import {
  ForbiddenError,
  getAdminContext,
  requirePermission,
  withAdminAuth,
} from '@/lib/rbac';
import {
  ADMIN_PASSWORD_ROTATION_SESSION_TTL_SECONDS,
  rotateOwnAdminPassword,
} from '@/lib/rbac/admin-password-rotation';
import {
  ADMIN_SESSION_COOKIE,
  adminSessionCookieOptions,
} from '@/lib/rbac/admin-auth';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';

/**
 * Rotate the authenticated administrator's own password.
 *
 * This endpoint never accepts an administrator id, so its narrowly scoped
 * permission cannot be used to rotate another account. Cross-account reset is
 * intentionally not implemented: the current infrastructure has no safe reset
 * delivery channel, and this API must never mint or return a reusable password.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  try {
    requirePermission('admins:rotate_own_password');
    const context = getAdminContext();
    if (!context) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // A rotation verifies a password and is therefore a brute-force target even
    // though the caller already has a session. Key the limit to the authenticated
    // account, not a forgeable forwarding header.
    const limit = await checkRateLimit(
      'auth:admin-password-rotation',
      String(context.adminUser.id),
      { limit: 5, windowSeconds: 900 },
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: rateLimitHeaders(limit) },
      );
    }

    const body = await req.json().catch(() => null);
    const currentPassword =
      typeof body?.current_password === 'string' ? body.current_password : '';
    const newPassword = typeof body?.new_password === 'string' ? body.new_password : '';

    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Reuse the established application password policy rather than introducing
    // an inconsistent administrator-only policy.
    const passwordCheck = validatePassword(newPassword);
    if (!passwordCheck.valid) {
      return NextResponse.json({ error: passwordCheck.reason }, { status: 400 });
    }

    const result = await rotateOwnAdminPassword(
      context.adminUser.id,
      currentPassword,
      newPassword,
      {
        sessionId: context.sessionId,
        correlationId: context.correlationId,
        sourceIp: context.sourceIp,
        userAgent: context.userAgent,
      },
    );

    if (result.outcome === 'current_password_invalid') {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 });
    }
    if (result.outcome === 'administrator_unavailable') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const res = NextResponse.json({ success: true, expires_at: result.expiresAt });
    res.cookies.set(
      ADMIN_SESSION_COOKIE,
      result.cookieValue,
      adminSessionCookieOptions(ADMIN_PASSWORD_ROTATION_SESSION_TTL_SECONDS),
    );
    return res;
  } catch (err: unknown) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    // Do not include request data, password values, bcrypt hashes, or cookie
    // values in logs or responses.
    console.error('Admin password rotation failed.');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = (req: NextRequest) => withAdminAuth(req, handler);
