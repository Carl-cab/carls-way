import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();
    await sql`
      UPDATE notifications
      SET read_at = NOW()
      WHERE user_id = ${user.userId} AND read_at IS NULL
    `;
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Read-all notifications error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
