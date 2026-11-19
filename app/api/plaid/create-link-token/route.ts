import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { plaidClient, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from '@/lib/plaid';
import { logRedactedError, plaidErrorDetails } from '@/lib/plaid-error';
import { logPlaidCredentialDiagnostic } from '@/lib/plaid-credentials';
import { isCapabilityRestricted, restrictionMessage } from '@/lib/beta-restrictions';

export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Containment gate, BEFORE the Plaid call. In the restricted beta no
    // participant action may reach Plaid: funding and cash-out are both
    // withheld, so a link token has nothing to be used for, and Plaid is
    // configured with the PRODUCTION secret on Preview.
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

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(user.userId) },
      client_name: 'manna',
      products: PLAID_PRODUCTS,
      country_codes: PLAID_COUNTRY_CODES,
      language: 'en',
    });

    return NextResponse.json({ link_token: response.data.link_token });
  } catch (err) {
    logRedactedError('Plaid link token error:', err);
    logPlaidCredentialDiagnostic('link_token_failure');
    return NextResponse.json(
      { error: 'Failed to create link token', code: plaidErrorDetails(err).error_code },
      { status: 500 },
    );
  }
}
