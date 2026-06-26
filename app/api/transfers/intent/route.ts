import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser, checkVelocityLimit, auditLog } from '@/lib/auth';
import { getTransferProvider, regionFromCountry } from '@/lib/transfers/router';

export async function POST(req: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();

    // Load user record — need country for provider routing and KYC status
    const userRows = await sql`
      SELECT kyc_status, country FROM users WHERE id = ${user.userId}
    `;
    if (!userRows[0] || userRows[0].kyc_status !== 'verified') {
      return NextResponse.json({ error: 'KYC verification required before transfers' }, { status: 403 });
    }

    const userCountry = userRows[0].country as string;
    const region = regionFromCountry(userCountry);

    // Find the user's primary encrypted bank account
    const bankRows = await sql`
      SELECT id FROM bank_accounts
      WHERE user_id = ${user.userId}
        AND is_token_encrypted = true
        AND is_active = true
      ORDER BY is_primary DESC
      LIMIT 1
    `;
    if (bankRows.length === 0) {
      return NextResponse.json({ error: 'No linked bank account found. Please link a bank account first.' }, { status: 403 });
    }
    const bankAccountId = bankRows[0].id as number;

    const body = await req.json() as { type?: string; amount?: number; currency?: string };
    const { type, amount, currency } = body;

    if (!type || !amount || !currency) {
      return NextResponse.json({ error: 'Missing required fields: type, amount, currency' }, { status: 400 });
    }
    if (!['add_money', 'cash_out'].includes(type)) {
      return NextResponse.json({ error: 'type must be add_money or cash_out' }, { status: 400 });
    }
    if (typeof amount !== 'number' || amount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 });
    }
    if (!['CAD', 'USD'].includes(currency)) {
      return NextResponse.json({ error: 'currency must be CAD or USD' }, { status: 400 });
    }

    // Velocity check — not recorded here; recorded only at confirm step
    const velocityResult = await checkVelocityLimit(user.userId, amount, currency);
    if (!velocityResult.allowed) {
      await auditLog(user.userId, 'transfer_intent_blocked', { type, amount, currency, reason: velocityResult.reason });
      return NextResponse.json({ error: velocityResult.reason || 'Transfer limit exceeded' }, { status: 429 });
    }

    const provider = getTransferProvider(region);
    const result = await provider.createIntent(user.userId, bankAccountId, type as 'add_money' | 'cash_out', amount, currency);

    return NextResponse.json({ success: true, ...result }, { status: 201 });
  } catch (err) {
    console.error('Transfer intent error:', err);
    return NextResponse.json({ error: 'Failed to create transfer intent' }, { status: 500 });
  }
}
