import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

const TX_SELECT = `
  SELECT t.id, t.amount, t.currency, t.note, t.type, t.status, t.privacy, t.created_at,
    s.name as sender_name, s.username as sender_username, s.avatar_color as sender_avatar_color,
    r.name as receiver_name, r.username as receiver_username, r.avatar_color as receiver_avatar_color
  FROM transactions t
  JOIN users s ON t.sender_id = s.id
  JOIN users r ON t.receiver_id = r.id
`;

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sql = getSql();
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');

  let transactions;
  if (type === 'feed') {
    transactions = await sql.unsafe(TX_SELECT + `WHERE t.privacy = 'public' ORDER BY t.created_at DESC LIMIT 50`);
  } else if (type === 'requests') {
    transactions = await sql.unsafe(
      TX_SELECT + `WHERE t.type = 'request' AND t.status = 'pending' AND (t.sender_id = $1 OR t.receiver_id = $1) ORDER BY t.created_at DESC LIMIT 50`,
      [user.userId]
    );
  } else {
    transactions = await sql.unsafe(
      TX_SELECT + `WHERE (t.sender_id = $1 OR t.receiver_id = $1) ORDER BY t.created_at DESC LIMIT 100`,
      [user.userId]
    );
  }
  return NextResponse.json(transactions);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sql = getSql();
  try {
    const { receiverEmail, amount, note, type, privacy } = await req.json();
    if (!receiverEmail || !amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }
    if (amount > 10000) {
      return NextResponse.json({ error: 'Amount cannot exceed $10,000 CAD' }, { status: 400 });
    }
    const receiverRows = await sql`SELECT * FROM users WHERE email = ${receiverEmail} OR username = ${receiverEmail}`;
    const receiver = receiverRows[0] as { id: number; name: string; balance: number } | undefined;
    if (!receiver) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (receiver.id === user.userId) {
      return NextResponse.json({ error: 'Cannot send money to yourself' }, { status: 400 });
    }
    const senderRows = await sql`SELECT * FROM users WHERE id = ${user.userId}`;
    const sender = senderRows[0] as { id: number; balance: number; country: string };
    const currency = sender.country === 'US' ? 'USD' : 'CAD';
    if (type === 'payment') {
      if (sender.balance < amount) {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
      }
      await sql`UPDATE users SET balance = balance - ${amount} WHERE id = ${user.userId}`;
      await sql`UPDATE users SET balance = balance + ${amount} WHERE id = ${receiver.id}`;
      const result = await sql`
        INSERT INTO transactions (sender_id, receiver_id, amount, currency, note, type, status, privacy)
        VALUES (${user.userId}, ${receiver.id}, ${amount}, ${currency}, ${note || null}, 'payment', 'completed', ${privacy || 'public'})
        RETURNING id
      `;
      return NextResponse.json({ success: true, transactionId: result[0].id }, { status: 201 });
    } else if (type === 'request') {
      const result = await sql`
        INSERT INTO transactions (sender_id, receiver_id, amount, currency, note, type, status, privacy)
        VALUES (${receiver.id}, ${user.userId}, ${amount}, ${currency}, ${note || null}, 'request', 'pending', ${privacy || 'private'})
        RETURNING id
      `;
      return NextResponse.json({ success: true, transactionId: result[0].id }, { status: 201 });
    }
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (err) {
    console.error('Transaction error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
