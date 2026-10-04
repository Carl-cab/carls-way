import 'server-only';

import { getSql } from '@/lib/db';
import {
  ADMIN_SESSION_TTL_HOURS,
  hashAdminPassword,
  issueSessionCredential,
  verifyAdminPassword,
} from './admin-auth';
import type { AdminRole } from './types';

/**
 * Context captured with a successful administrator password rotation. None of
 * these fields contain a password, password hash, or session secret.
 */
export interface AdminPasswordRotationAuditContext {
  /** Lookup id only; never the cookie token. */
  sessionId: string;
  correlationId?: string;
  sourceIp?: string;
  userAgent?: string;
}

export type AdminPasswordRotationResult =
  | {
      outcome: 'rotated';
      cookieValue: string;
      expiresAt: string;
    }
  | {
      outcome: 'current_password_invalid';
    }
  | {
      outcome: 'administrator_unavailable';
    };

type LockedAdministrator = {
  id: number;
  password_hash: string;
  role: AdminRole;
  status: string;
  locked_until: string | Date | null;
};

/**
 * Change an authenticated administrator's own password.
 *
 * The password update, revocation of every pre-existing admin session, creation
 * of one fresh browser session, and immutable audit record all commit or roll
 * back together. The new session is created only after old sessions are gone;
 * callers receive its cookie value once, in the HTTP Set-Cookie header.
 */
export async function rotateOwnAdminPassword(
  adminUserId: number,
  currentPassword: string,
  newPassword: string,
  auditContext: AdminPasswordRotationAuditContext,
): Promise<AdminPasswordRotationResult> {
  const sql = getSql();

  return sql.begin(async (tx) => {
    // Re-read and lock the row after middleware authentication. This prevents a
    // concurrent password rotation from accepting a stale current password.
    const administrators = await tx<LockedAdministrator[]>`
      SELECT id, password_hash, role, status, locked_until
      FROM admin_users
      WHERE id = ${adminUserId}
      FOR UPDATE
    `;
    const administrator = administrators[0];

    if (
      !administrator ||
      administrator.status !== 'active' ||
      (administrator.locked_until && new Date(administrator.locked_until) > new Date())
    ) {
      return { outcome: 'administrator_unavailable' };
    }

    // Keep comparison inside the transaction while the row lock is held so the
    // hash verified here is the hash that is replaced below.
    if (!(await verifyAdminPassword(currentPassword, administrator.password_hash))) {
      return { outcome: 'current_password_invalid' };
    }

    const passwordHash = await hashAdminPassword(newPassword);
    const credential = issueSessionCredential();

    await tx`
      UPDATE admin_users
      SET password_hash = ${passwordHash},
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at = NOW()
      WHERE id = ${administrator.id}
    `;

    // There is deliberately no exception for the session that initiated this
    // request. Expiring every old credential makes `findSession` reject it
    // immediately. We retain the rows instead of deleting them because the
    // immutable admin audit trail has a foreign-key reference to session ids;
    // deleting them could erase that forensic link or fail the whole rotation.
    await tx`
      UPDATE admin_sessions
      SET expires_at = NOW()
      WHERE admin_user_id = ${administrator.id}
        AND expires_at > NOW()
    `;

    await tx`
      INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
      VALUES (
        ${credential.sessionId},
        ${administrator.id},
        ${credential.tokenHash},
        ${credential.expiresAt}
      )
    `;

    // This is deliberately written through the same transaction rather than an
    // asynchronous best-effort helper. A successful response therefore always
    // has a corresponding durable audit record. `changes` is a fixed, nonsecret
    // statement of lifecycle effects—never request data or any credential.
    await tx`
      INSERT INTO admin_audit_logs (
        admin_user_id,
        session_id,
        action,
        resource_type,
        resource_id,
        changes,
        correlation_id,
        ip_address,
        user_agent,
        role,
        status
      ) VALUES (
        ${administrator.id},
        ${auditContext.sessionId},
        'admin_password_rotated_self',
        'admin_user',
        ${String(administrator.id)},
        ${JSON.stringify({ previous_sessions_revoked: true })},
        ${auditContext.correlationId ?? null},
        ${auditContext.sourceIp ?? null},
        ${auditContext.userAgent ?? null},
        ${administrator.role},
        'success'
      )
    `;

    return {
      outcome: 'rotated',
      cookieValue: credential.cookieValue,
      expiresAt: credential.expiresAt,
    };
  }) as Promise<AdminPasswordRotationResult>;
}

export const ADMIN_PASSWORD_ROTATION_SESSION_TTL_SECONDS =
  ADMIN_SESSION_TTL_HOURS * 60 * 60;
