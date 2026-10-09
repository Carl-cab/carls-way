import { Configuration, PlaidApi, Products, CountryCode } from 'plaid';
import { getSql } from '@/lib/db';
import { decryptToken } from '@/lib/encryption';
import { plaidApiBasePath, resolvePlaidEnvironment } from '@/lib/plaid-env';

export const RELINK_REQUIRED_MESSAGE =
  'Please re-link your bank account before using transfers. Your account needs to be reconnected for security reasons.';

/**
 * Fetches a bank account's Plaid access token for the given user and decrypts it.
 *
 * Returns the plaintext access token ONLY when is_token_encrypted = true.
 * If the row has a legacy plaintext token (is_token_encrypted = false), throws
 * an error with a user-safe message so callers can return it to the client.
 *
 * Never returns the token to the browser — callers must use it only for
 * server-side Plaid SDK calls.
 */
export async function requireEncryptedBankToken(
  userId: number,
  bankAccountId: number
): Promise<string> {
  const sql = getSql();
  const rows = await sql`
    SELECT plaid_access_token_enc, is_token_encrypted
    FROM bank_accounts
    WHERE id = ${bankAccountId} AND user_id = ${userId} AND is_active = true
  `;

  if (!rows[0]) {
    throw new Error('Bank account not found');
  }

  const { plaid_access_token_enc, is_token_encrypted } = rows[0] as {
    plaid_access_token_enc: string;
    is_token_encrypted: boolean;
  };

  if (!is_token_encrypted) {
    throw new Error(RELINK_REQUIRED_MESSAGE);
  }

  return decryptToken(plaid_access_token_enc);
}

/**
 * Built on first use, and rebuilt if PLAID_ENV changes, so the host always
 * comes from resolvePlaidEnvironment() rather than from a default captured
 * at import time.
 */
let cachedClient: { env: string; client: PlaidApi } | null = null;

export function getPlaidClient(): PlaidApi {
  const env = resolvePlaidEnvironment();
  if (!cachedClient || cachedClient.env !== env) {
    cachedClient = {
      env,
      client: new PlaidApi(
        new Configuration({
          basePath: plaidApiBasePath(),
          baseOptions: {
            headers: {
              'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '',
              'PLAID-SECRET': process.env.PLAID_SECRET || '',
            },
          },
        }),
      ),
    };
  }
  return cachedClient.client;
}

export const plaidClient: PlaidApi = new Proxy({} as PlaidApi, {
  get(_target, property) {
    const client = getPlaidClient() as unknown as Record<PropertyKey, unknown>;
    const value = client[property];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(client)
      : value;
  },
});

export const PLAID_PRODUCTS: Products[] = [Products.Auth, Products.Transactions];
export const PLAID_COUNTRY_CODES: CountryCode[] = [CountryCode.Us, CountryCode.Ca];
