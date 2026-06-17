import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { auditLog } from '@/lib/auth';

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export async function POST(req: NextRequest) {
  if (!WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  // Read raw body — required for Stripe signature verification
  const rawBody = await req.text();

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 400 });
  }

  const sql = getSql();

  try {
    if (event.type === 'identity.verification_session.verified') {
      const session = event.data.object as { id: string };

      await sql`
        UPDATE users
        SET kyc_status      = 'verified',
            kyc_verified_at = NOW()
        WHERE kyc_session_id = ${session.id}
      `;

      // Retrieve user for audit log
      const rows = await sql`SELECT id FROM users WHERE kyc_session_id = ${session.id}`;
      if (rows[0]) {
        await auditLog(rows[0].id as number, 'kyc_verified', { sessionId: session.id, provider: 'stripe' });
      }
    }

    if (event.type === 'identity.verification_session.requires_input') {
      const session = event.data.object as {
        id: string;
        last_error?: { code?: string; reason?: string } | null;
      };
      const reason = session.last_error?.reason || session.last_error?.code || 'Unknown';

      await sql`
        UPDATE users
        SET kyc_status            = 'requires_input',
            kyc_rejection_reason  = ${reason}
        WHERE kyc_session_id = ${session.id}
      `;

      const rows = await sql`SELECT id FROM users WHERE kyc_session_id = ${session.id}`;
      if (rows[0]) {
        await auditLog(rows[0].id as number, 'kyc_requires_input', { sessionId: session.id, reason });
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    // Return 200 so Stripe does not retry — log the error for investigation
    return NextResponse.json({ received: true, warning: 'Handler error' });
  }
}
