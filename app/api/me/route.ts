import { NextResponse } from 'next/server';
import getDb from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const me = db.prepare(
    'SELECT id, name, username, email, phone, balance, province, country, avatar_color, created_at FROM users WHERE id = ?'
  ).get(user.userId);

  if (!me) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json(me);
}
