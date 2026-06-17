import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';

export async function GET() {
  try {
    const sql = getSql();
    const transactions = await sql`
      SELECT t.id, t.type, t.status,
             t.sender_currency, t.receiver_currency,
             t.sender_amount, t.receiver_amount,
             t.is_cross_border, t.payment_rail, t.estimated_settlement,
             t.created_at,
             s.username AS sender_username, s.name AS sender_name, s.avatar_color AS sender_avatar_color,
             r.username AS receiver_username, r.name AS receiver_name, r.avatar_color AS receiver_avatar_color
      FROM transactions t
      JOIN users s ON t.sender_id = s.id
      JOIN users r ON t.receiver_id = r.id
      WHERE t.privacy = 'public' AND t.status = 'completed'
      ORDER BY t.created_at DESC
      LIMIT 50
    `;
    return NextResponse.json(transactions);
  } catch (err) {
    console.error('Feed GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
