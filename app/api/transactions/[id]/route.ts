import { NextRequest, NextResponse } from 'next/server';
import getSql from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sql = getSql();
  const { id } = await params;
  const { action } = await req.json();
  if (!['accept', 'decline'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }
  const txRows = await sql`
    SELECT * FROM transactions WHERE id = ${Number(id)} AND type = 'request' AND status = 'pending'
  `;
  const transaction = txRows[0] as {
    id: number; sender_id: number; receiver_id: number; amount: number;
  } | undefined;
  if (!transaction) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }
  if (transaction.sender_id !== user.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (action === 'accept') {
    const payerRows = await sql`SELECT balance FROM users WHERE id = ${user.userId}`;
    const payer = payerRows[0] as { balance: number };
    if (payer.balance < transaction.amount) {
      return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
    }
    await sql`UPDATE users SET balance = balance - ${transaction.amount} WHERE id = ${user.userId}`;
    await sql`UPDATE users SET balance = balance + ${transaction.amount} WHERE id = ${transaction.receiver_id}`;
    await sql`UPDATE transactions SET status = 'completed', type = 'payment' WHERE id = ${transaction.id}`;
  } else {
    await sql`UPDATE transactions SET status = 'declined' WHERE id = ${transaction.id}`;
  }
  return NextResponse.json({ success: true });
}
