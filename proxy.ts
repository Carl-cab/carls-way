import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth';

const PUBLIC_PATHS = ['/login', '/register'];
const AUTH_PATHS = ['/feed', '/send', '/request', '/history', '/profile', '/friends'];

export function proxy(request: NextRequest) {
  const token = request.cookies.get('carls-way-token')?.value;
  const { pathname } = request.nextUrl;

  const isPublicPath = PUBLIC_PATHS.some(p => pathname.startsWith(p));
  const isAuthPath = AUTH_PATHS.some(p => pathname.startsWith(p));
  const isRootPath = pathname === '/';

  const user = token ? verifyToken(token) : null;

  if (user && isPublicPath) {
    return NextResponse.redirect(new URL('/feed', request.url));
  }

  if (!user && (isAuthPath || isRootPath)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
