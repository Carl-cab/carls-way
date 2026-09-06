import { NextRequest, NextResponse } from 'next/server';
import { getAdminRepository } from '@/lib/rbac/AdminRepository';
import {
  ADMIN_SESSION_COOKIE,
  adminSessionCookieOptions,
  parseSessionCookie,
} from '@/lib/rbac/admin-auth';
import { auditLog } from '@/lib/auth';

/**
 * Administrator logout.
 *
 * Deletes the server-side session before clearing the cookie, so the credential
 * is dead whether or not the browser honours the clear. A logout that only
 * removed the cookie would leave a working session behind for anyone who had
 * copied it.
 *
 * Always answers 200. Logging out of a session that is already gone is the
 * desired end state, and reporting "no such session" would let an unauthorised
 * caller probe which session ids are live.
 */
export async function POST(req: NextRequest) {
  const credential = parseSessionCookie(req.cookies.get(ADMIN_SESSION_COOKIE)?.value);

  if (credential) {
    try {
      const adminRepo = getAdminRepository();
      // Look the session up first so the audit record can name the account.
      const session = await adminRepo.findSession(credential.sessionId);
      await adminRepo.deleteSession(credential.sessionId);
      await auditLog(null, 'admin_logout', {
        session_id: credential.sessionId,
        admin_user_id: session?.admin_user_id ?? null,
      });
    } catch (err) {
      // Never fail a logout: leaving the caller apparently signed in because
      // cleanup errored is worse than a best-effort clear.
      console.error('Admin logout error:', err);
    }
  }

  const res = NextResponse.json({ success: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, '', adminSessionCookieOptions(0));
  return res;
}
