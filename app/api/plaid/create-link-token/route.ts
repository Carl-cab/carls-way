import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { plaidClient, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from '@/lib/plaid';

export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(user.userId) },
      client_name: 'manna',
      products: PLAID_PRODUCTS,
      country_codes: PLAID_COUNTRY_CODES,
      language: 'en',
    });

    return NextResponse.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('Plaid link token error:', err);
    return NextResponse.json({ error: 'Failed to create link token' }, { status: 500 });
  }
}
