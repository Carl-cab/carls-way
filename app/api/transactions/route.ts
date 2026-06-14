import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');

  let sql: string;
  const params: unknown[] = [user.userId];

  const baseSelect = `
    SELECT t.id, t.amount, t.currency, t.note, t.type, t.status, t.privacy, t.created_at,
      s.name as sender_name, s.username as sender_username, s.avatar_color as sender_avatar_color,
      r.name as receiver_name, r.username as receiver_username, r.avatar_color as receiver_avatar_color
    FROM transactions t
    JOIN users s ON t.sender_id = s.id
    JOIN users r ON t.receiver_id = r.id
  `;

  if (type === 'feed') {
    sql = baseSelect + `
      WHERE t.privacy = 'public'
      ORDER BY t.created_at DESC LIMIT 50
    `;
    params.length = 0;
  } else if (type === 'requests') {
    sql = baseSelect + `
      WHERE t.type = 'request' AND t.status = 'pending'
        AND (t.sender_id = $1 OR t.receiver_id = $1)
      ORDER BY t.created_at DESC LIMIT 50
    `;
  } else {
    sql = baseSelect + `
      WHERE (t.sender_id = $1 OR t.receiver_id = $1)
      ORDER BY t.created_at DESC LIMIT 100
    `;
  }

  const transactions = await query(sql, params.length ? params : undefined);
  return NextResponse.json(transactions.rows);
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { receiverEmail, amount, note, type, privacy } = await req.json();
    if (!receiverEmail || !amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    }
    if (amount > 10000) {
      return NextResponse.json({ error: 'Amount cannot exceed $10,000 CAD' }, { status: 400 });
    }
    const receiverRows = await query(
      'SELECT * FROM users WHERE email = $1 OR username = $1',
      [receiverEmail]
    );
    const receiver = receiverRows.rows[0] as { id: number; name: string; balance: number } | undefined;
    if (!receiver) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (receiver.id === user.userId) {
      return NextResponse.json({ error: 'Cannot send money to yourself' }, { status: 400 });
    }
    const senderRows = await query('SELECT * FROM users WHERE id = $1', [user.userId]);
    const sender = senderRows.rows[0] as { id: number; balance: number; country: string };
    const currency = sender.country === 'US' ? 'USD' : 'CAD';

    if (type === 'payment') {
      if (sender.balance < amount) {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
      }
      await query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, user.userId]);
      await query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, receiver.id]);
      const result = await query(
        `INSERT INTO transactions (sender_id, receiver_id, amount, currency, note, type, status, privacy)
         VALUES ($1, $2, $3, $4, $5, 'payment', 'completed', $6) RETURNING id`,
        [user.userId, receiver.id, amount, currency, note || null, privacy || 'public']
      );
      return NextResponse.json({ success: true, transactionId: result.rows[0].id }, { status: 201 });
    } else if (type === 'request') {
      const result = await query(
        `INSERT INTO transactions (sender_id, receiver_id, amount, currency, note, type, status, privacy)
         VALUES ($1, $2, $3, $4, $5, 'request', 'pending', $6) RETURNING id`,
        [receiver.id, user.userId, amount, currency, note || null, privacy || 'private']
      );
      return NextResponse.json({ success: true, transactionId: result.rows[0].id }, { status: 201 });
    }
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (err) {
    console.error('Transaction error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
