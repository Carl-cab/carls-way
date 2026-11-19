import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, auditLog } from '@/lib/auth';
import { plaidClient } from '@/lib/plaid';
import { getSql } from '@/lib/db';
import { encryptToken } from '@/lib/encryption';
import { logRedactedError } from '@/lib/plaid-error';
import { isCapabilityRestricted, restrictionMessage } from '@/lib/beta-restrictions';

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Containment gate, ahead of the body parse and of every Plaid call. This
    // is the route that actually exchanges a token, reads accounts and stores
    // an encrypted access token, so the refusal has to precede all three -- a
    // gate after the exchange would already have talked to the provider.
    if (isCapabilityRestricted('bank_linking')) {
      return NextResponse.json(
        {
          error: restrictionMessage('bank_linking'),
          code: 'BETA_RESTRICTED',
          capability: 'bank_linking',
        },
        { status: 403 },
      );
    }

    const { public_token, metadata } = await req.json();
    if (!public_token) return NextResponse.json({ error: 'public_token required' }, { status: 400 });

    const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;

    const authResponse = await plaidClient.authGet({ access_token: accessToken });
    const accounts = authResponse.data.accounts;
    const institution = metadata?.institution?.name || 'Unknown Bank';

    const sql = getSql();
    const country = metadata?.institution?.country_codes?.[0] === 'CA' ? 'CA' : 'US';
    const currency = country === 'CA' ? 'CAD' : 'USD';

    const encryptedAccessToken = encryptToken(accessToken);

    const savedAccounts = [];
    for (const account of accounts.slice(0, 3)) {
      const result = await sql`
        INSERT INTO bank_accounts (
          user_id, plaid_item_id, plaid_access_token_enc,
          institution_name, account_name, account_type,
          account_mask, currency, country, is_verified, is_token_encrypted
        ) VALUES (
          ${user.userId}, ${itemId}, ${encryptedAccessToken},
          ${institution}, ${account.name}, ${account.type},
          ${account.mask || null}, ${currency}, ${country}, true, true
        )
        ON CONFLICT DO NOTHING
        RETURNING id, account_name, account_type, account_mask, institution_name, currency
      `;
      if (result.length > 0) savedAccounts.push(result[0]);
    }

    await auditLog(user.userId, 'bank_account_linked', { institution, country, accountCount: savedAccounts.length });
    return NextResponse.json({ success: true, accounts: savedAccounts });
  } catch (err) {
    logRedactedError('Plaid exchange token error:', err);
    return NextResponse.json({ error: 'Failed to link bank account' }, { status: 500 });
  }
}
