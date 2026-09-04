import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser, checkVelocityLimit, recordVelocity, auditLog } from '@/lib/auth';
import { buildFxQuote } from '@/lib/fx';
import { createNotification } from '@/lib/notifications';
import { createLedgerPair, createCrossBorderLedgerPair } from '@/lib/ledger';

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
           t.sender_id, t.receiver_id,
           s.username AS sender_username, s.name AS sender_name, s.avatar_color AS sender_avatar_color,
           r.username AS receiver_username, r.name AS receiver_name, r.avatar_color AS receiver_avatar_color
    FROM transactions t
    JOIN users s ON t.sender_id = s.id
    JOIN users r ON t.receiver_id = r.id
    WHERE t.id = ${txId}
  `;

  if (!rows[0]) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  const tx = rows[0] as {
    id: number; sender_id: number; receiver_id: number; privacy: string;
    sender_username: string; sender_name: string; sender_avatar_color: string;
    receiver_username: string; receiver_name: string; receiver_avatar_color: string;
    type: string; status: string; amount: number; currency: string; note: string;
    sender_currency: string; receiver_currency: string;
    fx_rate: number | null; fx_fee: number | null;
    sender_amount: number | null; receiver_amount: number | null;
    is_cross_border: boolean; payment_rail: string;
    estimated_settlement: string | null; created_at: string;
  };

  // User is sender or receiver: return full data
  if (tx.sender_id === user.userId || tx.receiver_id === user.userId) {
    return NextResponse.json(tx);
  }

  // User is not a party: check if transaction is public
  if (tx.privacy === 'public') {
    return NextResponse.json({
      ...tx,
      isPublicNonParty: true,
    });
  }

  // Private transaction and user is not a party
  return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
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

    // Atomically: debit payer (with balance guard), credit receiver, mark request completed.
    try {
      await sql.begin(async (tx) => {
        const debited = payerCurrency === 'USD'
          ? await tx`UPDATE users SET balance_usd = balance_usd - ${numAmount}
                     WHERE id = ${user.userId} AND balance_usd >= ${numAmount} RETURNING id`
          : await tx`UPDATE users SET balance_cad = balance_cad - ${numAmount}
                     WHERE id = ${user.userId} AND balance_cad >= ${numAmount} RETURNING id`;
        if (debited.length === 0) {
          throw new Error('INSUFFICIENT_BALANCE');
        }

        if (receiverCurrency === 'USD') {
          await tx`UPDATE users SET balance_usd = balance_usd + ${receiverAmount} WHERE id = ${transaction.receiver_id}`;
        } else {
          await tx`UPDATE users SET balance_cad = balance_cad + ${receiverAmount} WHERE id = ${transaction.receiver_id}`;
        }

        // Guard against double-accept: only transition if still pending
        const updated = await tx`
          UPDATE transactions SET
            status = 'completed', type = 'payment',
            fx_rate = ${fxRate}, fx_fee = ${fxFee},
            sender_amount = ${numAmount}, receiver_amount = ${receiverAmount},
            payment_rail = ${transaction.is_cross_border ? 'wire' : 'internal'},
            estimated_settlement = ${estimatedSettlement ? estimatedSettlement.toISOString() : null}
          WHERE id = ${transaction.id} AND status = 'pending'
          RETURNING id
        `;
        if (updated.length === 0) {
          throw new Error('ALREADY_PROCESSED');
        }
      });
    } catch (txErr) {
      if (txErr instanceof Error && txErr.message === 'INSUFFICIENT_BALANCE') {
        return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
      }
      if (txErr instanceof Error && txErr.message === 'ALREADY_PROCESSED') {
        return NextResponse.json({ error: 'Request already processed' }, { status: 409 });
      }
      throw txErr;
    }

    // Ledger entries for auditability (passive; non-blocking on failure)
    try {
      const requesterRows = await sql`SELECT username FROM users WHERE id = ${transaction.receiver_id}`;
      const requesterUsername = (requesterRows[0]?.username as string) || 'user';
      if (transaction.is_cross_border) {
        const fxDescription = `@ ${fxRate.toFixed(4)} (fee: ${fxFee} ${payerCurrency})`;
        await createCrossBorderLedgerPair(
          user.userId, payerCurrency, numAmount,
          transaction.receiver_id, receiverCurrency, receiverAmount,
          transaction.id,
          {
            senderDescription: `Paid request from @${requesterUsername}: ${numAmount} ${payerCurrency} converted to ${receiverAmount} ${receiverCurrency} ${fxDescription}`,
            receiverDescription: `Request fulfilled by @${user.username}: received ${receiverAmount} ${receiverCurrency} (from ${numAmount} ${payerCurrency} ${fxDescription})`,
          }
        );
      } else {
        await createLedgerPair(user.userId, transaction.receiver_id, payerCurrency, numAmount, transaction.id, {
          entryType: 'payment_sent',
          senderDescription: `Paid request from @${requesterUsername}: ${numAmount} ${payerCurrency}`,
          receiverDescription: `Request fulfilled by @${user.username}: received ${numAmount} ${payerCurrency}`,
        });
      }
    } catch (ledgerErr) {
      console.error('Ledger entry creation failed (non-blocking):', ledgerErr);
    }

    await recordVelocity(user.userId, numAmount, payerCurrency);
    await auditLog(user.userId, 'request_accepted', {
      receiverId: transaction.receiver_id,
      amount: numAmount,
      currency: payerCurrency,
      isCrossBorder: transaction.is_cross_border,
    });

    // Notify the requester that their request was paid
    const acceptDisplayAmount = new Intl.NumberFormat('en-CA', {
      style: 'currency', currency: receiverCurrency,
    }).format(receiverAmount);
    await createNotification({
      userId: transaction.receiver_id,
      type: 'payment_received',
      title: 'Request paid',
      message: `@${user.username} paid your request. You received ${acceptDisplayAmount}.`,
      relatedEntityType: 'transaction',
      relatedEntityId: transaction.id,
    });
  } else {
    await sql`UPDATE transactions SET status = 'declined' WHERE id = ${transaction.id} AND status = 'pending'`;
    await auditLog(user.userId, 'request_declined', { transactionId: transaction.id });
    await createNotification({
      userId: transaction.receiver_id,
      type: 'payment_request',
      title: 'Request declined',
      message: `@${user.username} declined your money request.`,
      relatedEntityType: 'transaction',
      relatedEntityId: transaction.id,
    });
  }
  return NextResponse.json({ success: true });
}
