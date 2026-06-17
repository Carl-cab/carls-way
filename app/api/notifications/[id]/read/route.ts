import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const notifId = parseInt(id, 10);
    if (isNaN(notifId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    const sql = getSql();
    const result = await sql`
      UPDATE notifications
      SET read_at = NOW()
      WHERE id = ${notifId} AND user_id = ${user.userId} AND read_at IS NULL
    `;
    if (result.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Notification read error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
