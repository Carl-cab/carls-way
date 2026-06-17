import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { createPasswordResetToken } from '@/lib/password-reset';
import { sendPasswordResetEmail } from '@/lib/email';

export async function POST(req: Request) {
  try {
    const { email } = await req.json();

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ success: true });
    }

    const sql = getSql();

    // Check if user exists (but don't reveal this)
    const users = await sql`SELECT id, email FROM users WHERE LOWER(email) = LOWER(${email})`;

    if (users.length > 0) {
      const user = users[0];
      try {
        const token = await createPasswordResetToken(user.id);
        await sendPasswordResetEmail(user.email, token);
      } catch (err) {
        console.error('Password reset email error:', err);
        // Don't expose email errors
      }
    }

    // Always return success, never reveal if email exists
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    return NextResponse.json({ success: true });
  }
}
