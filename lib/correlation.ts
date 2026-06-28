/**
 * Correlation ID utilities for request tracing.
 *
 * Correlation IDs enable tracking financial events through their entire lifecycle:
 * API request → settlement orchestration → ledger posting → balance updates → audit logs.
 *
 * A correlation ID is generated once when a request arrives and preserved unchanged
 * through all downstream operations. This enables forensics, auditing, and debugging.
 */

import { randomBytes } from 'crypto';
import type { NextRequest } from 'next/server';

/**
 * Generate a new correlation ID.
 *
 * Format: "corr_" + 32 random hex characters
 * Example: "corr_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
 */
export function generateCorrelationId(): string {
  return `corr_${randomBytes(16).toString('hex')}`;
}

/**
 * Extract correlation ID from HTTP headers or generate new one.
 *
 * Checks for:
 * 1. X-Correlation-ID header (preferred)
 * 2. X-Request-ID header (fallback)
 * 3. traceparent header (W3C standard, extracts trace-id)
 * 4. Generates new if none present
 *
 * @param req - Next.js request object
 * @returns Correlation ID string (always returns a value)
 */
export function extractOrGenerateCorrelationId(req: NextRequest): string {
  const fromHeader = req.headers.get('x-correlation-id');
  if (fromHeader) {
    return sanitizeCorrelationId(fromHeader);
  }

  const fromRequestId = req.headers.get('x-request-id');
  if (fromRequestId) {
    return sanitizeCorrelationId(fromRequestId);
  }

  const fromTraceparent = req.headers.get('traceparent');
  if (fromTraceparent) {
    const parts = fromTraceparent.split('-');
    if (parts.length >= 2) {
      return sanitizeCorrelationId(parts[1]);
    }
  }

  return generateCorrelationId();
}

/**
 * Sanitize correlation ID to prevent injection attacks.
 *
 * Allows: alphanumeric, hyphens, underscores
 * Rejects: quotes, semicolons, newlines, etc.
 * Max length: 255 characters
 *
 * @param id - Raw correlation ID from header
 * @returns Sanitized correlation ID or empty string if invalid
 */
export function sanitizeCorrelationId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 255);
  return sanitized || generateCorrelationId();
}

/**
 * Type-safe context carrier for correlation IDs during request processing.
 *
 * Stored in AsyncLocalStorage or passed as context through function calls.
 * Enables middleware to inject correlation ID without changing function signatures.
 */
export interface RequestContext {
  correlationId: string;
  userId?: number;
  adminId?: number;
  sourceIp?: string;
  userAgent?: string;
  timestamp: Date;
}

/**
 * Create request context with correlation ID.
 *
 * Called by middleware before route handling.
 * Context is passed to all downstream functions that need tracing.
 */
export function createRequestContext(
  correlationId: string,
  userId?: number,
  sourceIp?: string,
  userAgent?: string
): RequestContext {
  return {
    correlationId,
    userId,
    sourceIp,
    userAgent,
    timestamp: new Date(),
  };
}

/**
 * Validate correlation ID format.
 *
 * Ensures correlation ID meets expected format for logging and storage.
 * Used to catch invalid correlation IDs early (e.g., from malicious headers).
 */
export function isValidCorrelationId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  if (id.length > 255) return false;
  return /^[a-zA-Z0-9\-_]+$/.test(id);
}

/**
 * Serialize correlation ID for logging.
 *
 * Ensures correlation ID is safe for JSON logging and database storage.
 * Idempotent: calling multiple times returns the same result.
 */
export function serializeCorrelationId(id: string): string {
  return sanitizeCorrelationId(id) || generateCorrelationId();
}
