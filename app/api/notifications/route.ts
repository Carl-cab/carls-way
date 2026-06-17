import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();
    const notifications = await sql`
      SELECT id, type, title, message, related_entity_type, related_entity_id, read_at, created_at
      FROM notifications
      WHERE user_id = ${user.userId}
      ORDER BY created_at DESC
      LIMIT 50
    `;
    return NextResponse.json(notifications);
  } catch (err) {
    console.error('Notifications GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
