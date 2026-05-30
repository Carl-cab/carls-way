import { NextRequest, NextResponse } from 'next/server';
import getDb from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const { action } = await req.json();

  if (!['accept', 'decline'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const db = getDb();
  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ? AND type = \'request\' AND status = \'pending\'').get(Number(id)) as {
    id: number; sender_id: number; receiver_id: number; amount: number;
  } | undefined;

  if (!transaction) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }

  // sender_id is the one who OWES money (they were requested from)
  // receiver_id is the one who REQUESTED money
  if (transaction.sender_id !== user.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (action === 'accept') {
    const payer = db.prepare('SELECT balance FROM users WHERE id = ?').get(user.userId) as { balance: number };
    if (payer.balance < transaction.amount) {
      return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
    }
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(transaction.amount, user.userId);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(transaction.amount, transaction.receiver_id);
    db.prepare('UPDATE transactions SET status = \'completed\', type = \'payment\' WHERE id = ?').run(transaction.id);
  } else {
    db.prepare('UPDATE transactions SET status = \'declined\' WHERE id = ?').run(transaction.id);
  }

  return NextResponse.json({ success: true });
}
