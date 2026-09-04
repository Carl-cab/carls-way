import { notFound } from 'next/navigation';
import { getServerAdmin } from '@/lib/rbac/admin-server';
import { AdminShell } from './components/AdminShell';

/**
 * Server-side authorization gate for the whole Operations Console.
 *
 * Every page under /admin renders through this layout, so an unauthenticated or
 * non-admin caller never receives console markup. Authorization is enforced
 * here on the server rather than by the client hiding UI.
 *
 * Unauthorized callers get 404 rather than 401/redirect: the existence of the
 * console is itself information we have no reason to disclose before
 * authorization. Fails closed — resolveAdminBySessionId returns null on any
 * missing session, inactive/locked account, or infrastructure error.
 *
 * Note this is a gate, not the complete authorization story: individual admin
 * APIs additionally enforce per-permission checks via requirePermission.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getServerAdmin();

  if (!admin) {
    notFound();
  }

  return <AdminShell>{children}</AdminShell>;
}
