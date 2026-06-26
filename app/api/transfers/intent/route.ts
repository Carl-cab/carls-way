import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { checkVelocityLimit } from '@/lib/auth';

export async function POST(req: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Check KYC verified
    const sql = getSql();
    const users = await sql`SELECT kyc_status FROM users WHERE id = ${user.userId}`;
    if (!users[0] || users[0].kyc_status !== 'verified') {
      return NextResponse.json({ error: 'KYC verification required' }, { status: 403 });
    }

    // Check encrypted bank account exists
    const bankAccounts = await sql`
      SELECT id FROM bank_accounts
      WHERE user_id = ${user.userId} AND is_token_encrypted = true AND is_active = true
      LIMIT 1
    `;
    if (bankAccounts.length === 0) {
      return NextResponse.json({ error: 'Encrypted bank account required' }, { status: 403 });
    }

    const { type, amount, currency } = await req.json();

    if (!type || !amount || !currency) {
      return NextResponse.json({ error: 'Missing required fields: type, amount, currency' }, { status: 400 });
    }

    if (!['add_money', 'cash_out'].includes(type)) {
      return NextResponse.json({ error: 'Type must be add_money or cash_out' }, { status: 400 });
    }

    if (amount <= 0) {
      return NextResponse.json({ error: 'Amount must be positive' }, { status: 400 });
    }

    // Check velocity limits
    const velocityResult = await checkVelocityLimit(user.userId, amount, currency);
    if (!velocityResult.allowed) {
      await sql`
        INSERT INTO audit_logs (user_id, action, metadata)
        VALUES (${user.userId}, 'transfer_intent_blocked', ${JSON.stringify({ type, amount, currency, reason: 'velocity_limit' })})
      `;
      return NextResponse.json({ error: 'Transfer limit exceeded' }, { status: 429 });
    }

    // Create transfer intent (sandbox only - no actual transfer)
    const result = await sql`
      INSERT INTO transfer_intents (user_id, type, amount, currency, status, provider)
      VALUES (${user.userId}, ${type}, ${amount}, ${currency}, 'draft', NULL)
      RETURNING id, type, amount, currency, status, provider, created_at
    `;

    const transferIntent = result[0];

    // Audit log
    await sql`
      INSERT INTO audit_logs (user_id, action, metadata)
      VALUES (${user.userId}, 'transfer_intent_created', ${JSON.stringify({ transfer_id: transferIntent.id, type, amount, currency, status: 'draft' })})
    `;

    return NextResponse.json({ success: true, ...transferIntent }, { status: 201 });
  } catch (err) {
    console.error('Transfer intent error:', err);
    return NextResponse.json({ error: 'Failed to create transfer intent' }, { status: 500 });
  }
}
