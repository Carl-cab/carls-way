import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, auditLog } from '@/lib/auth';
import { getStripe } from '@/lib/stripe';
import { getSql } from '@/lib/db';

/**
 * POST /api/stripe/confirm-setup
 *
 * Called after Stripe Elements confirms the ACSS SetupIntent on the client.
 * Retrieves the SetupIntent from Stripe, validates it belongs to this user,
 * then stores the resulting payment_method_id on the bank_accounts row.
 *
 * Body: { setup_intent_id: string, bank_account_id: number }
 *
 * Returns: { success: true, payment_method_id: string }
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { setup_intent_id, bank_account_id } = await req.json() as {
      setup_intent_id: string;
      bank_account_id: number;
    };

    if (!setup_intent_id || !bank_account_id) {
      return NextResponse.json(
        { error: 'setup_intent_id and bank_account_id are required' },
        { status: 400 }
      );
    }

    const stripe = getStripe();
    const sql = getSql();

    // Retrieve and validate the SetupIntent
    const setupIntent = await stripe.setupIntents.retrieve(setup_intent_id);

    if (setupIntent.metadata?.manna_user_id !== String(user.userId)) {
      return NextResponse.json({ error: 'SetupIntent does not belong to this user' }, { status: 403 });
    }

    if (setupIntent.status !== 'succeeded') {
      return NextResponse.json(
        { error: `SetupIntent is not succeeded (status: ${setupIntent.status})` },
        { status: 400 }
      );
    }

    const paymentMethodId = typeof setupIntent.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent.payment_method?.id;

    if (!paymentMethodId) {
      return NextResponse.json({ error: 'No payment method on SetupIntent' }, { status: 400 });
    }

    // Verify the bank_account belongs to this user
    const accountRows = await sql`
      SELECT id FROM bank_accounts
      WHERE id = ${bank_account_id} AND user_id = ${user.userId} AND is_active = true
    `;
    if (!accountRows[0]) {
      return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
    }

    // Store the payment method ID on the bank account
    await sql`
      UPDATE bank_accounts
      SET stripe_payment_method_id = ${paymentMethodId},
          updated_at = NOW()
      WHERE id = ${bank_account_id} AND user_id = ${user.userId}
    `;

    await auditLog(user.userId, 'stripe_payment_method_linked', {
      bank_account_id,
      payment_method_id: paymentMethodId,
      setup_intent_id,
    });

    return NextResponse.json({ success: true, payment_method_id: paymentMethodId });
  } catch (err) {
    console.error('Stripe confirm-setup error:', err);
    return NextResponse.json({ error: 'Failed to confirm setup intent' }, { status: 500 });
  }
}
