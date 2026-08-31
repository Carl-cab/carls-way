import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, auditLog } from '@/lib/auth';
import { createNotification } from '@/lib/notifications';
import { paySplitPortion, SplitPaymentError } from '@/lib/splits';
import { getSql } from '@/lib/db';

/**
 * POST /api/splits/[id]/pay — pay the caller's own portion of a split.
 *
 * The payer is always the authenticated user; there is no way to pay on behalf
 * of someone else, and no amount is accepted from the client — the portion is
 * whatever the split recorded. Payment is atomic and cannot be applied twice.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const splitId = parseInt(id, 10);
    if (isNaN(splitId)) {
      return NextResponse.json({ error: 'Invalid split ID' }, { status: 400 });
    }

    const result = await paySplitPortion(splitId, user.userId);

    await auditLog(user.userId, 'split_portion_paid', {
      split_id: splitId,
      transaction_id: result.transactionId,
      amount: result.amountPaid,
    });

    // Tell the person who is owed.
    const sql = getSql();
    const creator = await sql`
      SELECT creator_id, currency, description FROM splits WHERE id = ${splitId}
    `;
    if (creator[0]) {
      const label = new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: creator[0].currency as string,
      }).format(result.amountPaid);
      await createNotification({
        userId: creator[0].creator_id as number,
        type: 'split_payment',
        title: 'Split payment received',
        message:
          `@${user.username} paid ${label} toward ${creator[0].description || 'your split'}.` +
          (result.splitStatus === 'settled'
            ? ' The split is now fully settled.'
            : ` ${result.remainingParticipants} portion(s) still outstanding.`),
        relatedEntityType: 'split',
        relatedEntityId: splitId,
      });
    }

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof SplitPaymentError) {
      const status =
        err.code === 'NOT_PARTICIPANT' ? 403
        : err.code === 'ALREADY_PAID' ? 409
        : err.code === 'SPLIT_CLOSED' ? 409
        : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('Split pay error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
