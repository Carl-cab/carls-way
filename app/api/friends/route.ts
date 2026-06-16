import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sql = getSql();
  const friends = await sql`
    SELECT f.id as friendship_id, f.status, f.requested_by, f.created_at as friendship_date,
      u.id, u.name, u.username, u.email, u.avatar_color, u.province,
      CASE WHEN f.user_id = ${user.userId} THEN 'outgoing' ELSE 'incoming' END as direction
    FROM friends f
    JOIN users u ON (CASE WHEN f.user_id = ${user.userId} THEN f.friend_id ELSE f.user_id END) = u.id
    WHERE f.user_id = ${user.userId} OR f.friend_id = ${user.userId}
    ORDER BY f.created_at DESC
  `;
  return NextResponse.json(friends);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { friendId } = await req.json() as { friendId: number };
  if (!friendId) return NextResponse.json({ error: 'friendId required' }, { status: 400 });
  if (friendId === user.userId) return NextResponse.json({ error: 'Cannot send a friend request to yourself' }, { status: 400 });
  const sql = getSql();
  const target = await sql`SELECT id FROM users WHERE id = ${friendId}`;
  if (!target[0]) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  const existing = await sql`
    SELECT id FROM friends
    WHERE (user_id = ${user.userId} AND friend_id = ${friendId})
       OR (user_id = ${friendId} AND friend_id = ${user.userId})
  `;
  if (existing.length > 0) {
    return NextResponse.json({ error: 'Friend request already exists or you are already friends' }, { status: 409 });
  }
  await sql`
    INSERT INTO friends (user_id, friend_id, status, requested_by, updated_at)
    VALUES (${user.userId}, ${friendId}, 'pending', ${user.userId}, NOW())
  `;
  return NextResponse.json({ success: true }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { friendId } = await req.json() as { friendId: number };
  const sql = getSql();
  await sql`
    DELETE FROM friends
    WHERE (user_id = ${user.userId} AND friend_id = ${friendId})
       OR (user_id = ${friendId} AND friend_id = ${user.userId})
  `;
  return NextResponse.json({ success: true });
}
