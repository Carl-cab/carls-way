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
  // Accept both `q` and `search` — the send page's cross-border FX preview uses `search`.
  const term = searchParams.get('q') ?? searchParams.get('search') ?? '';
  const q = `%${term}%`;
  const users = await sql`
    SELECT id, name, username, email, avatar_color, province, country FROM users
    WHERE id != ${user.userId}
      AND (name ILIKE ${q} OR username ILIKE ${q} OR email ILIKE ${q})
    LIMIT 20
  `;
  return NextResponse.json(users);
}
