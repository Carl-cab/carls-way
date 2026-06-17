import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSql } from '@/lib/db';
import {
  signToken, COOKIE_NAME, validateEmail, sanitizeString,
  checkAccountLocked, recordFailedLogin, resetFailedLogins, auditLog
} from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = sanitizeString(body.email || '', 255).toLowerCase();
    const password = body.password || '';

    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }
    if (!validateEmail(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
    }

    const sql = getSql();
    const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
    const user = rows[0] as {
      id: number; email: string; username: string; name: string;
      password_hash: string; kyc_status: string;
    } | undefined;

    if (!user) {
      // Timing-safe: still run bcrypt to prevent user enumeration
      await bcrypt.compare(password, '$2b$10$invalidhashfortimingnormalization');
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    // Check account lockout
    const isLocked = await checkAccountLocked(user.id);
    if (isLocked) {
      await auditLog(user.id, 'login_blocked_locked', { email });
      return NextResponse.json({ error: 'Account temporarily locked due to too many failed attempts. Try again in 30 minutes.' }, { status: 429 });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      await recordFailedLogin(user.id);
      await auditLog(user.id, 'login_failed', { email });
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    await resetFailedLogins(user.id);
    await auditLog(user.id, 'login_success', { email });

    const token = signToken({ userId: user.id, email: user.email, username: user.username });
    const response = NextResponse.json({
      success: true,
      username: user.username,
      kycStatus: user.kyc_status,
    });
    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });
    return response;
  } catch (err) {
    console.error('Login error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
