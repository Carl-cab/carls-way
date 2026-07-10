import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { getStripe } from '@/lib/stripe';
import { getSql } from '@/lib/db';

/**
 * POST /api/stripe/setup-intent
 *
 * Creates (or retrieves) a Stripe Customer for the user, then creates an
 * ACSS Debit SetupIntent for collecting a Canadian pre-authorized debit (PAD) mandate.
 *
 * Only available for CA users. US users use Plaid Transfer directly.
 *
 * Returns:
 *   { client_secret: string, customer_id: string }
 */
export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const stripe = getStripe();
    const sql = getSql();

    // Get user details including country
    const userRows = await sql`
      SELECT stripe_customer_id, email, name, country FROM users WHERE id = ${user.userId}
    `;
    if (!userRows[0]) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const dbUser = userRows[0];

    // Only CA users need a Stripe Setup Intent for ACSS Debit
    if (dbUser.country !== 'CA') {
      return NextResponse.json(
        { error: 'Stripe ACSS Setup Intent is only available for Canadian users.' },
        { status: 400 }
      );
    }
    let customerId: string = dbUser.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: dbUser.email,
        name: dbUser.name,
        metadata: { manna_user_id: String(user.userId) },
      });
      customerId = customer.id;
      await sql`
        UPDATE users SET stripe_customer_id = ${customerId} WHERE id = ${user.userId}
      `;
    }

    // Create ACSS Debit SetupIntent
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['acss_debit'],
      payment_method_options: {
        acss_debit: {
          currency: 'cad',
          mandate_options: {
            payment_schedule: 'sporadic',
            transaction_type: 'personal',
            // PAD mandate statement descriptor shown to the user
            custom_mandate_url: undefined,
          },
        },
      },
      metadata: {
        manna_user_id: String(user.userId),
      },
    });

    return NextResponse.json({
      client_secret: setupIntent.client_secret,
      customer_id: customerId,
    });
  } catch (err) {
    console.error('Stripe setup-intent error:', err);
    return NextResponse.json({ error: 'Failed to create setup intent' }, { status: 500 });
  }
}
