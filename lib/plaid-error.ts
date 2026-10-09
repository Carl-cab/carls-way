/**
 * Safe fields from a Plaid (Axios) error.
 *
 * The Plaid SDK throws Axios errors. Those objects carry the outgoing request
 * on `config`, including the `PLAID-CLIENT-ID` and `PLAID-SECRET` headers, and
 * Node's console inspector prints every own property. Logging the caught value
 * therefore writes both credentials into the platform logs.
 *
 * Callers log `redactedErrorLog(err)` and nothing else from the catch. The
 * result is a fresh plain object: no config, no headers, no request body, and
 * not the original error.
 */

export interface PlaidErrorDetails {
  error_type: string | null;
  error_code: string | null;
  error_message: string | null;
  display_message: string | null;
  request_id: string | null;
  status: number | null;
}

export interface ProviderErrorDetails {
  message: string | null;
  type: string | null;
  code: string | null;
  request_id: string | null;
  status: number | null;
}

export type RedactedErrorLog = PlaidErrorDetails | ProviderErrorDetails;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function isAxiosError(err: unknown): boolean {
  const record = asRecord(err);
  if (!record) return false;
  if (record.isAxiosError === true) return true;
  // Duck-type the shape the Plaid SDK actually throws, in case `isAxiosError`
  // was stripped. Both `response` and `config` are set on Axios failures;
  // requiring both avoids treating an unrelated `{ response }` as one.
  return asRecord(record.response) !== null && asRecord(record.config) !== null;
}

function plaidBody(err: unknown): Record<string, unknown> | null {
  const response = asRecord(asRecord(err)?.response);
  const data = asRecord(response?.data);
  if (!data) return null;
  const nested = asRecord(data.error);
  if (
    nested &&
    (typeof nested.error_code === 'string' ||
      typeof nested.error_type === 'string' ||
      typeof nested.error_message === 'string')
  ) {
    return nested;
  }
  return data;
}

export function plaidErrorDetails(err: unknown): PlaidErrorDetails {
  const body = plaidBody(err);
  const response = asRecord(asRecord(err)?.response);
  return {
    error_type: asString(body?.error_type),
    error_code: asString(body?.error_code),
    error_message: asString(body?.error_message),
    display_message: asString(body?.display_message),
    request_id: asString(body?.request_id),
    status: asStatus(response?.status),
  };
}

function isStripeError(err: unknown): boolean {
  if (isAxiosError(err)) return false;
  if (err instanceof Error && err.name.startsWith('Stripe')) return true;
  const record = asRecord(err);
  if (!record) return false;
  const hasSdkPayload =
    record.raw !== undefined || record.headers !== undefined || record.payload !== undefined;
  return (
    hasSdkPayload &&
    (typeof record.type === 'string' ||
      typeof record.requestId === 'string' ||
      typeof record.statusCode === 'number' ||
      typeof record.code === 'string')
  );
}

function providerErrorDetails(err: unknown): ProviderErrorDetails {
  const record = asRecord(err);
  if (!isStripeError(err) || !record) {
    return {
      message: err instanceof Error ? err.message : null,
      type: null,
      code: null,
      request_id: null,
      status: null,
    };
  }
  return {
    message: asString(record.message) ?? (err instanceof Error ? err.message : null),
    type: asString(record.type),
    code: asString(record.code),
    request_id: asString(record.requestId),
    status: asStatus(record.statusCode),
  };
}

/**
 * The only object that may be passed to a logger from a provider catch.
 * Plaid/Axios errors contribute Plaid's public error fields and the HTTP
 * status. Stripe errors contribute type, code, message, request id, and
 * status. Anything else contributes `Error.message` alone.
 */
export function redactedErrorLog(err: unknown): RedactedErrorLog {
  if (isAxiosError(err)) return plaidErrorDetails(err);
  return providerErrorDetails(err);
}

/** A single string safe to persist. Never the raw error, its config, or its headers. */
export function redactedErrorMessage(err: unknown): string {
  const logged = redactedErrorLog(err);
  if ('error_code' in logged) {
    return logged.error_message ?? logged.error_code ?? 'provider request failed';
  }
  return logged.message ?? 'request failed';
}

export function logRedactedError(
  label: string,
  err: unknown,
  level: 'error' | 'warn' = 'error',
): void {
  const details = redactedErrorLog(err);
  if (level === 'warn') console.warn(label, details);
  else console.error(label, details);
}
