import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { auditLog } from '@/lib/auth';
import { getProviderEvent, markProviderEventFailed } from '@/lib/provider-events';
import {
  handleStripeSettlementEvent,
} from '@/lib/settlement/handle-stripe-settlement';
import type { StripeEventLike } from '@/lib/settlement/stripe-event-adapter';
import { isSettlementEvent } from '@/lib/settlement/stripe-event-adapter';

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

    // Financial events now run through the settlement pipeline. Previously this
    // branch recorded an event and marked it processed without ever calling the
    // orchestrator or executor, so a successful ACSS debit was stored, marked
    // done, and never moved its transfer intent, wrote a ledger entry, or
    // credited a wallet.
    //
    // handleStripeSettlementEvent records first and marks processed last, so a
    // crash anywhere in between leaves the event retryable rather than
    // silently complete. It records unmapped financial events too, so nothing
    // that used to be captured stops being captured.
    if (isFinancialEvent(event.type)) {
      // C1.4: a redelivered event that has already been dead-lettered is
      // acknowledged without reprocessing.
      //
      // This check moved ahead of the handler during the merge. C1.4 was
      // written against the old webhook, which recorded the event here and
      // then marked it processed inline. handleStripeSettlementEvent now owns
      // recordProviderEvent / markProviderEventProcessed / markProviderEventFailed,
      // and dead-lettering happens inside markProviderEventFailed once retries
      // are exhausted — so asking afterwards would be asking too late. The
      // Plaid route reads the same way.
      const recorded = (await getProviderEvent('stripe', event.id)) as {
        processing_status: string;
      } | null;
      if (recorded?.processing_status === 'dead_letter') {
        return NextResponse.json({ received: true, duplicate: true });
      }

      const result = await handleStripeSettlementEvent(
        event as unknown as StripeEventLike,
        req.headers.get('x-correlation-id') ?? '',
      );

      if (result.outcome === 'failed') {
        console.error('Stripe settlement failed for event', event.id, result.reason);
      }

      // A retryable failure must not be acknowledged. Answering 200 tells
      // Stripe the event is handled and it will never redeliver; there is no
      // worker draining failed provider_webhook_events rows, so the event
      // would be lost. 500 puts it back on Stripe's retry schedule.
      //
      // Terminal outcomes are acknowledged: an intent that does not exist, or
      // a transition the state machine rejects, produces the same answer on
      // every redelivery, so retrying only repeats the failure.
      if (result.retryable) {
        return NextResponse.json(
          { error: 'Settlement failed; event will be retried' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    // Acknowledging a failure with 200 tells Stripe the event was handled, so it
    // is never redelivered and the event is lost permanently — for a financial
    // or identity event that is a silent-data-loss failure mode. Return 500 so
    // Stripe retries.
    //
    // Safe to retry:
    //   - the signature was already verified above, so only authentic Stripe
    //     events can reach this path;
    //   - recordProviderEvent is idempotent via
    //     UNIQUE(provider, provider_event_id) and reports duplicates rather
    //     than double-inserting;
    //   - the KYC updates are idempotent, scoped by kyc_session_id.
    //
    // This also matches the Plaid webhook, which already returns 500 here.
    console.error('Stripe webhook handler error:', err);
    // C1.4: track the failure so repeated failures dead-letter instead of
    // retrying forever unseen. Failure tracking must never mask the 500 —
    // the 500 is what makes Stripe redeliver.
    try {
      if (event?.id && isFinancialEvent(event.type)) {
        const outcome = await markProviderEventFailed(
          'stripe',
          event.id,
          err instanceof Error ? err : String(err)
        );
        if (outcome.deadLettered) {
          console.error(
            `[stripe-webhook] Event dead-lettered after ${outcome.retryCount} attempts: ${event.id} (${event.type})`
          );
        }
      }
    } catch {
      // Failure tracking is best-effort; the 500 below is what matters.
    }
    return NextResponse.json(
      { error: 'Webhook handler failed; event will be retried' },
      { status: 500 },
    );
  }
}

/**
 * Financial events worth durably recording.
 *
 * Wider than the set the settlement adapter acts on: `charge.*` and
 * `payout.created` are kept because they are evidence during an investigation,
 * but they are deliberately not settled. A successful ACSS debit emits both
 * `charge.succeeded` and `payment_intent.succeeded`, and settling both would
 * apply one movement of money twice. See lib/settlement/stripe-event-adapter.ts.
 */
function isFinancialEvent(eventType: string): boolean {
  const recordOnly = [
    'charge.updated',
    'charge.succeeded',
    'charge.failed',
    'payout.created',
    // Recorded, never settled: the cash-out rail pays the platform's own
    // external account rather than the customer's. See the adapter.
    'payout.paid',
    'payout.failed',
    'payout.canceled',
  ];

  return isSettlementEvent(eventType) || recordOnly.includes(eventType);
}
