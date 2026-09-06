import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth';

/**
 * Edge auth gate.
 *
 * SECURITY BOUNDARY MAP — which mechanism authorizes what, and why.
 *
 *   Customer pages (AUTH_PATHS)
 *     Authorized here, by the `manna-token` JWT. These are the only routes this
 *     middleware authorizes outright.
 *
 *   Admin console (/admin/**)
 *     Two independent layers. This middleware performs a cheap presence check on
 *     the `admin_session` cookie so anonymous traffic is turned away at the edge
 *     without touching the database. The authoritative check is server-side in
 *     app/admin/layout.tsx, which resolves the session against the database and
 *     404s if it is missing, inactive, locked, or unresolvable.
 *     A customer `manna-token` deliberately grants no admin access: admin
 *     identity is a separate credential with a separate cookie.
 *
 *   Admin APIs (/api/admin/**)
 *     NOT authorized here — API routes are excluded from the matcher below.
 *     They are authorized in-route by withAdminAuth (session) plus
 *     requirePermission (role/permission). That is deliberate: permission checks
 *     need per-route granularity and database access that edge middleware
 *     cannot provide. Enforcement lives with the handler, not the router.
 *
 *   Provider webhooks (/api/webhooks/**)
 *     Deliberately NOT subject to user authentication. Their authorization
 *     mechanism is cryptographic signature verification against the provider's
 *     shared secret / JWKS — Stripe via constructEvent, Plaid via JWT
 *     verification. Applying ordinary user auth here would break delivery while
 *     adding no security, since the caller is a provider, not a user.
 *
 *   Auth endpoints (/api/auth/**)
 *     Necessarily unauthenticated; they are how a caller obtains credentials.
 */

const PUBLIC_PATHS = ['/login', '/register'];
const AUTH_PATHS = ['/feed', '/send', '/request', '/history', '/profile', '/friends', '/transfers'];
const ADMIN_PATH = '/admin';
const ADMIN_LOGIN_PATH = '/admin/login';

export function proxy(request: NextRequest) {
  const token = request.cookies.get('manna-token')?.value;
  const { pathname } = request.nextUrl;

  // The administrator sign-in page is necessarily reachable without a session,
  // or nobody could ever obtain one. It renders outside the console's route
  // group, so no guarded layout sits above it.
  //
  // This does disclose that an admin console exists to anyone who guesses the
  // path, which the 404 below otherwise avoids. That is unavoidable for a
  // browser-based login and is bounded: the page holds no data, the endpoint
  // behind it returns one generic failure for every rejection, and it is rate
  // limited per client.
  if (pathname === ADMIN_LOGIN_PATH) {
    return NextResponse.next();
  }

  // Admin console: gate on the admin credential, never the customer one.
  // Authoritative verification happens server-side in the console layout.
  if (pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`)) {
    const adminSession = request.cookies.get('admin_session')?.value;
    if (!adminSession) {
      // Match the layout's response: do not disclose that the console exists.
      return NextResponse.rewrite(new URL('/404', request.url), { status: 404 });
    }
    return NextResponse.next();
  }

  const isPublicPath = PUBLIC_PATHS.some(p => pathname.startsWith(p));
  const isAuthPath = AUTH_PATHS.some(p => pathname.startsWith(p));
  const isRootPath = pathname === '/';

  const user = token ? verifyToken(token) : null;

  // The root path is the public welcome screen: signed-in visitors go straight
  // to the feed, signed-out visitors are allowed through to see it.
  if (user && (isPublicPath || isRootPath)) {
    return NextResponse.redirect(new URL('/feed', request.url));
  }

  if (!user && isAuthPath) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // API routes are intentionally excluded: each API family authorizes itself
  // (admin session + permission, or provider signature). See the boundary map.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
