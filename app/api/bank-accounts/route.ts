import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';

export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sql = getSql();
  const rows = await sql`
    SELECT id, institution_name, account_name, account_type,
           account_mask, currency, country, is_primary
    FROM bank_accounts WHERE user_id = ${user.userId} AND is_active = true
    ORDER BY is_primary DESC, created_at ASC
  `;
  return NextResponse.json(rows);
}

export async function DELETE(req: Request) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await req.json() as { id: number };
  const sql = getSql();
  await sql`UPDATE bank_accounts SET is_active = false WHERE id = ${id} AND user_id = ${user.userId}`;
  return NextResponse.json({ success: true });
}
