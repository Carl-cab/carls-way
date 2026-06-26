import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { getTransferProvider } from '@/lib/transfers/router';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const intentId = parseInt(id);
    if (isNaN(intentId)) return NextResponse.json({ error: 'Invalid intent ID' }, { status: 400 });

    const sql = getSql();

    // Verify intent belongs to user and fetch provider_region
    const intentRows = await sql`
      SELECT provider_region, status FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${user.userId}
    `;
    if (!intentRows[0]) return NextResponse.json({ error: 'Transfer intent not found' }, { status: 404 });
    if (intentRows[0].status !== 'draft') {
      return NextResponse.json({ error: `Intent is already in status: ${intentRows[0].status}` }, { status: 409 });
    }

    const region = intentRows[0].provider_region as 'US' | 'CA';
    const provider = getTransferProvider(region);
    const review = await provider.reviewTransfer(intentId, user.userId);

    return NextResponse.json(review);
  } catch (err) {
    console.error('Transfer review error:', err);
    return NextResponse.json({ error: 'Failed to load transfer review' }, { status: 500 });
  }
}
