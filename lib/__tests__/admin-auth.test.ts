/**
 * Administrator authentication lifecycle.
 *
 * Runs against a real PostgreSQL instance: the behaviour under test is the
 * interaction between session rows, the stored token hash, and the lock and
 * status columns. A mocked repository would only assert that the code calls the
 * methods it calls.
 */
import { getSql, initializeSchema } from '../db';
import {
  ADMIN_MAX_FAILED_LOGINS,
  hashAdminPassword,
  hashSessionToken,
  issueSessionCredential,
  lockoutExpiryFrom,
  parseSessionCookie,
  sessionTokenMatches,
  verifyAdminPassword,
} from '../rbac/admin-auth';
import { resolveAdminBySessionId } from '../rbac/admin-middleware';
import { getAdminRepository } from '../rbac/AdminRepository';

const sql = getSql();
const EMAIL = 'admin-auth-test@example.test';
const PASSWORD = 'correct horse battery staple 9!';

let adminId: number;

async function cleanup() {
  await sql`DELETE FROM admin_sessions WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email = ${EMAIL})`;
  await sql`DELETE FROM admin_audit_logs WHERE admin_user_id IN (SELECT id FROM admin_users WHERE email = ${EMAIL})`;
  await sql`DELETE FROM admin_users WHERE email = ${EMAIL}`;
}

