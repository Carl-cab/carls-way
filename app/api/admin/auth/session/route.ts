import { NextResponse } from 'next/server';
import { getServerAdmin } from '@/lib/rbac/admin-server';
import { ROLE_PERMISSIONS } from '@/lib/rbac/types';

/**
 * Who is the current administrator?
 *
 * Lets the console shell show the signed-in operator and their permissions
 * without every page re-deriving it. Resolves through getServerAdmin, so it
 * agrees with the page guard and the API guard by construction.
 *
 * Returns 401 rather than 404 here: unlike the console pages, reaching this
 * endpoint at all requires knowing it exists, and a client needs to tell "not
 * signed in" apart from "route missing" to redirect correctly.
 */
export async function GET() {
  const admin = await getServerAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    admin: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
    },
    permissions: ROLE_PERMISSIONS[admin.role] ?? [],
  });
}
