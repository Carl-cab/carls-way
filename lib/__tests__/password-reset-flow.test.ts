import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { getSql, initializeSchema } from '@/lib/db';
import { signTokenForUser, validatePassword, verifyToken } from '@/lib/auth';
import {
  createPasswordResetToken,
  generateResetToken,
  hashToken,
  markTokenAsUsed,
  validatePasswordResetToken,
} from '@/lib/password-reset';
import { POST as resetPassword } from '@/app/api/auth/reset-password/route';

/**
 * Password reset, end to end.
 *
 * These deliberately run against PostgreSQL rather than a query mock. The
 * security property is a transaction boundary: only a real database can prove
 * that a conditional token claim, password update, session revocation, and
 * token retirement commit together or not at all.
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
let username: string;
const ORIGINAL_PASSWORD = 'OriginalPass1';
const NEW_PASSWORD = 'BrandNewPass9';
const INVALID_TOKEN_ERROR = 'Invalid or expired reset token';

beforeAll(async () => {
  await initializeSchema();
});

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  username = 'reset_' + suffix;
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country)
    VALUES ('Reset Probe', ${username}, ${username + '@example.com'},
            ${await bcrypt.hash(ORIGINAL_PASSWORD, 12)}, 'CA')
    RETURNING id
  `;
  userId = rows[0].id;
});

afterAll(async () => {
  // Defensive cleanup in case a failure interrupted the rollback test's finally.
  await sql`DROP TRIGGER IF EXISTS password_reset_test_reject_update ON users`;
  await sql`DROP FUNCTION IF EXISTS password_reset_test_reject_update()`;
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

async function tokenVersion(): Promise<number> {
  const rows = await sql<{ token_version: number }[]>`
    SELECT token_version FROM users WHERE id = ${userId}
  `;
  return Number(rows[0].token_version);
}

describe('password reset', () => {
  it('accepts a valid new password instead of rejecting every request', async () => {
    const token = await createPasswordResetToken(userId);
    const res = await resetPassword(request({ token, password: NEW_PASSWORD }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('writes a salted bcrypt password and makes the old password fail', async () => {
    const token = await createPasswordResetToken(userId);
    await resetPassword(request({ token, password: NEW_PASSWORD }));
    const hash = await storedHash();

    expect(await bcrypt.compare(NEW_PASSWORD, hash)).toBe(true);
    expect(await bcrypt.compare(ORIGINAL_PASSWORD, hash)).toBe(false);
    expect(hash.startsWith('$2')).toBe(true);
    expect(hash).not.toContain(NEW_PASSWORD);
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(false);
  });

  it('uses a new bcrypt salt when the same password is reset again with a new token', async () => {
    const tokenA = await createPasswordResetToken(userId);
    await resetPassword(request({ token: tokenA, password: NEW_PASSWORD }));
    const first = await storedHash();

    const tokenB = await createPasswordResetToken(userId);
    await resetPassword(request({ token: tokenB, password: NEW_PASSWORD }));
    const second = await storedHash();

    expect(first).not.toBe(second);
    expect(await bcrypt.compare(NEW_PASSWORD, second)).toBe(true);
  });

  it('rejects a password that fails the policy without claiming the token', async () => {
    const token = await createPasswordResetToken(userId);
    const res = await resetPassword(request({ token, password: 'short' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error).toBe(validatePassword('short').reason);
    expect(await validatePasswordResetToken(token)).toEqual({ userId });
    expect(await bcrypt.compare(ORIGINAL_PASSWORD, await storedHash())).toBe(true);
  });

  it('uses one deterministic generic response for unknown, used, and expired tokens', async () => {
    const usedToken = await createPasswordResetToken(userId);
    await markTokenAsUsed(usedToken);

    const expiredToken = await createPasswordResetToken(userId);
    await sql`
      UPDATE password_reset_tokens
      SET expires_at = NOW() - INTERVAL '1 second'
      WHERE token_hash = ${hashToken(expiredToken)}
    `;

    const responses = await Promise.all([
      resetPassword(request({ token: 'not-a-real-token', password: NEW_PASSWORD })),
      resetPassword(request({ token: usedToken, password: NEW_PASSWORD })),
      resetPassword(request({ token: expiredToken, password: NEW_PASSWORD })),
      resetPassword(request({ token: { malformed: true }, password: NEW_PASSWORD })),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: INVALID_TOKEN_ERROR });
    }
    expect(await bcrypt.compare(ORIGINAL_PASSWORD, await storedHash())).toBe(true);
    expect(await tokenVersion()).toBe(0);
  });

  it('consumes the token so a reset link cannot be replayed', async () => {
    const token = await createPasswordResetToken(userId);
    await resetPassword(request({ token, password: NEW_PASSWORD }));

    expect(await validatePasswordResetToken(token)).toBeNull();
    const replay = await resetPassword(request({ token, password: 'ThirdPassword3' }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: INVALID_TOKEN_ERROR });
    expect(await bcrypt.compare(NEW_PASSWORD, await storedHash())).toBe(true);
  });

  it('allows exactly one of two concurrent requests using the same valid token', async () => {
    const token = await createPasswordResetToken(userId);
    const beforeVersion = await tokenVersion();

    const [first, second] = await Promise.all([
      resetPassword(request({ token, password: 'ConcurrentPass1' })),
      resetPassword(request({ token, password: 'ConcurrentPass2' })),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const failed = first.status === 400 ? first : second;
    expect(await failed.json()).toEqual({ error: INVALID_TOKEN_ERROR });

    const finalHash = await storedHash();
    const successfulPasswords = await Promise.all([
      bcrypt.compare('ConcurrentPass1', finalHash),
      bcrypt.compare('ConcurrentPass2', finalHash),
    ]);
    expect(successfulPasswords.filter(Boolean)).toHaveLength(1);
    expect(await tokenVersion()).toBe(beforeVersion + 1);
    expect(await validatePasswordResetToken(token)).toBeNull();
  });

  it('increments token_version, making a previously issued customer session stale', async () => {
    const beforeVersion = await tokenVersion();
    const issuedBeforeReset = await signTokenForUser({
      userId,
      email: username + '@example.com',
      username,
    });
    const token = await createPasswordResetToken(userId);

    const res = await resetPassword(request({ token, password: NEW_PASSWORD }));
    expect(res.status).toBe(200);
    expect(verifyToken(issuedBeforeReset)?.tv).toBe(beforeVersion);
    expect(await tokenVersion()).toBe(beforeVersion + 1);
    expect(verifyToken(issuedBeforeReset)?.tv).not.toBe(await tokenVersion());
  });

  it('retires other active reset rows for the account in the successful transaction', async () => {
    const token = await createPasswordResetToken(userId);
    const legacyAdditionalToken = generateResetToken();
    await sql`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
      VALUES (${userId}, ${hashToken(legacyAdditionalToken)}, NOW() + INTERVAL '1 hour', NOW())
    `;

    const res = await resetPassword(request({ token, password: NEW_PASSWORD }));
    expect(res.status).toBe(200);
    expect(await validatePasswordResetToken(legacyAdditionalToken)).toBeNull();
  });

  it('rolls back the token claim and session revocation when the user password update fails', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const rollbackUsername = `reset_rollback_${suffix}`;
    const rollbackUser = await sql<{ id: number }[]>`
      INSERT INTO users (name, username, email, password_hash, country)
      VALUES ('Rollback Probe', ${rollbackUsername}, ${rollbackUsername + '@example.com'},
              ${await bcrypt.hash(ORIGINAL_PASSWORD, 12)}, 'CA')
      RETURNING id
    `;
    const rollbackUserId = rollbackUser[0].id;
    const token = await createPasswordResetToken(rollbackUserId);

    await sql`
      CREATE OR REPLACE FUNCTION password_reset_test_reject_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.username LIKE 'reset_rollback_%' THEN
          RAISE EXCEPTION 'test-only password update failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await sql`
      CREATE TRIGGER password_reset_test_reject_update
      BEFORE UPDATE OF password_hash ON users
      FOR EACH ROW EXECUTE FUNCTION password_reset_test_reject_update()
    `;

    try {
      const res = await resetPassword(request({ token, password: NEW_PASSWORD }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to reset password' });

      const rows = await sql<{ password_hash: string; token_version: number }[]>`
        SELECT password_hash, token_version FROM users WHERE id = ${rollbackUserId}
      `;
      expect(await bcrypt.compare(ORIGINAL_PASSWORD, rows[0].password_hash)).toBe(true);
      expect(Number(rows[0].token_version)).toBe(0);
      expect(await validatePasswordResetToken(token)).toEqual({ userId: rollbackUserId });
    } finally {
      await sql`DROP TRIGGER IF EXISTS password_reset_test_reject_update ON users`;
      await sql`DROP FUNCTION IF EXISTS password_reset_test_reject_update()`;
      await sql`DELETE FROM password_reset_tokens WHERE user_id = ${rollbackUserId}`;
      await sql`DELETE FROM users WHERE id = ${rollbackUserId}`;
    }
  });

  it('rejects a request missing the token or the password', async () => {
    expect((await resetPassword(request({ password: NEW_PASSWORD }))).status).toBe(400);
    expect((await resetPassword(request({ token: 'x' }))).status).toBe(400);
  });
});

describe('validatePassword contract', () => {
  it('returns an object whose truthiness carries no meaning', () => {
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
