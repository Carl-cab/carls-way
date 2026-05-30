import { NextRequest, NextResponse } from 'next/server';
import getDb from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q') || '';

  const db = getDb();
  const users = db.prepare(
    `SELECT id, name, username, email, avatar_color, province FROM users 
     WHERE id != ? AND (name LIKE ? OR username LIKE ? OR email LIKE ?)
     LIMIT 20`
  ).all(user.userId, `%${q}%`, `%${q}%`, `%${q}%`);

  return NextResponse.json(users);
}
