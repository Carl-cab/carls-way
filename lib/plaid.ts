import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { getSql } from '@/lib/db';
import { decryptToken } from '@/lib/encryption';

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

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID || '';
const PLAID_SECRET = process.env.PLAID_SECRET || '';
const PLAID_ENV = (process.env.PLAID_ENV || 'production') as keyof typeof PlaidEnvironments;

const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(config);

export const PLAID_PRODUCTS: Products[] = [Products.Auth, Products.Transactions];
export const PLAID_COUNTRY_CODES: CountryCode[] = [CountryCode.Us, CountryCode.Ca];
