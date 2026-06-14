import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const friends = await query(
    `SELECT f.id as friendship_id, f.status, f.created_at as friendship_date,
       u.id, u.name, u.username, u.email, u.avatar_color, u.province,
       CASE WHEN f.user_id = $1 THEN 'outgoing' ELSE 'incoming' END as direction
     FROM friends f
     JOIN users u ON (CASE WHEN f.user_id = $1 THEN f.friend_id ELSE f.user_id END) = u.id
     WHERE f.user_id = $1 OR f.friend_id = $1
     ORDER BY f.created_at DESC`,
    [user.userId]
  );
  return NextResponse.json(friends.rows);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { friendId } = await req.json();
  if (!friendId) return NextResponse.json({ error: 'friendId required' }, { status: 400 });
  if (friendId === user.userId) return NextResponse.json({ error: 'Cannot add yourself' }, { status: 400 });
  const existing = await query(
    `SELECT id FROM friends
     WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [user.userId, friendId]
  );
  if (existing.rows.length > 0) {
    return NextResponse.json({ error: 'Friend request already exists' }, { status: 409 });
  }
  await query(
    'INSERT INTO friends (user_id, friend_id, status) VALUES ($1, $2, $3)',
    [user.userId, friendId, 'accepted']
  );
  return NextResponse.json({ success: true }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { friendId } = await req.json();
  await query(
    `DELETE FROM friends
     WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [user.userId, friendId]
  );
  return NextResponse.json({ success: true });
}
