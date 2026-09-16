import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { validatePasswordResetToken, markTokenAsUsed } from '@/lib/password-reset';
import { validatePassword, revokeUserSessions } from '@/lib/auth';
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

    // Update password, revoke existing sessions, and mark the token as used.
    //
    // The revocation is the point of resetting after a compromise. Without it
    // the attacker's cookie stays valid for the rest of its seven days, so the
    // owner changes their password and nothing actually changes.
    await sql.begin(async (tx) => {
      await tx`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${tokenData.userId}`;
      await revokeUserSessions(tokenData.userId, tx);
    });
    await markTokenAsUsed(token);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
