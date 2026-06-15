import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser, checkVelocityLimit, recordVelocity, auditLog, sanitizeString } from '@/lib/auth';
import { buildFxQuote } from '@/lib/fx';

export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();
    const filter = req.nextUrl.searchParams.get('filter') || 'all';
    const filterCondition =
      filter === 'sent' ? sql`AND t.sender_id = ${user.userId}` :
      filter === 'received' ? sql`AND t.receiver_id = ${user.userId}` :
      filter === 'pending' ? sql`AND t.status = 'pending'` :
      sql``;

    const transactions = await sql`
      SELECT t.*,
        s.name as sender_name, s.username as sender_username, s.avatar_color as sender_avatar,
        r.name as receiver_name, r.username as receiver_username, r.avatar_color as receiver_avatar
      FROM transactions t
      JOIN users s ON t.sender_id = s.id
      JOIN users r ON t.receiver_id = r.id
      WHERE (t.sender_id = ${user.userId} OR t.receiver_id = ${user.userId})
        ${filterCondition}
      ORDER BY t.created_at DESC
      LIMIT 50
    `;
    return NextResponse.json(transactions);
  } catch (err) {
    console.error('Transactions GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { receiverUsername, amount, note, type, privacy } = body;

    // Input validation
    if (!receiverUsername || !amount || !type) {
      return NextResponse.json({ error: 'receiverUsername, amount, and type are required' }, { status: 400 });
    }
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0 || numAmount > 10000) {
      return NextResponse.json({ error: 'Amount must be between $0.01 and $10,000' }, { status: 400 });
    }
    if (!['pay', 'request'].includes(type)) {
      return NextResponse.json({ error: 'type must be pay or request' }, { status: 400 });
    }

    const cleanNote = sanitizeString(note || '', 200);
    const txPrivacy = ['public', 'friends', 'private'].includes(privacy) ? privacy : 'public';

    const sql = getSql();

    // Get sender and receiver
    const senderRows = await sql`SELECT * FROM users WHERE id = ${user.userId}`;
    const sender = senderRows[0] as {
      id: number; balance: number; balance_cad: number; balance_usd: number;
      country: string; kyc_status: string;
    } | undefined;
    if (!sender) return NextResponse.json({ error: 'Sender not found' }, { status: 404 });

    const receiverRows = await sql`SELECT * FROM users WHERE username = ${receiverUsername}`;
    const receiver = receiverRows[0] as {
      id: number; balance: number; balance_cad: number; balance_usd: number;
      country: string;
    } | undefined;
    if (!receiver) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (receiver.id === user.userId) return NextResponse.json({ error: 'Cannot send to yourself' }, { status: 400 });

    // Determine currencies
    const senderCurrency = sender.country === 'US' ? 'USD' : 'CAD';
    const receiverCurrency = receiver.country === 'US' ? 'USD' : 'CAD';
    const isCrossBorder = senderCurrency !== receiverCurrency;

    if (type === 'pay') {
      // Velocity check
      const velocityCheck = await checkVelocityLimit(user.userId, numAmount, senderCurrency);
      if (!velocityCheck.allowed) {
        return NextResponse.json({ error: velocityCheck.reason }, { status: 429 });
      }

      // Balance check
      const senderBalance = senderCurrency === 'USD'
        ? parseFloat(String(sender.balance_usd))
        : parseFloat(String(sender.balance_cad));

      if (senderBalance < numAmount) {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
      }

      // Build FX quote if cross-border
      let receiverAmount = numAmount;
      let fxRate = 1.0;
      let fxFee = 0;
      let estimatedSettlement: Date | null = null;

      if (isCrossBorder) {
        const quote = await buildFxQuote(numAmount, senderCurrency, receiverCurrency);
        receiverAmount = quote.receiverAmount;
        fxRate = quote.rate;
        fxFee = quote.feeAmount;
        estimatedSettlement = quote.estimatedSettlement;
      }

      // Deduct from sender
      if (senderCurrency === 'USD') {
        await sql`UPDATE users SET balance_usd = balance_usd - ${numAmount} WHERE id = ${user.userId}`;
      } else {
        await sql`UPDATE users SET balance_cad = balance_cad - ${numAmount} WHERE id = ${user.userId}`;
      }

      // Credit receiver
      if (receiverCurrency === 'USD') {
        await sql`UPDATE users SET balance_usd = balance_usd + ${receiverAmount} WHERE id = ${receiver.id}`;
      } else {
        await sql`UPDATE users SET balance_cad = balance_cad + ${receiverAmount} WHERE id = ${receiver.id}`;
      }

      // Create transaction record
      const result = await sql`
        INSERT INTO transactions (
          sender_id, receiver_id, amount, currency, note, type, status, privacy,
          sender_currency, receiver_currency, fx_rate, fx_fee,
          sender_amount, receiver_amount, is_cross_border, payment_rail,
          estimated_settlement
        ) VALUES (
          ${user.userId}, ${receiver.id}, ${numAmount}, ${senderCurrency}, ${cleanNote},
          ${type}, 'completed', ${txPrivacy},
          ${senderCurrency}, ${receiverCurrency}, ${fxRate}, ${fxFee},
          ${numAmount}, ${receiverAmount}, ${isCrossBorder},
          ${isCrossBorder ? 'wire' : 'internal'},
          ${estimatedSettlement ? estimatedSettlement.toISOString() : null}
        )
        RETURNING id
      `;

      await recordVelocity(user.userId, numAmount, senderCurrency);
      await auditLog(user.userId, 'payment_sent', {
        receiverId: receiver.id,
        amount: numAmount,
        currency: senderCurrency,
        isCrossBorder,
      });

      return NextResponse.json({ success: true, transactionId: result[0].id, isCrossBorder, receiverAmount, receiverCurrency }, { status: 201 });

    } else {
      // Request money
      const result = await sql`
        INSERT INTO transactions (
          sender_id, receiver_id, amount, currency, note, type, status, privacy,
          sender_currency, receiver_currency, is_cross_border
        ) VALUES (
          ${receiver.id}, ${user.userId}, ${numAmount}, ${receiverCurrency}, ${cleanNote},
          'request', 'pending', ${txPrivacy},
          ${receiverCurrency}, ${senderCurrency}, ${isCrossBorder}
        )
        RETURNING id
      `;

      await auditLog(user.userId, 'payment_requested', {
        fromId: receiver.id,
        amount: numAmount,
        currency: receiverCurrency,
      });

      return NextResponse.json({ success: true, transactionId: result[0].id }, { status: 201 });
    }
  } catch (err) {
    console.error('Transaction POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
