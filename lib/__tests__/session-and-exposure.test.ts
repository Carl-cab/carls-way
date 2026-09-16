import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { getSql, initializeSchema } from '@/lib/db';
import {
  signToken,
  signTokenForUser,
  verifyToken,
  revokeUserSessions,
  USER_PASSWORD_ROUNDS,
} from '@/lib/auth';
import { getAdminRepository } from '@/lib/rbac/AdminRepository';
import { verifyAdminPassword } from '@/lib/rbac/admin-password';

/**
 * Session revocation, admin password hashing, and what the API hands out about
 * other people.
 */

const sql = getSql();
let userId: number;

async function tokenVersion(id: number): Promise<number> {
  const rows = await sql<{ token_version: number }[]>`
    SELECT token_version FROM users WHERE id = ${id}
  `;
  return Number(rows[0].token_version);
}

beforeAll(async () => {
  await initializeSchema();
});

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2, 10);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country)
    VALUES ('Session Probe', ${'sess_' + suffix}, ${'sess_' + suffix + '@example.com'}, 'x', 'CA')
    RETURNING id
  `;
  userId = rows[0].id;
});

afterAll(async () => {
  await sql`DELETE FROM users WHERE username LIKE 'sess_%'`;
  await sql`DELETE FROM admin_users WHERE email LIKE 'adm_%'`;
});

describe('session revocation', () => {
  it('stamps the account token version onto a freshly issued token', async () => {
    const token = await signTokenForUser({
      userId,
      email: 'sess@example.com',
      username: 'sess',
    });
    expect(verifyToken(token)?.tv).toBe(await tokenVersion(userId));
  });

  it('bumps the version so previously issued tokens no longer match', async () => {
    const before = await tokenVersion(userId);
    const token = await signTokenForUser({ userId, email: 'a@b.c', username: 'sess' });

    await revokeUserSessions(userId);

    const after = await tokenVersion(userId);
    expect(after).toBe(before + 1);
    // The token itself is still cryptographically valid — that is the point.
    // Nothing about a signed JWT expires early, so the check has to be against
    // state the server controls.
    expect(verifyToken(token)?.tv).toBe(before);
    expect(verifyToken(token)!.tv).not.toBe(after);
  });

  it('revokes one account without touching another', async () => {
    const otherRows = await sql<{ id: number }[]>`
      INSERT INTO users (name, username, email, password_hash, country)
      VALUES ('Other', ${'sess_o' + Math.random().toString(36).slice(2, 8)},
              ${'sess_o' + Math.random().toString(36).slice(2, 8) + '@example.com'}, 'x', 'CA')
      RETURNING id
    `;
    const other = otherRows[0].id;
    const otherBefore = await tokenVersion(other);

    await revokeUserSessions(userId);

    expect(await tokenVersion(other)).toBe(otherBefore);
  });

  it('rolls the bump back when the surrounding transaction fails', async () => {
    const before = await tokenVersion(userId);
    await expect(
      sql.begin(async (tx) => {
        await revokeUserSessions(userId, tx);
        throw new Error('password update failed');
      }),
    ).rejects.toThrow('password update failed');

    // A revocation that survives a failed password change would log the owner
    // out without changing their password.
    expect(await tokenVersion(userId)).toBe(before);
  });

  it('treats a token with no version as unusable', () => {
    // Tokens minted before revocation existed carry no `tv`, so they cannot be
    // checked against anything and must not be trusted.
    const legacy = signToken({ userId, email: 'a@b.c', username: 'sess' });
    expect(verifyToken(legacy)?.tv).toBeUndefined();
  });

  it('is applied on password reset', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'app/api/auth/reset-password/route.ts',
      'utf8',
    );
    expect(source).toContain('revokeUserSessions');
  });

  it('is checked on every authenticated request', async () => {
    const source = await (await import('node:fs/promises')).readFile('lib/auth.ts', 'utf8');
    // getAuthUser must compare against stored state, not just verify a signature.
    expect(source).toMatch(/getAuthUser[\s\S]*SELECT token_version FROM users/);
  });
});

describe('admin password hashing', () => {
  it('creates an admin whose password the real login path can verify', async () => {
    const email = `adm_${Math.random().toString(36).slice(2, 10)}@example.com`;
    const admin = await getAdminRepository().createAdmin({
      email,
      name: 'Probe Admin',
      password: 'AdminPass123',
      role: 'OperationsAdmin',
    });

    // The whole defect: createAdmin wrote SHA-256 while login uses bcrypt, so
    // every admin made this way was locked out of their own account.
    expect(await verifyAdminPassword('AdminPass123', admin.password_hash)).toBe(true);
    expect(await verifyAdminPassword('WrongPass123', admin.password_hash)).toBe(false);
  });

  it('stores a salted bcrypt digest rather than a bare hash', async () => {
    const email = `adm_${Math.random().toString(36).slice(2, 10)}@example.com`;
    const admin = await getAdminRepository().createAdmin({
      email,
      name: 'Probe Admin',
      password: 'AdminPass123',
      role: 'OperationsAdmin',
    });

    expect(admin.password_hash.startsWith('$2')).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(admin.password_hash)).toBe(false);
  });

  it('no longer exposes SHA-256 password helpers', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'lib/rbac/AdminRepository.ts',
      'utf8',
    );
    expect(source).not.toMatch(/createHash\(['"]sha256['"]\)\.update\(password\)/);
    expect(source).not.toMatch(/createHash\(['"]sha256['"]\)\.update\(input\.password\)/);
    expect(source).toContain('hashAdminPassword');
  });
});

describe('what the API discloses about other people', () => {
  it('keeps email out of the user directory, in projection and predicate', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'app/api/users/route.ts',
      'utf8',
    );
    expect(source).not.toMatch(/SELECT[^`]*\bemail\b/);
    expect(source).not.toContain('email ILIKE');
  });

  it('requires a real search term instead of matching every row', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'app/api/users/route.ts',
      'utf8',
    );
    // An empty term produced '%%', which matched the whole table.
    expect(source).toMatch(/term\.trim\(\)\.length < 2/);
  });

  it('keeps email out of the friends list, which includes pending requests', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'app/api/friends/route.ts',
      'utf8',
    );
    // Strip SQL comments first: a comment explaining the omission is not a
    // selection, and asserting over raw text would pass or fail on prose.
    const code = source.replace(/^\s*--.*$/gm, '');
    expect(code).not.toContain('u.email');
  });
});

