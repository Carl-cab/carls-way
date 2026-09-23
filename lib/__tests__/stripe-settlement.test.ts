/**
 * Stripe webhook → settlement pipeline.
 *
 * Runs against a real PostgreSQL instance. The defect this closes was that
 * events were durably recorded and marked processed while nothing downstream
 * ran, so the only assertion that means anything is what the database holds
 * afterwards: the intent's status, the ledger rows, the wallet balance, and the
 * event's own processing_status.
 */
import { getSql, initializeSchema } from '../db';
import {
  adaptStripeEvent,
  isSettlementEvent,
  mappedStripeEventTypes,
} from '../settlement/stripe-event-adapter';
import { handleStripeSettlementEvent } from '../settlement/handle-stripe-settlement';

const sql = getSql();
const USER_ID = 9501;

let seq = 0;
/** Unique reference per test so intents never collide across cases. */
function nextRef(prefix = 'pi'): string {
  seq += 1;
  return `${prefix}_settletest_${Date.now()}_${seq}`;
}

function stripeEvent(
  type: string,
  objectId: string,
  eventId = `evt_${Date.now()}_${++seq}`,
): { id: string; type: string; created: number; data: { object: { id: string } } } {
  return {
    id: eventId,
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: objectId } },
  };
}

async function createIntent(
  referenceId: string,
  status = 'processing',
  type = 'add_money',
  amount = 25,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO transfer_intents (
      user_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, provider_reference_id
    ) VALUES (
      ${USER_ID}, ${type}, ${amount}, 'CAD', ${status},
      'CA', 'canadian_eft', 'sandbox', ${referenceId}
    )
    RETURNING id
  `;
  return String(rows[0].id);
}

async function eventRow(providerEventId: string) {
  const rows = await sql<{ processing_status: string; processing_error: string | null }[]>`
    SELECT processing_status, processing_error
    FROM provider_webhook_events
    WHERE provider = 'stripe' AND provider_event_id = ${providerEventId}
  `;
  return rows[0] ?? null;
}

async function cleanup() {
  await sql`DELETE FROM ledger_entries WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM provider_webhook_events WHERE provider_event_id LIKE 'evt_%'`;
  await sql`DELETE FROM notifications WHERE user_id = ${USER_ID}`;
}

beforeAll(async () => {
  await initializeSchema();
  await cleanup();
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd)
    VALUES (${USER_ID}, 'Settle Tester', 'settle_tester', 'settle@example.test', 'x', 'CA', 0, 0)
  `;
}, 60000);

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
}, 60000);

describe('stripe event adapter', () => {
  it('maps the settlement events and nothing else', () => {
    expect(isSettlementEvent('payment_intent.succeeded')).toBe(true);
    expect(isSettlementEvent('payment_intent.payment_failed')).toBe(true);
    // payout.* is deliberately unmapped until a recipient-owned Canadian
    // disbursement rail exists; settling one would mark a customer cash-out
    // complete for a transfer that only reached the platform's own account.
    expect(isSettlementEvent('payout.paid')).toBe(false);
    expect(isSettlementEvent('payout.failed')).toBe(false);

    // charge.* is deliberately excluded: a successful ACSS debit emits both a
    // charge and a payment_intent event for one movement of money.
    expect(isSettlementEvent('charge.succeeded')).toBe(false);
    expect(isSettlementEvent('charge.failed')).toBe(false);
    expect(isSettlementEvent('payout.created')).toBe(false);
    expect(isSettlementEvent('identity.verification_session.verified')).toBe(false);
  });

  it('normalizes a payment intent success onto the object id', () => {
    const event = stripeEvent('payment_intent.succeeded', 'pi_abc');
    const { normalized } = adaptStripeEvent(event);

    expect(normalized).toMatchObject({
      provider: 'stripe',
      provider_event_id: event.id,
      provider_reference_id: 'pi_abc',
      eventType: 'settled',
    });
  });

  it('maps failure and pending distinctly', () => {
    expect(adaptStripeEvent(stripeEvent('payment_intent.payment_failed', 'pi_x')).normalized?.eventType)
      .toBe('failed');
    expect(adaptStripeEvent(stripeEvent('payment_intent.processing', 'pi_x')).normalized?.eventType)
      .toBe('pending');
    expect(adaptStripeEvent(stripeEvent('payout.paid', 'po_x')).normalized).toBeNull();
  });

  it('declines an unmapped type rather than guessing', () => {
    const result = adaptStripeEvent(stripeEvent('charge.succeeded', 'ch_1'));
    expect(result.normalized).toBeNull();
    expect(result.skipped).toBe('unmapped_event_type');
  });

  it('declines an event with no object id, which could not resolve an intent', () => {
    const result = adaptStripeEvent({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      created: 1,
      data: { object: {} },
    });
    expect(result.normalized).toBeNull();
    expect(result.skipped).toBe('missing_object_id');
  });

  it('does not fabricate a timestamp when Stripe omits one', () => {
    const { normalized } = adaptStripeEvent({
      id: 'evt_2',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_2' } },
    });
    expect(normalized?.timestamp.getTime()).toBe(0);
  });

  it('maps every documented type', () => {
    expect(mappedStripeEventTypes()).toEqual(
      expect.arrayContaining([
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.processing',
        'payment_intent.canceled',
      ]),
    );
  });
});

