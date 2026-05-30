import { NextRequest, NextResponse } from 'next/server';
import getDb from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const filter = searchParams.get('filter') || 'all';
  const feed = searchParams.get('feed') || 'false';

  const db = getDb();

  if (feed === 'true') {
    // Public feed
    const transactions = db.prepare(`
      SELECT t.*, 
        s.name as sender_name, s.username as sender_username, s.avatar_color as sender_avatar_color,
        r.name as receiver_name, r.username as receiver_username, r.avatar_color as receiver_avatar_color
      FROM transactions t
      JOIN users s ON t.sender_id = s.id
      JOIN users r ON t.receiver_id = r.id
      WHERE t.privacy = 'public' AND t.status = 'completed' AND t.type = 'payment'
      ORDER BY t.created_at DESC
      LIMIT 50
    `).all();
    return NextResponse.json(transactions);
  }

  // Personal history
  let whereClause = '(t.sender_id = ? OR t.receiver_id = ?)';
  const params: unknown[] = [user.userId, user.userId];

  if (filter === 'sent') {
    whereClause = 't.sender_id = ? AND t.type = \'payment\'';
    params.splice(1, 1);
  } else if (filter === 'received') {
    whereClause = 't.receiver_id = ? AND t.type = \'payment\' AND t.status = \'completed\'';
    params.splice(1, 1);
  } else if (filter === 'pending') {
    whereClause = '(t.sender_id = ? OR t.receiver_id = ?) AND t.status = \'pending\'';
  }

  const transactions = db.prepare(`
    SELECT t.*,
      s.name as sender_name, s.username as sender_username, s.avatar_color as sender_avatar_color,
      r.name as receiver_name, r.username as receiver_username, r.avatar_color as receiver_avatar_color
    FROM transactions t
    JOIN users s ON t.sender_id = s.id
    JOIN users r ON t.receiver_id = r.id
    WHERE ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT 100
  `).all(...params);

  return NextResponse.json(transactions);
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

    const db = getDb();
    const receiver = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(receiverEmail, receiverEmail) as {
      id: number; name: string; balance: number;
    } | undefined;

    if (!receiver) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (receiver.id === user.userId) {
      return NextResponse.json({ error: 'Cannot send money to yourself' }, { status: 400 });
    }

    const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(user.userId) as {
      id: number; balance: number;
    };

    if (type === 'payment') {
      if (sender.balance < amount) {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
      }

      // Execute transfer
      db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, user.userId);
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, receiver.id);

      const result = db.prepare(
        'INSERT INTO transactions (sender_id, receiver_id, amount, note, type, status, privacy) VALUES (?, ?, ?, ?, \'payment\', \'completed\', ?)'
      ).run(user.userId, receiver.id, amount, note || null, privacy || 'public');

      return NextResponse.json({ success: true, transactionId: result.lastInsertRowid }, { status: 201 });
    } else if (type === 'request') {
      const result = db.prepare(
        'INSERT INTO transactions (sender_id, receiver_id, amount, note, type, status, privacy) VALUES (?, ?, ?, ?, \'request\', \'pending\', ?)'
      ).run(receiver.id, user.userId, amount, note || null, privacy || 'private');

      return NextResponse.json({ success: true, transactionId: result.lastInsertRowid }, { status: 201 });
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
  } catch (err) {
    console.error('Transaction error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
