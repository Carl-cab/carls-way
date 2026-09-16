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

  // An empty term used to build '%%', which matches every row — so the endpoint
  // handed out an arbitrary page of the user table to any signed-in caller.
  // Directory lookup exists to find someone you already know; it needs a name.
  if (term.trim().length < 2) {
    return NextResponse.json([]);
  }

  const q = `%${term.trim()}%`;

  // `email` is deliberately absent from both the projection and the predicate.
  // It used to be selected AND matched with ILIKE, so any authenticated user
  // could harvest the customer email list by iterating substrings. Sending
  // money by username never required exposing addresses.
  const users = await sql`
    SELECT id, name, username, avatar_color, province, country FROM users
    WHERE id != ${user.userId}
      AND (name ILIKE ${q} OR username ILIKE ${q})
    LIMIT 20
  `;
  return NextResponse.json(users);
}
