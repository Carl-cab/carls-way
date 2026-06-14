import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const q = `%${searchParams.get('q') || ''}%`;
  const users = await query(
    `SELECT id, name, username, email, avatar_color, province FROM users
     WHERE id != $1 AND (name ILIKE $2 OR username ILIKE $2 OR email ILIKE $2)
     LIMIT 20`,
    [user.userId, q]
  );
  return NextResponse.json(users.rows);
}
