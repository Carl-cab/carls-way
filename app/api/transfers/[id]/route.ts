import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const intentId = parseInt(id);
    if (isNaN(intentId)) return NextResponse.json({ error: 'Invalid intent ID' }, { status: 400 });

    const sql = getSql();
    const transfers = await sql`
      SELECT id, type, amount, currency, status,
             provider_region, provider_name, execution_mode,
             provider_reference_id, failure_reason,
             bank_account_id, consent_confirmed_at, idempotency_key,
             created_at, updated_at
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${user.userId}
    `;

    if (transfers.length === 0) {
      return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    }

    return NextResponse.json(transfers[0]);
  } catch (err) {
    console.error('Get transfer error:', err);
    return NextResponse.json({ error: 'Failed to fetch transfer' }, { status: 500 });
  }
}
