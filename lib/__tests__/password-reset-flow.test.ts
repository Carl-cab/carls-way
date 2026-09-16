import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { getSql, initializeSchema } from '@/lib/db';
import { validatePassword } from '@/lib/auth';
import {
  createPasswordResetToken,
  validatePasswordResetToken,
  markTokenAsUsed,
} from '@/lib/password-reset';
import { POST as resetPassword } from '@/app/api/auth/reset-password/route';

/**
 * Password reset, end to end.
 *
 * The defect these cover was not a missing branch — it was two halves of the
 * route disagreeing with the rest of the application. The guard rejected every
 * request, and behind it the hash was written with an algorithm login cannot
 * verify. Either one alone is silent: the route returns a plausible 400, or it
 * returns success and the account is bricked. Only driving the whole flow —
 * reset, then authenticate with the new password the way login does — shows it.
 */

const sql = getSql();

function request(body: unknown): Request {
  return new Request('http://localhost/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let userId: number;
const ORIGINAL_PASSWORD = 'OriginalPass1';
const NEW_PASSWORD = 'BrandNewPass9';

beforeAll(async () => {
  await initializeSchema();
});

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country)
    VALUES ('Reset Probe', ${'reset_' + suffix}, ${'reset_' + suffix + '@example.com'},
            ${await bcrypt.hash(ORIGINAL_PASSWORD, 12)}, 'CA')
    RETURNING id
  `;
  userId = rows[0].id;
});

afterAll(async () => {
  await sql`DELETE FROM password_reset_tokens WHERE user_id IN
            (SELECT id FROM users WHERE username LIKE 'reset_%')`;
  await sql`DELETE FROM users WHERE username LIKE 'reset_%'`;
});

async function storedHash(): Promise<string> {
  const rows = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM users WHERE id = ${userId}
  `;
  return rows[0].password_hash;
}

describe('password reset', () => {
  it('accepts a valid new password instead of rejecting every request', async () => {
    const token = await createPasswordResetToken(userId);
    const res = await resetPassword(request({ token, password: NEW_PASSWORD }));

    // The whole defect in one assertion: this returned 400 for every caller,
    // because `if (passwordError)` tested an always-truthy object.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('leaves the account usable — the new password authenticates afterwards', async () => {
    const token = await createPasswordResetToken(userId);
    await resetPassword(request({ token, password: NEW_PASSWORD }));

    // This is how app/api/auth/login/route.ts checks a password. A SHA-256
    // digest here returns false and the user is locked out permanently.
    expect(await bcrypt.compare(NEW_PASSWORD, await storedHash())).toBe(true);
  });

  it('stops the old password working once reset', async () => {
    const token = await createPasswordResetToken(userId);
    await resetPassword(request({ token, password: NEW_PASSWORD }));
    expect(await bcrypt.compare(ORIGINAL_PASSWORD, await storedHash())).toBe(false);
  });

  it('stores a salted bcrypt digest, not a bare hash of the password', async () => {
    const token = await createPasswordResetToken(userId);
    await resetPassword(request({ token, password: NEW_PASSWORD }));
    const hash = await storedHash();

    expect(hash.startsWith('$2')).toBe(true); // bcrypt, not hex
    expect(hash).not.toContain(NEW_PASSWORD);
    // An unsalted SHA-256 of the password is 64 hex characters and identical
    // for every user who picks this password.
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(false);
  });

  it('salts per reset, so two users with one password get different digests', async () => {
    const tokenA = await createPasswordResetToken(userId);
    await resetPassword(request({ token: tokenA, password: NEW_PASSWORD }));
    const first = await storedHash();

    const tokenB = await createPasswordResetToken(userId);
    await resetPassword(request({ token: tokenB, password: NEW_PASSWORD }));
    const second = await storedHash();

    expect(first).not.toBe(second);
    expect(await bcrypt.compare(NEW_PASSWORD, second)).toBe(true);
  });

  it('still rejects a password that fails the policy, with a readable reason', async () => {
    const token = await createPasswordResetToken(userId);
    const res = await resetPassword(request({ token, password: 'short' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    // The old code put the whole { valid, reason } object here.
    expect(typeof body.error).toBe('string');
    expect(body.error).toBe(validatePassword('short').reason);
    // A rejected reset must not touch the stored password.
    expect(await bcrypt.compare(ORIGINAL_PASSWORD, await storedHash())).toBe(true);
  });

  it('rejects an invalid token without changing the password', async () => {
    const res = await resetPassword(request({ token: 'not-a-real-token', password: NEW_PASSWORD }));
    expect(res.status).toBe(400);
    expect(await bcrypt.compare(ORIGINAL_PASSWORD, await storedHash())).toBe(true);
  });

  it('consumes the token so a reset link cannot be replayed', async () => {
    const token = await createPasswordResetToken(userId);
    await resetPassword(request({ token, password: NEW_PASSWORD }));

    expect(await validatePasswordResetToken(token)).toBeNull();
    const replay = await resetPassword(request({ token, password: 'ThirdPassword3' }));
    expect(replay.status).toBe(400);
    expect(await bcrypt.compare(NEW_PASSWORD, await storedHash())).toBe(true);
  });

  it('rejects a request missing the token or the password', async () => {
    expect((await resetPassword(request({ password: NEW_PASSWORD }))).status).toBe(400);
    expect((await resetPassword(request({ token: 'x' }))).status).toBe(400);
  });
});

describe('validatePassword contract', () => {
  it('returns an object whose truthiness carries no meaning', () => {
    // Why the bug was invisible: both outcomes are truthy. Callers must read
    // `.valid`, and a test that only checks the return value is not enough.
    expect(Boolean(validatePassword('ValidPass1'))).toBe(true);
    expect(Boolean(validatePassword('bad'))).toBe(true);

    expect(validatePassword('ValidPass1').valid).toBe(true);
    expect(validatePassword('bad').valid).toBe(false);
    expect(typeof validatePassword('bad').reason).toBe('string');
  });

  it('is used consistently by every route that sets a password', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const route of [
      'app/api/auth/register/route.ts',
      'app/api/auth/reset-password/route.ts',
    ]) {
      const source = await readFile(route, 'utf8');
      expect(source).toContain('validatePassword(password)');
      // Guard against the object being tested for truthiness again.
      expect(source).toMatch(/if \(!\w+\.valid\)/);
    }
  });

  it('never leaves a password-setting route hashing with a bare digest', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const route of [
      'app/api/auth/register/route.ts',
      'app/api/auth/reset-password/route.ts',
    ]) {
      const source = await readFile(route, 'utf8');
      expect(source).toContain('bcrypt.hash(password, 12)');
      expect(source).not.toMatch(/createHash\(['"]sha256['"]\)\s*\.update\(password\)/);
    }
  });
});

describe('token lifecycle', () => {
  it('marks a token used exactly once', async () => {
    const token = await createPasswordResetToken(userId);
    expect(await validatePasswordResetToken(token)).toEqual({ userId });
    await markTokenAsUsed(token);
    expect(await validatePasswordResetToken(token)).toBeNull();
  });
});
