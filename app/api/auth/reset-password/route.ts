import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { validatePasswordResetToken, markTokenAsUsed } from '@/lib/password-reset';
import { validatePassword } from '@/lib/auth';
import bcrypt from 'bcryptjs';

export async function POST(req: Request) {
  try {
    const { token, password } = await req.json();

    if (!token || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Validate password.
    //
    // This previously read `if (passwordError)` against the returned object.
    // Every object is truthy, including `{ valid: true }`, so a correct new
    // password took the failure branch exactly like a rejected one: password
    // reset returned 400 for everybody, and the body carried the object itself
    // where the API contract promises a string. Registration has always tested
    // `.valid`; this now matches it.
    const pwCheck = validatePassword(password);
    if (!pwCheck.valid) {
      return NextResponse.json({ error: pwCheck.reason }, { status: 400 });
    }

    // Validate token and get user ID
    const tokenData = await validatePasswordResetToken(token);
    if (!tokenData) {
      return NextResponse.json({ error: 'Invalid or expired reset token' }, { status: 400 });
    }

    const sql = getSql();

    // Hash the new password with the same algorithm and cost registration uses.
    //
    // This was unsalted SHA-256 while registration used bcrypt and login
    // verifies with bcrypt.compare. It was unreachable only because the guard
    // above rejected every request first — so fixing that guard alone would
    // have started writing digests bcrypt can never match, locking users out
    // permanently and storing passwords a rainbow table reverses instantly.
    // The two changes belong together and must not be separated.
    const passwordHash = await bcrypt.hash(password, 12);

    // Update password and mark token as used
    await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${tokenData.userId}`;
    await markTokenAsUsed(token);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
