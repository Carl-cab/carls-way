import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sql = getSql();
  const rows = await sql`
    SELECT id, name, username, email, phone, balance, balance_cad, balance_usd,
           province, country, avatar_color, kyc_status, created_at
    FROM users WHERE id = ${user.userId}
  `;
  if (rows.length === 0) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  return NextResponse.json(rows[0]);
}
