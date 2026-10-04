import { NextResponse } from 'next/server';
import { claimPasswordResetAndUpdatePassword } from '@/lib/password-reset';
import { validatePassword } from '@/lib/auth';
import bcrypt from 'bcryptjs';

const INVALID_TOKEN_ERROR = 'Invalid or expired reset token';

export async function POST(req: Request) {
  try {
    const { token, password } = await req.json();

    if (!token || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // JSON values are untrusted. Keep malformed tokens on the same generic
    // invalid-token path rather than allowing crypto's type error to create a
    // different observable response.
    if (typeof token !== 'string') {
      return NextResponse.json({ error: INVALID_TOKEN_ERROR }, { status: 400 });
    }
    if (typeof password !== 'string') {
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

    // Hash before opening the transaction so bcrypt's CPU work does not hold a
    // database lock. The password is never logged or persisted outside the
    // atomic claim below.
    const passwordHash = await bcrypt.hash(password, 12);

    // The helper's conditional UPDATE is the authorization decision. It claims
    // an unused, unexpired matching hash and changes the password, revokes all
    // prior sessions, and retires outstanding reset rows in one transaction.
    // Unknown, used, expired, and concurrently claimed tokens deliberately have
    // the same response so callers learn no token state.
    const claim = await claimPasswordResetAndUpdatePassword(token, passwordHash);
    if (!claim) {
      return NextResponse.json({ error: INVALID_TOKEN_ERROR }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch {
    // Keep the public failure deterministic and never log request data, tokens,
    // or password-derived values from this credential-setting endpoint.
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