describe('duplicate webhook delivery', () => {
  it('detects a repeat delivery instead of throwing', async () => {
    // recordProviderEvent checked `error.constraint`, which postgres.js never
    // sets — it uses `constraint_name`. The check was therefore always false,
    // the unique violation was rethrown, the webhook answered 500, and the
    // provider retried the same event forever. Both Stripe and Plaid deliver
    // at least once, so this fired on ordinary traffic.
    const id = `evt_dupe_${Date.now()}`;
    const { recordProviderEvent } = await import('../provider-events');

    await expect(recordProviderEvent('stripe', id, 'payment_intent.succeeded')).resolves.toBe(true);
    await expect(recordProviderEvent('stripe', id, 'payment_intent.succeeded')).resolves.toBe(false);

    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM provider_webhook_events
      WHERE provider = 'stripe' AND provider_event_id = ${id}
    `;
    expect(rows[0].n).toBe(1);
    await sql`DELETE FROM provider_webhook_events WHERE provider_event_id = ${id}`;
  });
});

describe('settlement handling', () => {
  it('advances the intent and marks the event processed only after doing so', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref);
    const event = stripeEvent('payment_intent.succeeded', ref);

    const result = await handleStripeSettlementEvent(event);

    expect(result.outcome).toBe('applied');
    expect(String(result.intentId)).toBe(intentId);

    const intent = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    expect(intent[0].status).toBe('settled');
    expect((await eventRow(event.id))?.processing_status).toBe('processed');
  });

  it('records an unmapped financial event without settling it', async () => {
    const ref = nextRef('ch');
    const event = stripeEvent('charge.succeeded', ref);

    const result = await handleStripeSettlementEvent(event);

    expect(result.outcome).toBe('recorded_only');
    // Still durably stored — these are evidence during an investigation.
    expect((await eventRow(event.id))?.processing_status).toBe('processed');
  });

  it('does not mark an event processed when no intent matches', async () => {
    // The previous behaviour marked every financial event processed on arrival,
    // so an event referencing an unknown transfer looked handled forever.
    const event = stripeEvent('payment_intent.succeeded', nextRef());

    const result = await handleStripeSettlementEvent(event);

    expect(result.outcome).toBe('no_matching_intent');
    expect(result.markedProcessed).toBe(false);
    const row = await eventRow(event.id);
    expect(row?.processing_status).toBe('failed');
    expect(row?.processing_error).toContain('INTENT_NOT_FOUND');
  });

  it('is idempotent across a duplicate delivery of the same event', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref);
    const event = stripeEvent('payment_intent.succeeded', ref);

    const first = await handleStripeSettlementEvent(event);
    const second = await handleStripeSettlementEvent(event);

    expect(first.outcome).toBe('applied');
    expect(second.outcome).toBe('duplicate_ignored');

    // Exactly one event row, and no second set of ledger entries.
    const events = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM provider_webhook_events
      WHERE provider = 'stripe' AND provider_event_id = ${event.id}
    `;
    expect(events[0].n).toBe(1);

    const ledger = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;
    const ledgerAfterTwoDeliveries = ledger[0].n;

    await handleStripeSettlementEvent(event);
    const ledgerAgain = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;
    expect(ledgerAgain[0].n).toBe(ledgerAfterTwoDeliveries);
  });

  it('rejects an out-of-order event rather than dragging the intent backwards', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref);

    await handleStripeSettlementEvent(stripeEvent('payment_intent.succeeded', ref));
    const settled = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    expect(settled[0].status).toBe('settled');

    // A `processing` notification delivered late must not un-settle it.
    const late = stripeEvent('payment_intent.processing', ref);
    const result = await handleStripeSettlementEvent(late);

    const after = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    // The invariant is that status never regresses. Whether the late event is
    // rejected outright or applied as a no-op is an implementation detail; both
    // are acceptable, silently un-settling the transfer is not.
    expect(after[0].status).toBe('settled');
    expect(result.markedProcessed || result.outcome === 'invalid_transition').toBe(true);
  });

  it('records a failure event against the intent', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref);

    const result = await handleStripeSettlementEvent(
      stripeEvent('payment_intent.payment_failed', ref),
    );

    const intent = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    // Whatever the transition rules permit, a failure must never leave the
    // intent looking settled.
    expect(intent[0].status).not.toBe('settled');
    expect(['applied', 'failed', 'recorded_only', 'invalid_transition']).toContain(result.outcome);
  });

  it('does not settle twice when two distinct event ids describe one outcome', async () => {
    // The blocker found in design review. Idempotency was keyed on
    // provider_event_id — the unique constraint on provider_webhook_events and
    // the ledger's UNIQUE(transfer_intent_id, provider_event_id, entry_type).
    // Both protect only against a redelivery of the same event. Stripe can emit
    // two distinct event ids for one PaymentIntent reaching one outcome, and
    // measured before the fix this credited the wallet twice: 25 then 50, with
    // two ledger entries.
    const ref = nextRef();
    const intentId = await createIntent(ref);
    await sql`UPDATE users SET balance_cad = 0 WHERE id = ${USER_ID}`;

    const a = await handleStripeSettlementEvent(
      stripeEvent('payment_intent.succeeded', ref, `evt_dbl_a_${Date.now()}`),
    );
    const afterA = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${USER_ID}
    `;
    const ledgerA = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;

    const b = await handleStripeSettlementEvent(
      stripeEvent('payment_intent.succeeded', ref, `evt_dbl_b_${Date.now()}`),
    );
    const afterB = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${USER_ID}
    `;
    const ledgerB = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;

    expect(a.outcome).toBe('applied');
    // The second event is recorded for audit but must move no money.
    expect(Number(afterB[0].balance_cad)).toBe(Number(afterA[0].balance_cad));
    expect(ledgerB[0].n).toBe(ledgerA[0].n);
    expect(b.outcome).toBe('no_change');
  });

  it('credits the wallet exactly once on a first settlement', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref, 'processing', 'add_money', 25);
    await sql`UPDATE users SET balance_cad = 0 WHERE id = ${USER_ID}`;

    await handleStripeSettlementEvent(stripeEvent('payment_intent.succeeded', ref));

    const user = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${USER_ID}
    `;
    const status = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    expect(status[0].status).toBe('settled');
    expect(Number(user[0].balance_cad)).toBe(25);
  });

  it('leaves financial values unchanged on a redelivery of the same event id', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref);
    await sql`UPDATE users SET balance_cad = 0 WHERE id = ${USER_ID}`;
    const event = stripeEvent('payment_intent.succeeded', ref);

    await handleStripeSettlementEvent(event);
    const first = await sql<{ balance_cad: number }[]>`SELECT balance_cad FROM users WHERE id = ${USER_ID}`;
    await handleStripeSettlementEvent(event);
    const second = await sql<{ balance_cad: number }[]>`SELECT balance_cad FROM users WHERE id = ${USER_ID}`;

    expect(Number(second[0].balance_cad)).toBe(Number(first[0].balance_cad));
    const ledger = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;
    expect(ledger[0].n).toBeLessThanOrEqual(1);
  });

  it('a failure event transitions to failed and credits nothing', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref);
    await sql`UPDATE users SET balance_cad = 0 WHERE id = ${USER_ID}`;

    await handleStripeSettlementEvent(stripeEvent('payment_intent.payment_failed', ref));

    const status = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    const user = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${USER_ID}
    `;
    expect(status[0].status).toBe('failed');
    expect(Number(user[0].balance_cad)).toBe(0);
  });

  it('charge.* never moves money or status', async () => {
    const ref = nextRef();
    const intentId = await createIntent(ref);
    await sql`UPDATE users SET balance_cad = 0 WHERE id = ${USER_ID}`;

    await handleStripeSettlementEvent(stripeEvent('charge.succeeded', ref));

    const status = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    const user = await sql<{ balance_cad: number }[]>`
      SELECT balance_cad FROM users WHERE id = ${USER_ID}
    `;
    const ledger = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;
    expect(status[0].status).toBe('processing');
    expect(Number(user[0].balance_cad)).toBe(0);
    expect(ledger[0].n).toBe(0);
  });

  it('keeps two different events for the same reference distinct', async () => {
    const ref = nextRef();
    await createIntent(ref);

    const a = stripeEvent('payment_intent.succeeded', ref, `evt_a_${Date.now()}`);
    const b = stripeEvent('payment_intent.succeeded', ref, `evt_b_${Date.now()}`);

    await handleStripeSettlementEvent(a);
    const second = await handleStripeSettlementEvent(b);

    // Distinct event ids are not duplicates of one another; the second is a
    // genuinely new delivery that the transition rules must judge on its own.
    expect(second.outcome).not.toBe('duplicate_ignored');

    const rows = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM provider_webhook_events
      WHERE provider_event_id IN (${a.id}, ${b.id})
    `;
    expect(rows[0].n).toBe(2);
  });
});
