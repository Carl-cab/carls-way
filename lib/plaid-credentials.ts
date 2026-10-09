import { resolvePlaidEnvironment, type PlaidEnvironmentName } from '@/lib/plaid-env';

/**
 * Plaid client ids are 24 hex characters. Production was rejecting
 * PLAID_CLIENT_ID as an empty or badly formed string when the Vercel value
 * was set but wrapped in quotes or padded with whitespace.
 */
const CLIENT_ID_FORMAT = /^[0-9a-f]{24}$/i;
const SURROUNDING_QUOTES = /^(['"])([\s\S]*)\1$/;

export interface PlaidCredentialShape {
  present: boolean;
  length: number;
  matchesClientIdFormat: boolean;
  leadingOrTrailingWhitespace: boolean;
  surroundingQuotes: boolean;
}

export interface PlaidSecretShape {
  present: boolean;
  length: number;
}

export interface PlaidCredentialDiagnostic {
  environment: PlaidEnvironmentName;
  clientId: {
    raw: PlaidCredentialShape;
    cleaned: PlaidCredentialShape;
  };
  secret: {
    raw: PlaidSecretShape;
    cleaned: PlaidSecretShape;
  };
}

/**
 * Trim whitespace and remove one pair of matching surrounding quotes.
 * `" abc "` and `'abc'` both become `abc`. A second pair is left in place.
 * Unset becomes an empty string so the header is still a string.
 */
export function cleanPlaidCredential(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const quoted = trimmed.match(SURROUNDING_QUOTES);
  return (quoted ? quoted[2] : trimmed).trim();
}

function shape(value: string | undefined): PlaidCredentialShape {
  const text = typeof value === 'string' ? value : '';
  return {
    present: text.length > 0,
    length: text.length,
    matchesClientIdFormat: CLIENT_ID_FORMAT.test(text),
    leadingOrTrailingWhitespace: text.length > 0 && text !== text.trim(),
    surroundingQuotes: SURROUNDING_QUOTES.test(text.trim()),
  };
}

function secretShape(value: string | undefined): PlaidSecretShape {
  const text = typeof value === 'string' ? value : '';
  return {
    present: text.length > 0,
    length: text.length,
  };
}

/**
 * Shape of the configured credentials. The returned object has no credential
 * text: booleans, lengths, and the environment name only.
 */
export function plaidCredentialDiagnostic(): PlaidCredentialDiagnostic {
  const rawClientId = process.env.PLAID_CLIENT_ID;
  const rawSecret = process.env.PLAID_SECRET;
  return {
    environment: resolvePlaidEnvironment(),
    clientId: {
      raw: shape(rawClientId),
      cleaned: shape(cleanPlaidCredential(rawClientId)),
    },
    secret: {
      raw: secretShape(rawSecret),
      cleaned: secretShape(cleanPlaidCredential(rawSecret)),
    },
  };
}

let initDiagnosticLogged = false;

/**
 * Logged once when the Plaid client is built, and again on link-token
 * failure. `when` is the only free-form string, and it is one of two
 * fixed labels — never a credential or a slice of one.
 */
export function logPlaidCredentialDiagnostic(when: 'init' | 'link_token_failure'): void {
  if (when === 'init') {
    if (initDiagnosticLogged) return;
    initDiagnosticLogged = true;
  }
  console.info('Plaid credential diagnostic', {
    when,
    ...plaidCredentialDiagnostic(),
  });
}
