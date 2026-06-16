import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const friendshipId = parseInt(id, 10);
  if (isNaN(friendshipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const sql = getSql();

  // Only the recipient (friend_id) can accept
  const rows = await sql`
    SELECT id FROM friends
    WHERE id = ${friendshipId} AND friend_id = ${user.userId} AND status = 'pending'
  `;
  if (!rows[0]) return NextResponse.json({ error: 'Request not found or you are not the recipient' }, { status: 404 });

  await sql`
    UPDATE friends SET status = 'accepted', updated_at = NOW()
    WHERE id = ${friendshipId}
  `;
  return NextResponse.json({ success: true });
}
