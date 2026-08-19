/**
 * Narrowing helpers for values caught in a `catch` clause.
 *
 * A caught value is `unknown`: TypeScript cannot know what a thrown value is,
 * and annotating it `any` silently disables checking on every property read
 * that follows. These helpers narrow it explicitly instead, so the compiler
 * keeps verifying the code inside error branches.
 */

/** Whether a caught value is an Error instance. */
export function isError(err: unknown): err is Error {
  return err instanceof Error;
}

/**
 * Message of a caught value, for logging and error responses.
 * Non-Error values are stringified rather than dropped.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Whether a caught value represents an RBAC permission denial.
 *
 * requirePermission throws a ForbiddenError whose message names the missing
 * permission; admin routes map that to HTTP 403. Matching on the message is
 * how these routes already behaved — this helper only makes the check type
 * safe, it does not change which errors are treated as denials.
 */
export function isPermissionDenied(err: unknown): err is Error {
  return err instanceof Error && err.message.includes('Permission denied');
}
