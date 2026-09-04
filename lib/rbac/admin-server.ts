import 'server-only';
import { cookies } from 'next/headers';
import { resolveAdminBySessionId } from './admin-middleware';
import { ROLE_PERMISSIONS } from './types';
import type { AdminUser, Permission } from './types';

/**
 * Server-side admin authorization for React Server Components.
 *
 * The admin API routes are protected by withAdminAuth. Pages are not API
 * routes, so they need their own server-side check — otherwise the console
 * shell renders for anyone and protection depends on the client failing to
 * fetch data, which is not a security boundary.
 *
 * Both this and withAdminAuth delegate to resolveAdminBySessionId, so the page
 * guard and the API guard always agree on what a valid admin session is.
 */
export async function getServerAdmin(): Promise<AdminUser | null> {
  const sessionId = (await cookies()).get('admin_session')?.value;
  return resolveAdminBySessionId(sessionId);
}

/**
 * Whether the current server request belongs to an admin holding `permission`.
 * Fails closed for anonymous callers, non-admin callers, and unknown roles.
 */
export async function serverAdminHasPermission(permission: Permission): Promise<boolean> {
  const admin = await getServerAdmin();
  if (!admin) return false;
  return (ROLE_PERMISSIONS[admin.role] ?? []).includes(permission);
}
