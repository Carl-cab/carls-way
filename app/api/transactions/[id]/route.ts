import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser, checkVelocityLimit, recordVelocity, auditLog } from '@/lib/auth';
import { buildFxQuote } from '@/lib/fx';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const txId = parseInt(id, 10);
  if (isNaN(txId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const sql = getSql();
  const rows = await sql`
    SELECT t.id, t.type, t.status, t.amount, t.currency, t.note,
           t.sender_currency, t.receiver_currency,
           t.fx_rate, t.fx_fee, t.sender_amount, t.receiver_amount,
           t.is_cross_border, t.payment_rail, t.estimated_settlement,
           t.privacy, t.created_at,
           s.username AS sender_username, s.name AS sender_name, s.avatar_color AS sender_avatar_color,
           r.username AS receiver_username, r.name AS receiver_name, r.avatar_color AS receiver_avatar_color
    FROM transactions t
    JOIN users s ON t.sender_id = s.id
    JOIN users r ON t.receiver_id = r.id
    WHERE t.id = ${txId}
      AND (t.sender_id = ${user.userId} OR t.receiver_id = ${user.userId})
  `;

  if (!rows[0]) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  return NextResponse.json(rows[0]);
}

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
    sender_currency: string; receiver_currency: string; is_cross_border: boolean;
  } | undefined;
  if (!transaction) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }
  if (transaction.sender_id !== user.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (action === 'accept') {
    const numAmount = parseFloat(String(transaction.amount));
    const payerCurrency = transaction.sender_currency;
    const receiverCurrency = transaction.receiver_currency;

    // Velocity check (accepting a request is an outbound payment for the payer)
    const velocityCheck = await checkVelocityLimit(user.userId, numAmount, payerCurrency);
    if (!velocityCheck.allowed) {
      return NextResponse.json({ error: velocityCheck.reason }, { status: 429 });
    }

    // Balance check
    const payerRows = await sql`SELECT balance_cad, balance_usd FROM users WHERE id = ${user.userId}`;
    const payer = payerRows[0] as { balance_cad: number; balance_usd: number };
    const payerBalance = payerCurrency === 'USD'
      ? parseFloat(String(payer.balance_usd))
      : parseFloat(String(payer.balance_cad));

    if (payerBalance < numAmount) {
      return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
    }

    // Build FX quote if cross-border
    let receiverAmount = numAmount;
    let fxRate = 1.0;
    let fxFee = 0;
    let estimatedSettlement: Date | null = null;

    if (transaction.is_cross_border) {
      const quote = await buildFxQuote(numAmount, payerCurrency, receiverCurrency);
      receiverAmount = quote.receiverAmount;
      fxRate = quote.rate;
      fxFee = quote.feeAmount;
      estimatedSettlement = quote.estimatedSettlement;
    }

    // Deduct from payer
    if (payerCurrency === 'USD') {
      await sql`UPDATE users SET balance_usd = balance_usd - ${numAmount} WHERE id = ${user.userId}`;
    } else {
      await sql`UPDATE users SET balance_cad = balance_cad - ${numAmount} WHERE id = ${user.userId}`;
    }

    // Credit receiver
    if (receiverCurrency === 'USD') {
      await sql`UPDATE users SET balance_usd = balance_usd + ${receiverAmount} WHERE id = ${transaction.receiver_id}`;
    } else {
      await sql`UPDATE users SET balance_cad = balance_cad + ${receiverAmount} WHERE id = ${transaction.receiver_id}`;
    }

    await sql`
      UPDATE transactions SET
        status = 'completed', type = 'payment',
        fx_rate = ${fxRate}, fx_fee = ${fxFee},
        sender_amount = ${numAmount}, receiver_amount = ${receiverAmount},
        payment_rail = ${transaction.is_cross_border ? 'wire' : 'internal'},
        estimated_settlement = ${estimatedSettlement ? estimatedSettlement.toISOString() : null}
      WHERE id = ${transaction.id}
    `;

    await recordVelocity(user.userId, numAmount, payerCurrency);
    await auditLog(user.userId, 'request_accepted', {
      receiverId: transaction.receiver_id,
      amount: numAmount,
      currency: payerCurrency,
      isCrossBorder: transaction.is_cross_border,
    });
  } else {
    await sql`UPDATE transactions SET status = 'declined' WHERE id = ${transaction.id}`;
    await auditLog(user.userId, 'request_declined', { transactionId: transaction.id });
  }
  return NextResponse.json({ success: true });
}
