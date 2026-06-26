import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();
    const transfers = await sql`
      SELECT id, type, amount, currency, status,
             provider_region, provider_name, execution_mode,
             provider_reference_id, failure_reason,
             bank_account_id, consent_confirmed_at, idempotency_key,
             created_at, updated_at
      FROM transfer_intents
      WHERE user_id = ${user.userId}
      ORDER BY created_at DESC
      LIMIT 50
    `;

    return NextResponse.json(transfers);
  } catch (err) {
    console.error('Get transfers error:', err);
    return NextResponse.json({ error: 'Failed to fetch transfers' }, { status: 500 });
  }
}