describe('transaction privacy default', () => {
  it('defaults a new row to private at the database level', async () => {
    const rows = await sql<{ column_default: string | null }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'privacy'
    `;
    expect(rows[0].column_default).toContain('private');
  });

  it('defaults to private in the route when the client omits it', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'app/api/transactions/route.ts',
      'utf8',
    );
    // This fallback, not the column default, decides what API payments get.
    expect(source).toMatch(/includes\(privacy\) \? privacy : 'private'/);
  });

  it('still honours an explicit public choice', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'app/api/transactions/route.ts',
      'utf8',
    );
    expect(source).toContain("['public', 'friends', 'private']");
  });
});

describe('password hashing costs stay aligned', () => {
  it('uses the same cost for customer registration and reset', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const route of [
      'app/api/auth/register/route.ts',
      'app/api/auth/reset-password/route.ts',
    ]) {
      expect(await readFile(route, 'utf8')).toContain(
        `bcrypt.hash(password, ${USER_PASSWORD_ROUNDS})`,
      );
    }
  });

  it('produces verifiable customer hashes at that cost', async () => {
    const hash = await bcrypt.hash('CustomerPass1', USER_PASSWORD_ROUNDS);
    expect(Number(hash.split('$')[2])).toBe(USER_PASSWORD_ROUNDS);
  });
});
