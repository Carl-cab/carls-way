/**
 * Structured logging with correlation ID support.
 *
 * Provides JSON-formatted logs that include correlation ID,
 * enabling end-to-end request tracing through logs.
 *
 * All logs are JSON objects with:
 * - timestamp (ISO 8601)
 * - level (info, warn, error, debug)
 * - message (human-readable)
 * - correlation_id (for tracing)
 * - additional context (request, user, entity IDs, etc)
 */

import { getRequestContext } from './correlation-middleware';

/**
 * Log level enumeration.
 */
export enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

/**
 * Structured log entry format.
 */
export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlation_id: string;
  user_id?: number;
  admin_id?: number;
  source_ip?: string;
  entity_type?: string;
  entity_id?: string | number;
  action?: string;
  status?: string;
  error?: string;
  stack?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

/**
 * Create structured log entry with correlation ID from current request context.
 *
 * @param message - Human-readable message
 * @param level - Log level
 * @param context - Optional additional context to include
 * @returns Structured log entry ready for JSON output
 */
function createLogEntry(
  message: string,
  level: LogLevel,
  context?: Record<string, unknown>
): StructuredLogEntry {
  const requestContext = getRequestContext();

  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    correlation_id: requestContext?.correlationId || 'unknown',
    user_id: requestContext?.userId,
    admin_id: requestContext?.adminId,
    source_ip: requestContext?.sourceIp,
    ...context,
  };
}

/**
 * Log an informational message.
 *
 * @param message - Human-readable message
 * @param context - Optional metadata to include
 *
 * Example:
 *   logInfo('Transfer intent created', { transfer_id: 'T123', amount: 100 });
 */
export function logInfo(message: string, context?: Record<string, unknown>): void {
  const entry = createLogEntry(message, LogLevel.Info, context);
  console.log(JSON.stringify(entry));
}

/**
 * Log a warning message.
 *
 * @param message - Human-readable message
 * @param context - Optional metadata to include
 *
 * Example:
 *   logWarn('Velocity limit approaching', { user_id: 123, remaining: 500 });
 */
export function logWarn(message: string, context?: Record<string, unknown>): void {
  const entry = createLogEntry(message, LogLevel.Warn, context);
  console.warn(JSON.stringify(entry));
}

/**
 * Log an error message.
 *
 * @param message - Human-readable message
 * @param error - Error object or message
 * @param context - Optional metadata to include
 *
 * Example:
 *   try {
 *     await settlement();
 *   } catch (err) {
 *     logError('Settlement failed', err, { transfer_id: 'T123' });
 *   }
 */
export function logError(
  message: string,
  error?: Error | string,
  context?: Record<string, unknown>
): void {
  const errorObj =
    error instanceof Error
      ? { error: error.message, stack: error.stack }
      : { error: String(error) };

  const entry = createLogEntry(message, LogLevel.Error, {
    ...errorObj,
    ...context,
  });
  console.error(JSON.stringify(entry));
}

/**
 * Log a debug message.
 *
 * @param message - Human-readable message
 * @param context - Optional metadata to include
 *
 * Example:
 *   logDebug('Settlement plan created', { plan: JSON.stringify(plan) });
 */
export function logDebug(message: string, context?: Record<string, unknown>): void {
  const entry = createLogEntry(message, LogLevel.Debug, context);
  console.debug(JSON.stringify(entry));
}

/**
 * Log a database operation with correlation ID.
 *
 * Use this for mutations (INSERT, UPDATE, DELETE) to ensure
 * every database change is traceable to a request.
 *
 * @param operation - Type of operation ('insert', 'update', 'delete')
 * @param table - Table name
 * @param entityId - ID of affected entity
 * @param context - Additional context
 *
 * Example:
 *   logDatabaseMutation('insert', 'ledger_entries', entry.id, {
 *     amount: 100,
 *     currency: 'CAD',
 *   });
 */
export function logDatabaseMutation(
  operation: 'insert' | 'update' | 'delete',
  table: string,
  entityId?: string | number,
  context?: Record<string, unknown>
): void {
  logInfo(`Database ${operation}`, {
    operation,
    table,
    entity_id: entityId,
    ...context,
  });
}

/**
 * Log a request/response pair (for API calls).
 *
 * @param method - HTTP method
 * @param endpoint - API endpoint
 * @param statusCode - HTTP status code
 * @param durationMs - Request duration in milliseconds
 * @param context - Additional context
 *
 * Example:
 *   logRequest('POST', '/api/transfers/intent', 201, 125, {
 *     transfer_id: 'T123',
 *   });
 */
export function logRequest(
  method: string,
  endpoint: string,
  statusCode: number,
  durationMs: number,
  context?: Record<string, unknown>
): void {
  logInfo(`${method} ${endpoint}`, {
    method,
    endpoint,
    status: statusCode,
    duration_ms: durationMs,
    ...context,
  });
}

/**
 * Log a financial operation (settlement, balance update, ledger entry).
 *
 * Used to mark important financial events for auditing and compliance.
 *
 * @param operation - Type of financial operation
 * @param amount - Amount involved
 * @param currency - Currency
 * @param context - Additional context (transfer_id, user_id, etc)
 *
 * Example:
 *   logFinancialOperation('balance_update', 100, 'CAD', {
 *     user_id: 123,
 *     transfer_id: 'T123',
 *     balance_before: 500,
 *     balance_after: 400,
 *   });
 */
export function logFinancialOperation(
  operation: string,
  amount: number,
  currency: string,
  context?: Record<string, unknown>
): void {
  logInfo(`Financial operation: ${operation}`, {
    operation,
    amount,
    currency,
    ...context,
  });
}
