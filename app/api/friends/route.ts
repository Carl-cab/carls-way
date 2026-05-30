import { NextRequest, NextResponse } from 'next/server';
import getDb from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = getDb();
  const friends = db.prepare(`
    SELECT f.id as friendship_id, f.status, f.created_at as friendship_date,
      u.id, u.name, u.username, u.email, u.avatar_color, u.province,
      CASE WHEN f.user_id = ? THEN 'outgoing' ELSE 'incoming' END as direction
    FROM friends f
    JOIN users u ON (CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END) = u.id
    WHERE f.user_id = ? OR f.friend_id = ?
    ORDER BY f.created_at DESC
  `).all(user.userId, user.userId, user.userId, user.userId);

  return NextResponse.json(friends);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { friendId } = await req.json();
  if (!friendId) return NextResponse.json({ error: 'friendId required' }, { status: 400 });
  if (friendId === user.userId) return NextResponse.json({ error: 'Cannot add yourself' }, { status: 400 });

  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  ).get(user.userId, friendId, friendId, user.userId);

  if (existing) {
    return NextResponse.json({ error: 'Friend request already exists' }, { status: 409 });
  }

  db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, \'accepted\')').run(user.userId, friendId);
  return NextResponse.json({ success: true }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { friendId } = await req.json();
  db_delete(user.userId, friendId);
  return NextResponse.json({ success: true });
}

function db_delete(userId: number, friendId: number) {
  const db = getDb();
  db.prepare(
    'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  ).run(userId, friendId, friendId, userId);
}
