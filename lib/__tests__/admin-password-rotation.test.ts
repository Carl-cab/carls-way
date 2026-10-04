import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getSql, initializeSchema } from '@/lib/db';
import { POST as rotatePassword } from '@/app/api/admin/auth/password/route';
import { getAdminRepository } from '@/lib/rbac/AdminRepository';
import {
  ADMIN_SESSION_COOKIE,
  hashAdminPassword,
  issueSessionCredential,
  verifyAdminPassword,
} from '@/lib/rbac/admin-auth';
import { resolveAdminBySessionId } from '@/lib/rbac/admin-middleware';
import { __resetInMemoryCounters } from '@/lib/rate-limit';

const sql = getSql();
const TEST_EMAIL_PREFIX = 'admin-password-rotation-';
const INITIAL_PASSWORD = 'InitialAdminPass1';
const ROTATED_PASSWORD = 'RotatedAdminPass9';

let adminId: number;
let adminEmail: string;

async function removeTestAdministrators() {
  await sql`
    DELETE FROM admin_audit_logs
    WHERE admin_user_id IN (
      SELECT id FROM admin_users WHERE email LIKE ${TEST_EMAIL_PREFIX + '%'}
    )
  `;
  await sql`
    DELETE FROM admin_sessions
    WHERE admin_user_id IN (
      SELECT id FROM admin_users WHERE email LIKE ${TEST_EMAIL_PREFIX + '%'}
    )
  `;
  await sql`DELETE FROM admin_users WHERE email LIKE ${TEST_EMAIL_PREFIX + '%'}`;
}

async function createAdministrator(role = 'OperationsAdmin'): Promise<void> {
  adminEmail = `${TEST_EMAIL_PREFIX}${Math.random().toString(36).slice(2, 10)}@example.test`;
  const rows = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, name, password_hash, role, status)
    VALUES (
      ${adminEmail},
      'Password Rotation Test',
      ${await hashAdminPassword(INITIAL_PASSWORD)},
      ${role},
      'active'
    )
    RETURNING id
  `;
  adminId = rows[0].id;
}

async function signIn(): Promise<string> {
  const credential = issueSessionCredential();
  await getAdminRepository().createSession(
    credential.sessionId,
    adminId,
    credential.tokenHash,
    credential.expiresAt,
  );
  return credential.cookieValue;
}

function request(cookieValue: string | undefined, body: unknown): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookieValue) headers.set('cookie', `${ADMIN_SESSION_COOKIE}=${cookieValue}`);
  return new NextRequest('http://localhost/api/admin/auth/password', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function storedPasswordHash(): Promise<string> {
  const rows = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM admin_users WHERE id = ${adminId}
  `;
  return rows[0].password_hash;
}

beforeAll(async () => {
  await initializeSchema();
}, 60000);

beforeEach(async () => {
  __resetInMemoryCounters();
  await removeTestAdministrators();
  await createAdministrator();
});

afterAll(async () => {
  await removeTestAdministrators();
}, 60000);

describe('administrator self-service password rotation', () => {
  it('rejects unauthenticated calls', async () => {
    const response = await rotatePassword(
      request(undefined, {
        current_password: INITIAL_PASSWORD,
        new_password: ROTATED_PASSWORD,
      }),
    );

    expect(response.status).toBe(401);
    expect(await verifyAdminPassword(INITIAL_PASSWORD, await storedPasswordHash())).toBe(true);
  });

  it('fails closed when the authenticated role lacks the narrow self-rotation permission', async () => {
    await removeTestAdministrators();
    await createAdministrator('UnrecognizedRole');
    const session = await signIn();

    const response = await rotatePassword(
      request(session, {
        current_password: INITIAL_PASSWORD,
        new_password: ROTATED_PASSWORD,
      }),
    );

    expect(response.status).toBe(403);
    expect(await verifyAdminPassword(INITIAL_PASSWORD, await storedPasswordHash())).toBe(true);
  });

  it('rejects an incorrect current password without changing credentials or sessions', async () => {
    const session = await signIn();
    const response = await rotatePassword(
      request(session, {
        current_password: 'NotTheCurrentPassword1',
        new_password: ROTATED_PASSWORD,
      }),
    );

    expect(response.status).toBe(401);
    expect(await verifyAdminPassword(INITIAL_PASSWORD, await storedPasswordHash())).toBe(true);
    expect(await resolveAdminBySessionId(session)).not.toBeNull();
  });

  it('enforces the established password policy before changing the account', async () => {
    const session = await signIn();
    const response = await rotatePassword(
      request(session, {
        current_password: INITIAL_PASSWORD,
        new_password: 'short',
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('at least 8 characters');
    expect(await verifyAdminPassword(INITIAL_PASSWORD, await storedPasswordHash())).toBe(true);
    expect(await resolveAdminBySessionId(session)).not.toBeNull();
  });

  it('changes the bcrypt password, revokes every old session, and keeps only a fresh session', async () => {
    const initiatingSession = await signIn();
    const otherSession = await signIn();

    const response = await rotatePassword(
      request(initiatingSession, {
        current_password: INITIAL_PASSWORD,
        new_password: ROTATED_PASSWORD,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });

    const newSession = response.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    expect(newSession).toBeTruthy();
    expect(newSession).not.toBe(initiatingSession);
    expect(await verifyAdminPassword(ROTATED_PASSWORD, await storedPasswordHash())).toBe(true);
    expect(await verifyAdminPassword(INITIAL_PASSWORD, await storedPasswordHash())).toBe(false);

    // Both the initiating browser credential and a second concurrent browser
    // credential are dead. Only the freshly set cookie can authenticate.
    expect(await resolveAdminBySessionId(initiatingSession)).toBeNull();
    expect(await resolveAdminBySessionId(otherSession)).toBeNull();
    expect(await resolveAdminBySessionId(newSession)).toMatchObject({ id: adminId });

    const sessions = await sql<{ id: string }[]>`
      SELECT id FROM admin_sessions
      WHERE admin_user_id = ${adminId} AND expires_at > NOW()
    `;
    expect(sessions).toEqual([{ id: newSession!.split('.')[0] }]);
  });

  it('writes one durable, non-sensitive administrator audit event for a successful rotation', async () => {
    const session = await signIn();
    const response = await rotatePassword(
      request(session, {
        current_password: INITIAL_PASSWORD,
        new_password: ROTATED_PASSWORD,
      }),
    );
    expect(response.status).toBe(200);

    const auditRows = await sql<{
      action: string;
      resource_type: string;
      resource_id: string;
      changes: unknown;
      session_id: string;
      status: string;
    }[]>`
      SELECT action, resource_type, resource_id, changes, session_id, status
      FROM admin_audit_logs
      WHERE admin_user_id = ${adminId}
        AND action = 'admin_password_rotated_self'
    `;

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: 'admin_password_rotated_self',
      resource_type: 'admin_user',
      resource_id: String(adminId),
      session_id: session.split('.')[0],
      status: 'success',
    });
    const changes =
      typeof auditRows[0].changes === 'string'
        ? JSON.parse(auditRows[0].changes)
        : auditRows[0].changes;
    expect(changes).toEqual({ previous_sessions_revoked: true });
    expect(JSON.stringify(changes)).not.toContain(INITIAL_PASSWORD);
    expect(JSON.stringify(changes)).not.toContain(ROTATED_PASSWORD);
  });
});
