import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { createNotification } from '@/lib/notifications';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const friendshipId = parseInt(id, 10);
  if (isNaN(friendshipId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const sql = getSql();

  // Only the recipient (friend_id) can accept
  const rows = await sql`
    SELECT id, user_id AS requester_id FROM friends
    WHERE id = ${friendshipId} AND friend_id = ${user.userId} AND status = 'pending'
  `;
  if (!rows[0]) return NextResponse.json({ error: 'Request not found or you are not the recipient' }, { status: 404 });

  const requesterId = rows[0].requester_id as number;

  await sql`
    UPDATE friends SET status = 'accepted', updated_at = NOW()
    WHERE id = ${friendshipId}
  `;

  // Notify the original requester that their request was accepted
  await createNotification({
    userId: requesterId,
    type: 'friend_request_accepted',
    title: 'Friend request accepted',
    message: `@${user.username} accepted your friend request.`,
    relatedEntityType: 'friendship',
    relatedEntityId: friendshipId,
  });

  return NextResponse.json({ success: true });
}
