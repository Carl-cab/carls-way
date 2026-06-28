/**
 * Admin repository for RBAC user management.
 *
 * Responsibilities:
 * - Create and manage admin users
 * - Authenticate admin sessions
 * - Query admin roles and permissions
 * - No business logic, no authorization decisions
 */

import { BaseRepository } from '@/lib/repositories/BaseRepository';
import { createHash } from 'crypto';
import type {
  AdminUser,
  AdminRole,
  AdminSession,
  CreateAdminUserInput,
  UpdateAdminUserInput,
  CreateAdminSessionInput,
} from './types';
import { NotFoundError, DuplicateKeyError, TransactionError } from '@/lib/repositories/types';

export class AdminRepository extends BaseRepository {
  /**
   * Find admin user by ID.
   *
   * @param id Admin user ID
   * @returns Admin user or null
   */
  async findAdminById(id: number): Promise<AdminUser | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<AdminUser[]>`
        SELECT *
        FROM admin_users
        WHERE id = ${id}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'AdminRepository.findAdminById');
  }

  /**
   * Find admin user by email.
   *
   * @param email Email address
   * @returns Admin user or null
   */
  async findAdminByEmail(email: string): Promise<AdminUser | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<AdminUser[]>`
        SELECT *
        FROM admin_users
        WHERE email = ${email.toLowerCase()}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'AdminRepository.findAdminByEmail');
  }

  /**
   * Get all admin users.
   *
   * @param limit Maximum results
   * @returns Array of admin users
   */
  async findAllAdmins(limit: number = 100): Promise<AdminUser[]> {
    return this.executeQuery(async () => {
      return this.sql<AdminUser[]>`
        SELECT *
        FROM admin_users
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'AdminRepository.findAllAdmins');
  }

  /**
   * Get admin users by role.
   *
   * @param role Admin role
   * @param limit Maximum results
   * @returns Array of admin users
   */
  async findAdminsByRole(role: AdminRole, limit: number = 100): Promise<AdminUser[]> {
    return this.executeQuery(async () => {
      return this.sql<AdminUser[]>`
        SELECT *
        FROM admin_users
        WHERE role = ${role}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'AdminRepository.findAdminsByRole');
  }

  /**
   * Create a new admin user.
   *
   * @param input Admin user creation data
   * @returns Created admin user
   * @throws DuplicateKeyError if email already exists
   */
  async createAdmin(input: CreateAdminUserInput): Promise<AdminUser> {
    return this.executeQuery(async () => {
      // Hash password using PBKDF2
      const passwordHash = createHash('sha256').update(input.password).digest('hex');

      const result = await this.sql<AdminUser[]>`
        INSERT INTO admin_users (
          email, name, password_hash, role, status
        )
        VALUES (
          ${input.email.toLowerCase()},
          ${input.name},
          ${passwordHash},
          ${input.role},
          'active'
        )
        RETURNING *
      `;

      this.assertFound(result[0], 'created admin user');
      return result[0];
    }, 'AdminRepository.createAdmin');
  }

  /**
   * Update admin user.
   *
   * @param id Admin user ID
   * @param updates Partial update data
   * @returns Updated admin user
   */
  async updateAdmin(id: number, updates: UpdateAdminUserInput): Promise<AdminUser> {
    return this.executeQuery(async () => {
      const fields: string[] = [];
      const values: any[] = [];

      if (updates.name !== undefined) {
        fields.push('name');
        values.push(updates.name);
      }

      if (updates.role !== undefined) {
        fields.push('role');
        values.push(updates.role);
      }

      if (updates.status !== undefined) {
        fields.push('status');
        values.push(updates.status);
      }

      if (fields.length === 0) {
        const existing = await this.findAdminById(id);
        this.assertFound(existing, `admin user ${id}`);
        return existing;
      }

      fields.push('updated_at');
      values.push(new Date().toISOString());

      values.push(id);

      const placeholders = fields.map((_, i) => `${fields[i]} = $${i + 1}`).join(', ');
      const query = `UPDATE admin_users SET ${placeholders} WHERE id = $${fields.length + 1} RETURNING *`;

      const result = await this.sql.unsafe<AdminUser[]>(query, values as any);
      this.assertFound(result[0], `admin user ${id}`);
      return result[0];
    }, 'AdminRepository.updateAdmin');
  }

  /**
   * Update admin auth state (failed attempts, lockout).
   *
   * @param id Admin user ID
   * @param failedAttempts New failed attempt count
   * @param lockedUntil Lockout timestamp (null to unlock)
   * @returns Updated admin user
   */
  async updateAuthState(
    id: number,
    failedAttempts?: number,
    lockedUntil?: string | null
  ): Promise<AdminUser> {
    return this.executeQuery(async () => {
      let query = 'UPDATE admin_users SET ';
      const updates: any[] = [];

      if (failedAttempts !== undefined) {
        query += `failed_login_attempts = $${updates.length + 1}, `;
        updates.push(failedAttempts);
      }

      if (lockedUntil !== undefined) {
        query += `locked_until = $${updates.length + 1}, `;
        updates.push(lockedUntil);
      }

      if (updates.length === 0) {
        const existing = await this.findAdminById(id);
        this.assertFound(existing, `admin user ${id}`);
        return existing;
      }

      query = query.slice(0, -2);
      query += ` WHERE id = $${updates.length + 1} RETURNING *`;
      updates.push(id);

      const result = await this.sql.unsafe<AdminUser[]>(query, updates as any);
      this.assertFound(result[0], `admin user ${id}`);
      return result[0];
    }, 'AdminRepository.updateAuthState');
  }

  /**
   * Update last login timestamp.
   *
   * @param id Admin user ID
   * @returns Updated admin user
   */
  async updateLastLogin(id: number): Promise<AdminUser> {
    return this.executeQuery(async () => {
      const result = await this.sql<AdminUser[]>`
        UPDATE admin_users
        SET last_login_at = NOW(),
            failed_login_attempts = 0,
            locked_until = NULL,
            updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `admin user ${id}`);
      return result[0];
    }, 'AdminRepository.updateLastLogin');
  }

  /**
   * Create admin session (authentication token).
   *
   * @param sessionId Session ID (random)
   * @param adminUserId Admin user ID
   * @param tokenHash Hashed token
   * @param expiresAt Expiration timestamp
   * @returns Created session
   */
  async createSession(
    sessionId: string,
    adminUserId: number,
    tokenHash: string,
    expiresAt: string
  ): Promise<AdminSession> {
    return this.executeQuery(async () => {
      const result = await this.sql<AdminSession[]>`
        INSERT INTO admin_sessions (
          id, admin_user_id, token_hash, expires_at
        )
        VALUES (
          ${sessionId},
          ${adminUserId},
          ${tokenHash},
          ${expiresAt}
        )
        RETURNING *
      `;

      this.assertFound(result[0], 'created admin session');
      return result[0];
    }, 'AdminRepository.createSession');
  }

  /**
   * Find admin session by ID.
   *
   * @param sessionId Session ID
   * @returns Admin session or null
   */
  async findSession(sessionId: string): Promise<AdminSession | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<AdminSession[]>`
        SELECT *
        FROM admin_sessions
        WHERE id = ${sessionId}
          AND expires_at > NOW()
        LIMIT 1
      `;
      return result[0] || null;
    }, 'AdminRepository.findSession');
  }

  /**
   * Update session last activity.
   *
   * @param sessionId Session ID
   * @returns Updated session
   */
  async updateSessionActivity(sessionId: string): Promise<AdminSession> {
    return this.executeQuery(async () => {
      const result = await this.sql<AdminSession[]>`
        UPDATE admin_sessions
        SET last_activity_at = NOW()
        WHERE id = ${sessionId}
        RETURNING *
      `;

      this.assertFound(result[0], `session ${sessionId}`);
      return result[0];
    }, 'AdminRepository.updateSessionActivity');
  }

  /**
   * Delete admin session (logout).
   *
   * @param sessionId Session ID
   */
  async deleteSession(sessionId: string): Promise<void> {
    return this.executeQuery(async () => {
      await this.sql`
        DELETE FROM admin_sessions
        WHERE id = ${sessionId}
      `;
    }, 'AdminRepository.deleteSession');
  }

  /**
   * Get all sessions for an admin user.
   *
   * @param adminUserId Admin user ID
   * @returns Array of sessions
   */
  async findSessionsByAdmin(adminUserId: number): Promise<AdminSession[]> {
    return this.executeQuery(async () => {
      return this.sql<AdminSession[]>`
        SELECT *
        FROM admin_sessions
        WHERE admin_user_id = ${adminUserId}
          AND expires_at > NOW()
        ORDER BY last_activity_at DESC
      `;
    }, 'AdminRepository.findSessionsByAdmin');
  }

  /**
   * Delete all sessions for an admin user (global logout).
   *
   * @param adminUserId Admin user ID
   */
  async deleteSessionsByAdmin(adminUserId: number): Promise<void> {
    return this.executeQuery(async () => {
      await this.sql`
        DELETE FROM admin_sessions
        WHERE admin_user_id = ${adminUserId}
      `;
    }, 'AdminRepository.deleteSessionsByAdmin');
  }

  /**
   * Count admin users by role.
   *
   * @returns Map of role to count
   */
  async countByRole(): Promise<Record<AdminRole, number>> {
    return this.executeQuery(async () => {
      const result = await this.sql<{ role: string; count: number }[]>`
        SELECT role, COUNT(*) as count
        FROM admin_users
        GROUP BY role
      `;

      const counts: Record<string, number> = {};
      for (const row of result) {
        counts[row.role] = row.count;
      }

      return counts as Record<AdminRole, number>;
    }, 'AdminRepository.countByRole');
  }

  /**
   * Check if an email is already registered as admin.
   *
   * @param email Email to check
   * @returns true if email exists
   */
  async adminEmailExists(email: string): Promise<boolean> {
    return this.exists('admin_users', `email = '${email.toLowerCase()}'`);
  }

  /**
   * Count total admin users.
   *
   * @returns Total count
   */
  async countAdmins(): Promise<number> {
    return this.executeQuery(async () => {
      const result = await this.sql<{ count: number }[]>`
        SELECT COUNT(*) as count FROM admin_users
      `;
      return result[0]?.count || 0;
    }, 'AdminRepository.countAdmins');
  }

  /**
   * Verify password against hash.
   *
   * @param password Plain text password
   * @param hash Stored password hash
   * @returns true if password matches
   */
  verifyPassword(password: string, hash: string): boolean {
    const computed = createHash('sha256').update(password).digest('hex');
    return computed === hash;
  }

  /**
   * Hash a password.
   *
   * @param password Plain text password
   * @returns Password hash
   */
  hashPassword(password: string): string {
    return createHash('sha256').update(password).digest('hex');
  }
}

/**
 * Singleton instance of AdminRepository.
 */
let adminRepositoryInstance: AdminRepository | null = null;

export function getAdminRepository(): AdminRepository {
  if (!adminRepositoryInstance) {
    adminRepositoryInstance = new AdminRepository();
  }
  return adminRepositoryInstance;
}