beforeAll(async () => {
  await initializeSchema();
  await cleanup();
  const hash = await hashAdminPassword(PASSWORD);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, name, password_hash, role, status)
    VALUES (${EMAIL}, 'Auth Test', ${hash}, 'SuperAdmin', 'active')
    RETURNING id
  `;
  adminId = rows[0].id;
}, 60000);

beforeEach(async () => {
  await sql`DELETE FROM admin_sessions WHERE admin_user_id = ${adminId}`;
  await sql`
    UPDATE admin_users
    SET status = 'active', locked_until = NULL, failed_login_attempts = 0
    WHERE id = ${adminId}
  `;
});

afterAll(cleanup, 60000);

/** Issue a session for the test admin and return the cookie value. */
async function signIn(ttlHours = 12): Promise<string> {
  const cred = issueSessionCredential(ttlHours);
  await getAdminRepository().createSession(
    cred.sessionId,
    adminId,
    cred.tokenHash,
    cred.expiresAt,
  );
  return cred.cookieValue;
}

describe('session credential', () => {
  it('never puts the verifier in the cookie or the secret in the database', async () => {
    const cred = issueSessionCredential();
    const parsed = parseSessionCookie(cred.cookieValue)!;

    expect(parsed.sessionId).toBe(cred.sessionId);
    // The stored hash must not be derivable from what is stored alone.
    expect(cred.cookieValue).not.toContain(cred.tokenHash);
    expect(cred.tokenHash).toBe(hashSessionToken(parsed.token));
    expect(cred.tokenHash).not.toBe(parsed.token);
  });

  it('issues a distinct id and token every time', () => {
    const a = issueSessionCredential();
    const b = issueSessionCredential();
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.cookieValue).not.toBe(b.cookieValue);
  });

  it('rejects malformed cookies rather than guessing', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'nodot',
      '.leadingdot',
      'trailingdot.',
      'zz.'.padEnd(90, 'z'),
      `${'a'.repeat(31)}.${'b'.repeat(64)}`, // id too short
      `${'a'.repeat(32)}.${'b'.repeat(63)}`, // token too short
    ]) {
      expect(parseSessionCookie(bad as string | undefined)).toBeNull();
    }
  });

  it('matches only the exact token', () => {
    const cred = issueSessionCredential();
    const { token } = parseSessionCookie(cred.cookieValue)!;
    expect(sessionTokenMatches(token, cred.tokenHash)).toBe(true);
    expect(sessionTokenMatches(`${token.slice(0, -1)}0`, cred.tokenHash)).toBe(false);
    expect(sessionTokenMatches(token, 'not-hex')).toBe(false);
    expect(sessionTokenMatches(token, '')).toBe(false);
  });
});

describe('resolveAdminBySessionId', () => {
  it('accepts a freshly issued session', async () => {
    const cookie = await signIn();
    const admin = await resolveAdminBySessionId(cookie);
    expect(admin?.id).toBe(adminId);
  });

  it('rejects the session id alone, without the token', async () => {
    // This is the defect the split credential exists to close: before it, the
    // id was the whole credential and any reader of admin_sessions held one.
    const cookie = await signIn();
    const sessionId = cookie.split('.')[0];

    expect(await resolveAdminBySessionId(sessionId)).toBeNull();
  });

  it('rejects a valid session id paired with a wrong token', async () => {
    const cookie = await signIn();
    const [sessionId] = cookie.split('.');
    const forged = `${sessionId}.${'f'.repeat(64)}`;

    expect(await resolveAdminBySessionId(forged)).toBeNull();
  });

  it('rejects a token belonging to a different session', async () => {
    const first = await signIn();
    const second = await signIn();
    const crossed = `${first.split('.')[0]}.${second.split('.')[1]}`;

    expect(await resolveAdminBySessionId(crossed)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const cookie = await signIn();
    await sql`
      UPDATE admin_sessions SET expires_at = NOW() - INTERVAL '1 second'
      WHERE id = ${cookie.split('.')[0]}
    `;
    expect(await resolveAdminBySessionId(cookie)).toBeNull();
  });

  it('rejects a session whose administrator is locked', async () => {
    const cookie = await signIn();
    await sql`
      UPDATE admin_users SET locked_until = NOW() + INTERVAL '30 minutes' WHERE id = ${adminId}
    `;
    expect(await resolveAdminBySessionId(cookie)).toBeNull();
  });

  it('rejects a session whose administrator is no longer active', async () => {
    const cookie = await signIn();
    await sql`UPDATE admin_users SET status = 'suspended' WHERE id = ${adminId}`;
    expect(await resolveAdminBySessionId(cookie)).toBeNull();
  });

  it('rejects a deleted session, so logout is effective server-side', async () => {
    const cookie = await signIn();
    await getAdminRepository().deleteSession(cookie.split('.')[0]);
    expect(await resolveAdminBySessionId(cookie)).toBeNull();
  });

  it('rejects anonymous and malformed credentials', async () => {
    expect(await resolveAdminBySessionId(undefined)).toBeNull();
    expect(await resolveAdminBySessionId('')).toBeNull();
    expect(await resolveAdminBySessionId('garbage')).toBeNull();
  });
});

describe('password verification', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    const hash = await hashAdminPassword(PASSWORD);
    expect(await verifyAdminPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyAdminPassword('wrong', hash)).toBe(false);
  });

  it('returns false, rather than throwing, when no account exists', async () => {
    expect(await verifyAdminPassword(PASSWORD, null)).toBe(false);
    expect(await verifyAdminPassword(PASSWORD, undefined)).toBe(false);
  });

  it('does not store the password in recoverable form', async () => {
    const hash = await hashAdminPassword(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith('$2')).toBe(true);
  });
});

describe('lockout policy', () => {
  it('does not lock below the threshold', () => {
    for (let n = 0; n < ADMIN_MAX_FAILED_LOGINS; n++) {
      expect(lockoutExpiryFrom(n)).toBeNull();
    }
  });

  it('locks at the threshold and beyond', () => {
    const at = lockoutExpiryFrom(ADMIN_MAX_FAILED_LOGINS);
    expect(at).not.toBeNull();
    expect(new Date(at!).getTime()).toBeGreaterThan(Date.now());
    expect(lockoutExpiryFrom(ADMIN_MAX_FAILED_LOGINS + 3)).not.toBeNull();
  });

  it('records failures and clears them on success', async () => {
    const repo = getAdminRepository();
    await repo.recordFailedLogin(adminId, 3, null);
    let admin = await repo.findAdminById(adminId);
    expect(admin?.failed_login_attempts).toBe(3);
    expect(admin?.locked_until).toBeNull();

    await repo.recordFailedLogin(
      adminId,
      ADMIN_MAX_FAILED_LOGINS,
      lockoutExpiryFrom(ADMIN_MAX_FAILED_LOGINS),
    );
    admin = await repo.findAdminById(adminId);
    expect(admin?.locked_until).not.toBeNull();

    await repo.recordSuccessfulLogin(adminId);
    admin = await repo.findAdminById(adminId);
    expect(admin?.failed_login_attempts).toBe(0);
    expect(admin?.locked_until).toBeNull();
    expect(admin?.last_login_at).not.toBeNull();
  });
});

describe('bootstrap gate', () => {
  it('counts administrators as a number, so an empty table reads as 0', async () => {
    // countAdmins returns COUNT(*), which postgres.js hands back as a string.
    // The bootstrap check is `> 0`, so a string here would make an empty table
    // look populated and the reverse.
    const count = await getAdminRepository().countAdmins();
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThan(0); // this suite's own admin exists
  });
});
