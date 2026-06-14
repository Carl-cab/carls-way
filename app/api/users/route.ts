import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const sql = getSql();
  const { searchParams } = new URL(req.url);
  const q = `%${searchParams.get('q') || ''}%`;
  const users = await sql`
    SELECT id, name, username, email, avatar_color, province FROM users
    WHERE id != ${user.userId}
      AND (name ILIKE ${q} OR username ILIKE ${q} OR email ILIKE ${q})
    LIMIT 20
  `;
  return NextResponse.json(users);
}
