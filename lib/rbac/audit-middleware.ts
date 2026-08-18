/**
 * Audit middleware for admin routes.
 *
 * Automatically logs all admin actions before they execute.
 * Works in conjunction with RBAC middleware.
 *
 * Usage:
 *   withAuditLog(req, handler, {
 *     action: 'transfer_retry',
 *     resourceType: 'transfer_intent',
 *   })
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminContext } from './admin-middleware';
import { getAuditLogService, AuditEventBuilder } from './AuditLogService';

export interface AuditLogOptions {
  action: string; // e.g., 'transfer_retry', 'admin_created'
  resourceType: string; // e.g., 'transfer_intent', 'admin_user'
  resourceId?: string | number | (() => Promise<string>);
  changes?: Record<string, any> | (() => Promise<Record<string, any>>);
  extractResourceId?: (body: any) => string | undefined;
}

/**
 * Wrap a route handler to automatically log audit events.
 *
 * Captures:
 * - Request start/end time
 * - Admin context (user, IP, user-agent, correlation ID)
 * - Success/failure status
 * - Error messages on failure
 * - Request duration
 *
 * @param req NextRequest
 * @param handler Route handler to wrap
 * @param options Audit log configuration
 * @returns Response
 */
export async function withAuditLog(
  req: NextRequest,
  handler: (req: NextRequest) => Promise<NextResponse>,
  options: AuditLogOptions
): Promise<NextResponse> {
  const context = getAdminContext();
  const service = getAuditLogService();
  const startTime = Date.now();

  if (!context) {
    // Should not happen if withAdminAuth is applied first
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Extract resource ID from request body if needed
    let resourceId = options.resourceId;
    let changes = options.changes;

    if (options.extractResourceId && req.method !== 'GET') {
      try {
        const body = await req.clone().json();
        resourceId = options.extractResourceId(body) || resourceId;
      } catch {
        // Body may not be JSON or readable
      }
    }

    // Execute handler
    const response = await handler(req);
    const durationMs = Date.now() - startTime;

    // Log successful action
    const event = new AuditEventBuilder()
      .withAdminUserId(context.adminUser.id)
      .withSessionId(context.sessionId)
      .withAction(options.action)
      .withResourceType(options.resourceType)
      .withRole(context.adminUser.role);

    if (resourceId) {
      const rid = typeof resourceId === 'function' ? await resourceId() : String(resourceId);
      event.withResourceId(rid);
    }

    if (changes) {
      const c = typeof changes === 'function' ? await changes() : changes;
      event.withChanges(c);
    }

    if (context.correlationId) {
      event.withCorrelationId(context.correlationId);
    }

    if (context.sourceIp) {
      event.withIpAddress(context.sourceIp);
    }

    if (context.userAgent) {
      event.withUserAgent(context.userAgent);
    }

    event.success().withRequestDuration(durationMs);

    await service.createAuditLogFromBuilder(event);

    return response;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Log failed action
    const event = new AuditEventBuilder()
      .withAdminUserId(context.adminUser.id)
      .withSessionId(context.sessionId)
      .withAction(options.action)
      .withResourceType(options.resourceType)
      .withRole(context.adminUser.role)
      .failed(errorMessage);

    if (options.resourceId && typeof options.resourceId !== 'function') {
      event.withResourceId(String(options.resourceId));
    }

    if (context.correlationId) {
      event.withCorrelationId(context.correlationId);
    }

    if (context.sourceIp) {
      event.withIpAddress(context.sourceIp);
    }

    if (context.userAgent) {
      event.withUserAgent(context.userAgent);
    }

    event.withRequestDuration(durationMs);

    try {
      await service.createAuditLogFromBuilder(event);
    } catch (auditErr) {
      console.error('Failed to log audit event:', auditErr);
      // Don't let audit failure prevent response
    }

    // Re-throw original error
    throw err;
  }
}

/**
 * Decorator factory for automatic audit logging on async functions.
 *
 * Usage:
 *   @AuditableAction('transfer_retry', 'transfer_intent')
 *   async myFunction() { ... }
 */
export function AuditableAction(action: string, resourceType: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const context = getAdminContext();
      if (!context) {
        return originalMethod.apply(this, args);
      }

      const service = getAuditLogService();
      const startTime = Date.now();

      try {
        const result = await originalMethod.apply(this, args);
        const durationMs = Date.now() - startTime;

        const event = new AuditEventBuilder()
          .withAdminUserId(context.adminUser.id)
          .withSessionId(context.sessionId)
          .withAction(action)
          .withResourceType(resourceType)
          .withRole(context.adminUser.role)
          .success()
          .withRequestDuration(durationMs);

        if (context.correlationId) {
          event.withCorrelationId(context.correlationId);
        }

        if (context.sourceIp) {
          event.withIpAddress(context.sourceIp);
        }

        if (context.userAgent) {
          event.withUserAgent(context.userAgent);
        }

        await service.createAuditLogFromBuilder(event);

        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errorMessage = err instanceof Error ? err.message : String(err);

        const event = new AuditEventBuilder()
          .withAdminUserId(context.adminUser.id)
          .withSessionId(context.sessionId)
          .withAction(action)
          .withResourceType(resourceType)
          .withRole(context.adminUser.role)
          .failed(errorMessage)
          .withRequestDuration(durationMs);

        if (context.correlationId) {
          event.withCorrelationId(context.correlationId);
        }

        if (context.sourceIp) {
          event.withIpAddress(context.sourceIp);
        }

        if (context.userAgent) {
          event.withUserAgent(context.userAgent);
        }

        try {
          await service.createAuditLogFromBuilder(event);
        } catch (auditErr) {
          console.error('Failed to log audit event:', auditErr);
        }

        throw err;
      }
    };

    return descriptor;
  };
}

/**
 * Log audit event manually (for operations not covered by middleware).
 *
 * @param action Action name
 * @param resourceType Resource type
 * @param resourceId Resource ID
 * @param changes State changes
 * @param status Success or failure
 * @param errorMessage Error message if failed
 */
export async function logAuditEvent(
  action: string,
  resourceType: string,
  resourceId?: string | number,
  changes?: Record<string, any>,
  status: 'success' | 'failed' = 'success',
  errorMessage?: string
): Promise<void> {
  const context = getAdminContext();
  if (!context) {
    console.warn('No admin context available for audit logging');
    return;
  }

  const service = getAuditLogService();

  const event = new AuditEventBuilder()
    .withAdminUserId(context.adminUser.id)
    .withSessionId(context.sessionId)
    .withAction(action)
    .withResourceType(resourceType)
    .withRole(context.adminUser.role);

  if (resourceId) {
    event.withResourceId(resourceId);
  }

  if (changes) {
    event.withChanges(changes);
  }

  if (context.correlationId) {
    event.withCorrelationId(context.correlationId);
  }

  if (context.sourceIp) {
    event.withIpAddress(context.sourceIp);
  }

  if (context.userAgent) {
    event.withUserAgent(context.userAgent);
  }

  if (status === 'failed' && errorMessage) {
    event.failed(errorMessage);
  } else {
    event.success();
  }

  try {
    await service.createAuditLogFromBuilder(event);
  } catch (err) {
    console.error('Failed to create audit log:', err);
  }
}
