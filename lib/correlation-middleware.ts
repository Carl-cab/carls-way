/**
 * Middleware for correlation ID extraction and injection.
 *
 * Extracts correlation ID from incoming request headers or generates new one.
 * Attaches to response headers so clients can correlate their requests.
 * Stores in AsyncLocalStorage for access throughout request lifecycle.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { NextRequest, NextResponse } from 'next/server';
import {
  extractOrGenerateCorrelationId,
  createRequestContext,
  type RequestContext,
} from './correlation';

/**
 * AsyncLocalStorage for request context (correlation ID, user, etc).
 *
 * Allows any function in the request lifecycle to access the correlation ID
 * without passing it as a parameter through every function call.
 *
 * Usage:
 *   const context = correlationStorage.getStore();
 *   console.log(context?.correlationId);
 */
export const correlationStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Get current request context (correlation ID, user, etc).
 *
 * Returns undefined if called outside a request context.
 * This is the recommended way for functions to access the correlation ID.
 */
export function getRequestContext(): RequestContext | undefined {
  return correlationStorage.getStore();
}

/**
 * Middleware to extract correlation ID from request and attach to response.
 *
 * Should be called early in the request processing pipeline.
 * Attaches X-Correlation-ID header to response so client can correlate.
 *
 * Example usage in route handler:
 *   export async function middleware(req: NextRequest) {
 *     return withCorrelationId(req, async (req: NextRequest) => {
 *       // Your route logic here
 *       const context = getRequestContext();
 *       console.log('Correlation ID:', context?.correlationId);
 *     });
 *   }
 */
export async function withCorrelationId(
  req: NextRequest,
  handler: (req: NextRequest) => Promise<NextResponse>
): Promise<NextResponse> {
  const correlationId = extractOrGenerateCorrelationId(req);
  const sourceIp = req.headers.get('x-forwarded-for') ||
    req.headers.get('x-real-ip') ||
    'unknown';
  const userAgent = req.headers.get('user-agent') || 'unknown';

  const context = createRequestContext(
    correlationId,
    undefined, // userId populated by auth middleware
    sourceIp,
    userAgent
  );

  return correlationStorage.run(context, async () => {
    const response = await handler(req);

    // Attach correlation ID to response headers for client reference
    response.headers.set('X-Correlation-ID', correlationId);

    return response;
  });
}

/**
 * Inject correlation ID into request for downstream processing.
 *
 * Used by route handlers to ensure all downstream operations
 * (settlement, logging, database writes) include the correlation ID.
 */
export function getCorrelationId(): string {
  const context = getRequestContext();
  return context?.correlationId || 'unknown';
}

/**
 * Update request context with user information.
 *
 * Called after user authentication to attach user ID to context.
 * This enables audit logs to know who performed an action.
 *
 * Example usage:
 *   const user = await getAuthUser();
 *   if (user) {
 *     setContextUserId(user.userId);
 *   }
 */
export function setContextUserId(userId: number): void {
  const context = getRequestContext();
  if (context) {
    context.userId = userId;
  }
}

/**
 * Update request context with admin information.
 *
 * Called when an admin action is detected to attach admin ID to context.
 * Enables audit logs to distinguish user actions from admin actions.
 */
export function setContextAdminId(adminId: number): void {
  const context = getRequestContext();
  if (context) {
    context.adminId = adminId;
  }
}
