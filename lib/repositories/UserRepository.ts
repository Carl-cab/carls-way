/**
 * User repository for managing user account data.
 *
 * Responsibilities:
 * - Create new user accounts
 * - Query users by various criteria
 * - Update user profiles and KYC status
 * - Track authentication state
 * - No business logic, no authorization decisions
 */

import { BaseRepository } from './BaseRepository';
import type { User, CreateUserInput, PaginatedResult } from './types';
import { NotFoundError } from './types';

export class UserRepository extends BaseRepository {
  /**
   * Find a user by ID.
   *
   * @param id User ID
   * @returns User or null if not found
   */
  async findById(id: number): Promise<User | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<User[]>`
        SELECT *
        FROM users
        WHERE id = ${id}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'UserRepository.findById');
  }

  /**
   * Find a user by email.
   *
   * @param email Email address
   * @returns User or null if not found
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<User[]>`
        SELECT *
        FROM users
        WHERE email = ${email.toLowerCase()}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'UserRepository.findByEmail');
  }

  /**
   * Find a user by username.
   *
   * @param username Username (case-insensitive)
   * @returns User or null if not found
   */
  async findByUsername(username: string): Promise<User | null> {
    return this.executeQuery(async () => {
      const result = await this.sql<User[]>`
        SELECT *
        FROM users
        WHERE username = ${username.toLowerCase()}
        LIMIT 1
      `;
      return result[0] || null;
    }, 'UserRepository.findByUsername');
  }

  /**
   * Search users by name or username.
   *
   * @param query Search query
   * @param limit Maximum results
   * @returns Array of matching users
   */
  async search(query: string, limit: number = 20): Promise<User[]> {
    return this.executeQuery(async () => {
      const searchPattern = `%${query.toLowerCase()}%`;
      const result = await this.sql<User[]>`
        SELECT id, name, username, email, avatar_color, province
        FROM users
        WHERE LOWER(name) ILIKE ${searchPattern}
          OR LOWER(username) ILIKE ${searchPattern}
          OR LOWER(email) ILIKE ${searchPattern}
        LIMIT ${Math.min(limit, 500)}
      `;
      return result;
    }, 'UserRepository.search');
  }

  /**
   * Get all users with pagination.
   *
   * @param page Page number (1-indexed)
   * @param limit Items per page
   * @returns Paginated users
   */
  async findAll(
    page: number = 1,
    limit: number = 50
  ): Promise<PaginatedResult<User>> {
    return this.executeQuery(async () => {
      const { page: validPage, limit: validLimit } = this.validatePagination(page, limit);
      const offset = this.calculateOffset(validPage, validLimit);

      const [users, countResult] = await Promise.all([
        this.sql<User[]>`
          SELECT *
          FROM users
          ORDER BY created_at DESC
          LIMIT ${validLimit}
          OFFSET ${offset}
        `,
        this.sql<{ count: number }[]>`
          SELECT COUNT(*) as count FROM users
        `,
      ]);

      const total = countResult[0]?.count || 0;

      return {
        data: users,
        meta: {
          page: validPage,
          limit: validLimit,
          total,
          hasMore: offset + validLimit < total,
        },
      };
    }, 'UserRepository.findAll');
  }

  /**
   * Get users by country.
   *
   * @param country Country code (CA or US)
   * @param limit Maximum results
   * @returns Array of users
   */
  async findByCountry(country: 'CA' | 'US', limit: number = 100): Promise<User[]> {
    return this.executeQuery(async () => {
      return this.sql<User[]>`
        SELECT *
        FROM users
        WHERE country = ${country}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'UserRepository.findByCountry');
  }

  /**
   * Get users with specific KYC status.
   *
   * @param status KYC status
   * @param limit Maximum results
   * @returns Array of users
   */
  async findByKycStatus(
    status: 'pending' | 'verified' | 'rejected',
    limit: number = 100
  ): Promise<User[]> {
    return this.executeQuery(async () => {
      return this.sql<User[]>`
        SELECT *
        FROM users
        WHERE kyc_status = ${status}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 1000)}
      `;
    }, 'UserRepository.findByKycStatus');
  }

  /**
   * Create a new user.
   *
   * @param input User creation data
   * @returns Created user
   * @throws DuplicateKeyError if email or username already exists
   */
  async create(input: CreateUserInput): Promise<User> {
    return this.executeQuery(async () => {
      const result = await this.sql<User[]>`
        INSERT INTO users (
          name, username, email, password_hash, country, province, phone,
          balance_cad, balance_usd, avatar_color, kyc_status
        )
        VALUES (
          ${input.name},
          ${input.username.toLowerCase()},
          ${input.email.toLowerCase()},
          ${input.password_hash},
          ${input.country},
          ${input.province || null},
          ${input.phone || null},
          ${input.balance_cad || 100},
          ${input.balance_usd || 100},
          ${['red', 'blue', 'green', 'purple', 'orange'][Math.floor(Math.random() * 5)]},
          'pending'
        )
        RETURNING *
      `;

      this.assertFound(result[0], 'created user');
      return result[0];
    }, 'UserRepository.create');
  }

  /**
   * Update a user's profile information.
   *
   * @param id User ID
   * @param updates Partial user data
   * @returns Updated user
   */
  async updateProfile(id: number, updates: Partial<User>): Promise<User> {
    return this.executeQuery(async () => {
      const allowedFields = ['name', 'phone', 'avatar_color', 'province'];
      const fields: string[] = [];
      const values: any[] = [];

      for (const key of allowedFields) {
        if (key in updates && updates[key as keyof User] !== undefined) {
          fields.push(key);
          values.push(updates[key as keyof User]);
        }
      }

      if (fields.length === 0) {
        const existing = await this.findById(id);
        this.assertFound(existing, `user ${id}`);
        return existing;
      }

      values.push(id);

      const placeholders = fields.map((_, i) => `${fields[i]} = $${i + 1}`).join(', ');
      const query = `UPDATE users SET ${placeholders} WHERE id = $${fields.length + 1} RETURNING *`;

      const result = await this.sql.unsafe<User[]>(query, values as any);
      this.assertFound(result[0], `user ${id}`);
      return result[0];
    }, 'UserRepository.updateProfile');
  }

  /**
   * Update KYC (Know Your Customer) status.
   *
   * @param id User ID
   * @param status New KYC status
   * @param provider KYC provider (Stripe, etc.)
   * @param sessionId KYC session ID
   * @param rejectionReason Reason for rejection (if applicable)
   * @returns Updated user
   */
  async updateKycStatus(
    id: number,
    status: 'pending' | 'verified' | 'rejected',
    provider?: string,
    sessionId?: string,
    rejectionReason?: string
  ): Promise<User> {
    return this.executeQuery(async () => {
      const kycVerifiedAt = status === 'verified' ? new Date().toISOString() : null;

      const result = await this.sql<User[]>`
        UPDATE users
        SET kyc_status = ${status},
            kyc_provider = ${provider || null},
            kyc_session_id = ${sessionId || null},
            kyc_verified_at = ${kycVerifiedAt},
            kyc_rejection_reason = ${rejectionReason || null}
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `user ${id}`);
      return result[0];
    }, 'UserRepository.updateKycStatus');
  }

  /**
   * Update authentication state (failed attempts, lockout).
   *
   * @param id User ID
   * @param failedAttempts New failed attempt count
   * @param lockedUntil Lockout timestamp (null to unlock)
   * @returns Updated user
   */
  async updateAuthState(
    id: number,
    failedAttempts?: number,
    lockedUntil?: string | null
  ): Promise<User> {
    return this.executeQuery(async () => {
      let query = 'UPDATE users SET ';
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
        const existing = await this.findById(id);
        this.assertFound(existing, `user ${id}`);
        return existing;
      }

      // Remove trailing comma and space
      query = query.slice(0, -2);
      query += ` WHERE id = $${updates.length + 1} RETURNING *`;
      updates.push(id);

      const result = await this.sql.unsafe<User[]>(query, updates as any);
      this.assertFound(result[0], `user ${id}`);
      return result[0];
    }, 'UserRepository.updateAuthState');
  }

  /**
   * Update last login timestamp.
   *
   * @param id User ID
   * @returns Updated user
   */
  async updateLastLogin(id: number): Promise<User> {
    return this.executeQuery(async () => {
      const result = await this.sql<User[]>`
        UPDATE users
        SET last_login_at = NOW(), failed_login_attempts = 0, locked_until = NULL
        WHERE id = ${id}
        RETURNING *
      `;

      this.assertFound(result[0], `user ${id}`);
      return result[0];
    }, 'UserRepository.updateLastLogin');
  }

  /**
   * Update user balances (CAD and USD).
   *
   * @param id User ID
   * @param balanceCad New CAD balance
   * @param balanceUsd New USD balance
   * @returns Updated user
   */
  async updateBalances(
    id: number,
    balanceCad?: number,
    balanceUsd?: number
  ): Promise<User> {
    return this.executeQuery(async () => {
      let query = 'UPDATE users SET ';
      const updates: any[] = [];

      if (balanceCad !== undefined) {
        query += `balance_cad = $${updates.length + 1}, `;
        updates.push(balanceCad);
      }

      if (balanceUsd !== undefined) {
        query += `balance_usd = $${updates.length + 1}, `;
        updates.push(balanceUsd);
      }

      if (updates.length === 0) {
        const existing = await this.findById(id);
        this.assertFound(existing, `user ${id}`);
        return existing;
      }

      query = query.slice(0, -2);
      query += ` WHERE id = $${updates.length + 1} RETURNING *`;
      updates.push(id);

      const result = await this.sql.unsafe<User[]>(query, updates as any);
      this.assertFound(result[0], `user ${id}`);
      return result[0];
    }, 'UserRepository.updateBalances');
  }

  /**
   * Check if an email is already registered.
   *
   * @param email Email to check
   * @returns true if email exists, false otherwise
   */
  async emailExists(email: string): Promise<boolean> {
    return this.exists('users', `email = '${email.toLowerCase()}'`);
  }

  /**
   * Check if a username is already taken.
   *
   * @param username Username to check
   * @returns true if username exists, false otherwise
   */
  async usernameExists(username: string): Promise<boolean> {
    return this.exists('users', `username = '${username.toLowerCase()}'`);
  }

  /**
   * Count total users.
   *
   * @returns Total user count
   */
  async countTotal(): Promise<number> {
    return this.executeQuery(async () => {
      const result = await this.sql<{ count: number }[]>`
        SELECT COUNT(*) as count FROM users
      `;
      return result[0]?.count || 0;
    }, 'UserRepository.countTotal');
  }

  /**
   * Count users by KYC status.
   *
   * @returns Map of status to count
   */
  async countByKycStatus(): Promise<{
    pending: number;
    verified: number;
    rejected: number;
  }> {
    return this.executeQuery(async () => {
      const result = await this.sql<
        { kyc_status: string; count: number }[]
      >`
        SELECT kyc_status, COUNT(*) as count
        FROM users
        GROUP BY kyc_status
      `;

      const counts = {
        pending: 0,
        verified: 0,
        rejected: 0,
      };

      for (const row of result) {
        if (row.kyc_status in counts) {
          counts[row.kyc_status as keyof typeof counts] = row.count;
        }
      }

      return counts;
    }, 'UserRepository.countByKycStatus');
  }
}

/**
 * Singleton instance of UserRepository.
 */
let userRepositoryInstance: UserRepository | null = null;

export function getUserRepository(): UserRepository {
  if (!userRepositoryInstance) {
    userRepositoryInstance = new UserRepository();
  }
  return userRepositoryInstance;
}
