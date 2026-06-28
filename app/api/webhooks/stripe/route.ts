import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { auditLog } from '@/lib/auth';
import { recordProviderEvent, markProviderEventProcessed } from '@/lib/provider-events';

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
    // Handle KYC events (existing logic)
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

    // Handle financial events (Phase B1: record only, no execution)
    if (isFinancialEvent(event.type)) {
      // Record event for future processing (Phase B2)
      // No settlement logic yet, just store the event
      const providerEventId = event.id || `stripe-${event.type}-${Date.now()}`;
      const dataObject = event.data.object as unknown;
      const relatedRef = (dataObject as Record<string, unknown> | null)?.id as string | undefined;

      await recordProviderEvent('stripe', providerEventId, event.type, {
        relatedProviderReference: relatedRef,
        rawPayload: event as unknown as Record<string, unknown>,
      });

      // Phase B2: Will call SettlementProcessor and apply side effects
      // For now, just mark as processed (structure ready)
      await markProviderEventProcessed('stripe', providerEventId);
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook handler error:', err);
    // Return 200 so Stripe does not retry — log the error for investigation
    return NextResponse.json({ received: true, warning: 'Handler error' });
  }
}

/**
 * Check if event is a financial event (not KYC).
 * Phase B1: Record for future processing, Phase B2 will execute settlement logic.
 */
function isFinancialEvent(eventType: string): boolean {
  // Add financial event types that Phase B2 will handle
  const financialEventTypes = [
    'charge.updated',
    'charge.succeeded',
    'charge.failed',
    'payout.created',
    'payout.paid',
    'payout.failed',
  ];

  return financialEventTypes.includes(eventType);
}
