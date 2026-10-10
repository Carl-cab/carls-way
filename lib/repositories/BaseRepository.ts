/**
 * Base repository class providing common patterns and utilities.
 *
 * This is the foundation for all repositories. It encapsulates:
 * - Database connection management
 * - SQL query building patterns
 * - Error handling
 * - Type mapping
 * - Pagination support
 *
 * Individual repositories extend this class and implement domain-specific queries.
 */

import { getSql } from '@/lib/db';
import { RepositoryError, DuplicateKeyError, NotFoundError, TransactionError } from './types';

/**
 * A composable `sql` fragment, as produced by a tagged template.
 *
 * Used where a helper accepts part of a query: taking this instead of `string`
 * means the values inside are bound parameters and cannot be assembled by
 * concatenation.
 */
type SqlFragment = ReturnType<ReturnType<typeof getSql>>;

/**
 * Base repository class.
 *
 * All repositories should extend this class to ensure consistent:
 * - Error handling
 * - Query patterns
 * - Type safety
 * - Pagination
 */
export abstract class BaseRepository {
  protected readonly sql = getSql();

  /**
   * Handle database errors and convert to repository errors.
   *
   * Converts PostgreSQL error codes to application-level error types.
   * This centralizes error handling across all repositories.
   *
   * @param err Error from postgres.js
   * @param context Additional context for error reporting
   * @returns Thrown RepositoryError with appropriate code
   */
  protected handleError(err: unknown, context: string): never {
    // Repository errors are already classified — re-throw them unchanged so
    // callers keep the specific type (NotFoundError, DuplicateKeyError, ...).
    //
    // This check must come first. RepositoryError carries its own `code` field
    // ('NOT_FOUND', 'DUPLICATE_KEY', ...), so the generic `error.code` branch
    // below would otherwise catch it and re-wrap it as a TransactionError,
    // erasing the original error's identity.
    if (err instanceof RepositoryError) {
      throw err;
    }

    const error = err as Record<string, unknown>;

    // UNIQUE constraint violation (duplicate key)
    if (error.code === '23505') {
      const constraint = (error.constraint as string) || 'unknown';
      throw new DuplicateKeyError(context, constraint);
    }

    // Foreign key violation
    if (error.code === '23503') {
      throw new TransactionError(
        `Foreign key constraint violation in ${context}`,
        { code: error.code, detail: error.detail }
      );
    }

    // Check constraint violation
    if (error.code === '23514') {
      throw new TransactionError(
        `Check constraint violation in ${context}`,
        { code: error.code, detail: error.detail }
      );
    }

    // Generic database error
    if (error.code) {
      throw new TransactionError(
        `Database error in ${context}: ${error.code}`,
        { code: error.code, detail: error.detail, message: error.message }
      );
    }

    // Unknown error
    throw new TransactionError(
      `Unexpected error in ${context}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  /**
   * Validate that a required value is present.
   *
   * @param value Value to check
   * @param fieldName Name of field (for error messages)
   * @throws NotFoundError if value is null or undefined
   */
  protected assertFound<T>(value: T | null | undefined, fieldName: string): asserts value is T {
    if (!value) {
      throw new NotFoundError('Entity', fieldName);
    }
  }

  /**
   * Build a WHERE clause for multiple conditions.
   *
   * Example:
   *   buildWhere({ status: 'active', user_id: 123 })
   *   // Returns: { clause: 'status = $1 AND user_id = $2', params: ['active', 123] }
   *
   * @param conditions Key-value pairs for WHERE clause
   * @returns Object with SQL clause and params ready for template literals
   */
  protected buildWhere(
    conditions: Record<string, unknown>
  ): { clause: string; params: unknown[] } {
    const keys = Object.keys(conditions);
    if (keys.length === 0) {
      return { clause: '1=1', params: [] };
    }

    const params = keys.map((k) => conditions[k]);
    const clause = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');

    return { clause, params };
  }

  /**
   * Calculate offset for pagination.
   *
   * @param page Page number (1-indexed)
   * @param limit Items per page
   * @returns Offset for LIMIT/OFFSET clause
   */
  protected calculateOffset(page: number, limit: number): number {
    return (Math.max(1, page) - 1) * Math.max(1, limit);
  }

  /**
   * Validate page and limit parameters.
   *
   * @param page Requested page (1-indexed)
   * @param limit Requested limit
   * @returns Validated { page, limit }
   */
  protected validatePagination(
    page: number = 1,
    limit: number = 50
  ): { page: number; limit: number } {
    return {
      page: Math.max(1, Math.floor(page)),
      limit: Math.max(1, Math.min(500, Math.floor(limit))), // Max 500 per page
    };
  }

  /**
   * Format a timestamp for database storage.
   *
   * @param date Date object or ISO string
   * @returns ISO string for PostgreSQL
   */
  protected formatTimestamp(date: Date | string = new Date()): string {
    if (typeof date === 'string') {
      return date;
    }
    return date.toISOString();
  }

  /**
   * Parse a database timestamp to Date.
   *
   * @param timestamp ISO string from database
   * @returns Parsed Date object
   */
  protected parseTimestamp(timestamp: string): Date {
    return new Date(timestamp);
  }

  /**
   * Execute a query within error handling context.
   *
   * @param queryFn Function that executes the query
   * @param errorContext Name of operation (for error messages)
   * @returns Query result
   */
  protected async executeQuery<T>(
    queryFn: () => Promise<T>,
    errorContext: string
  ): Promise<T> {
    try {
      return await queryFn();
    } catch (err) {
      this.handleError(err, errorContext);
    }
  }

  /**
   * Check if a record matching `condition` exists.
   *
   * `condition` is a postgres.js fragment, not a string, and that is the whole
   * point. These two helpers took `condition: string` and interpolated it into
   * `sql.unsafe`, so the only way to call them was to build SQL by
   * concatenation — which `UserRepository.emailExists` duly did with a
   * request-shaped value:
   *
   *     this.exists('users', `email = '${email.toLowerCase()}'`)
   *
   * An address of `x' OR '1'='1` made that condition always true, and because
   * `sql.unsafe` executes stacked statements the same hole ran arbitrary SQL,
   * not merely a boolean oracle. A fragment carries its values as bound
   * parameters, so the type now refuses the shape that caused it:
   *
   *     this.exists('users', this.sql`email = ${email.toLowerCase()}`)
   *
   * The table name is an identifier and cannot be a parameter, so it goes
   * through `sql()`, which quotes it.
   *
   * @param tableName Table to check
   * @param condition A `sql` fragment for the WHERE clause
   * @returns true if a record exists, false otherwise
   */
  protected async exists(tableName: string, condition: SqlFragment): Promise<boolean> {
    return this.executeQuery(async () => {
      const result = await this.sql`
        SELECT 1 FROM ${this.sql(tableName)} WHERE ${condition} LIMIT 1
      `;
      return result.length > 0;
    }, `exists in ${tableName}`);
  }

  /**
   * Count records matching `condition`.
   *
   * Takes a `sql` fragment for the same reason as `exists()` above.
   *
   * @param tableName Table to count from
   * @param condition A `sql` fragment for the WHERE clause
   * @returns Count of matching records
   */
  protected async count(tableName: string, condition: SqlFragment): Promise<number> {
    return this.executeQuery(async () => {
      const result = await this.sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM ${this.sql(tableName)} WHERE ${condition}
      `;
      return result[0]?.count ?? 0;
    }, `count in ${tableName}`);
  }
}
