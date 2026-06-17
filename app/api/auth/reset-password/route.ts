import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { validatePasswordResetToken, markTokenAsUsed } from '@/lib/password-reset';
import { validatePassword } from '@/lib/auth';
import crypto from 'crypto';

export async function POST(req: Request) {
  try {
    const { token, password } = await req.json();

    if (!token || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate password
    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    // Validate token and get user ID
    const tokenData = await validatePasswordResetToken(token);
    if (!tokenData) {
      return NextResponse.json({ error: 'Invalid or expired reset token' }, { status: 400 });
    }

    const sql = getSql();

    // Hash the new password
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    // Update password and mark token as used
    await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${tokenData.userId}`;
    await markTokenAsUsed(token);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
