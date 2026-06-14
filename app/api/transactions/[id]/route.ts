import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
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
  const txRows = await query(
    "SELECT * FROM transactions WHERE id = $1 AND type = 'request' AND status = 'pending'",
    [Number(id)]
  );
  const transaction = txRows.rows[0] as {
    id: number; sender_id: number; receiver_id: number; amount: number;
  } | undefined;
  if (!transaction) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }
  if (transaction.sender_id !== user.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (action === 'accept') {
    const payerRows = await query('SELECT balance FROM users WHERE id = $1', [user.userId]);
    const payer = payerRows.rows[0] as { balance: number };
    if (payer.balance < transaction.amount) {
      return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
    }
    await query('UPDATE users SET balance = balance - $1 WHERE id = $2', [transaction.amount, user.userId]);
    await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [transaction.amount, transaction.receiver_id]);
    await query("UPDATE transactions SET status = 'completed', type = 'payment' WHERE id = $1", [transaction.id]);
  } else {
    await query("UPDATE transactions SET status = 'declined' WHERE id = $1", [transaction.id]);
  }
  return NextResponse.json({ success: true });
}
