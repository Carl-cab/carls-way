import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { getUserLedgerEntries } from '@/lib/ledger';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const limit = parseInt(req.nextUrl.searchParams.get('limit') || '100');
    const entries = await getUserLedgerEntries(user.userId, Math.min(limit, 500));

    return NextResponse.json({
      userId: user.userId,
      count: entries.length,
      entries,
    });
  } catch (err) {
    console.error('Ledger GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
