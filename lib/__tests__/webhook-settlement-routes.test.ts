/**
 * Webhook routes drive settlement.
 *
 * Signature verification is exercised on the route. Settlement itself runs
 * against PostgreSQL: the assertion that matters is the intent status, the
 * wallet, and that a second delivery does not apply the money again.
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getSql, initializeSchema } from '@/lib/db';
import { mapPlaidTransferStatus } from '@/lib/settlement/plaid-event-adapter';

const verification = vi.hoisted(() => {
  // The Stripe route reads STRIPE_WEBHOOK_SECRET at module load, so it has to
  // be set before that module is imported.
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_route_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_route_test_key';
  return {
    hash: '',
    fail: false,
    alg: 'ES256' as string,
    iat: 0,
  };
});

vi.mock('jose', () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: vi.fn(async () => {
    if (verification.fail) throw new Error('signature rejected');
    return {
      payload: {
        iat: verification.iat,
        request_body_sha256: verification.hash,
      },
      protectedHeader: { alg: verification.alg },
    };
  }),
}));

vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: (raw: string, signature: string, secret: string) => {
        if (signature !== 't=1,v1=valid' || secret !== 'whsec_route_test') {
          throw new Error('invalid signature');
        }
        return JSON.parse(raw);
      },
    },
  }),
}));

import { POST as plaidWebhook } from '@/app/api/webhooks/plaid/route';
import { POST as stripeWebhook } from '@/app/api/webhooks/stripe/route';

const sql = getSql();
const PLAID_USER = 9602;
const STRIPE_USER = 9603;

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function plaidRequest(body: string, header: string | null = 'signed-jwt'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': '203.0.113.40' });
  if (header !== null) headers.set('plaid-verification', header);
  return new NextRequest('https://manna.example.test/api/webhooks/plaid', {
    method: 'POST',
    headers,
    body,
  });
}

function stripeRequest(body: string, signature: string | null): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': '203.0.113.41' });
  if (signature !== null) headers.set('stripe-signature', signature);
  return new NextRequest('https://manna.example.test/api/webhooks/stripe', {
    method: 'POST',
    headers,
    body,
  });
}

async function plaidIntent(reference: string, status = 'processing', amount = 25): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO transfer_intents (
      user_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, provider_reference_id
    ) VALUES (
      ${PLAID_USER}, 'add_money', ${amount}, 'USD', ${status},
      'US', 'plaid_transfer', 'live', ${reference}
    )
    RETURNING id
  `;
  return String(rows[0].id);
}

async function stripeIntent(reference: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO transfer_intents (
      user_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, provider_reference_id
    ) VALUES (
      ${STRIPE_USER}, 'add_money', 25, 'CAD', 'processing',
      'CA', 'canadian_eft', 'sandbox', ${reference}
    )
    RETURNING id
  `;
  return String(rows[0].id);
}

async function intentStatus(id: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM transfer_intents WHERE id = ${id}
  `;
  return rows[0].status;
}

async function deleteWebhookRows(): Promise<void> {
  await sql`
    DELETE FROM webhook_dead_letters
    WHERE provider_event_id IN (
      SELECT provider_event_id FROM provider_webhook_events
      WHERE provider IN ('plaid', 'stripe')
        AND (
          raw_payload::text LIKE '%plaid_sig_%'
          OR raw_payload::text LIKE '%plaid_ok_%'
          OR raw_payload::text LIKE '%plaid_funds_%'
          OR raw_payload::text LIKE '%plaid_posted_%'
          OR raw_payload::text LIKE '%plaid_fail_%'
          OR raw_payload::text LIKE '%plaid_unknown_%'
          OR raw_payload::text LIKE '%plaid_twice_%'
          OR raw_payload::text LIKE '%plaid_return_%'
          OR raw_payload::text LIKE '%pi_sig_%'
          OR raw_payload::text LIKE '%pi_ok_%'
          OR raw_payload::text LIKE '%pi_fail_%'
          OR provider_event_id LIKE 'evt_sig_%'
          OR provider_event_id LIKE 'evt_ok_%'
          OR provider_event_id LIKE 'evt_fail_%'
        )
    )
  `;
  await sql`
    DELETE FROM provider_webhook_events
    WHERE provider IN ('plaid', 'stripe')
      AND (
        raw_payload::text LIKE '%plaid_sig_%'
        OR raw_payload::text LIKE '%plaid_ok_%'
        OR raw_payload::text LIKE '%plaid_funds_%'
        OR raw_payload::text LIKE '%plaid_posted_%'
        OR raw_payload::text LIKE '%plaid_fail_%'
        OR raw_payload::text LIKE '%plaid_unknown_%'
        OR raw_payload::text LIKE '%plaid_twice_%'
        OR raw_payload::text LIKE '%plaid_return_%'
        OR raw_payload::text LIKE '%pi_sig_%'
        OR raw_payload::text LIKE '%pi_ok_%'
        OR raw_payload::text LIKE '%pi_fail_%'
        OR provider_event_id LIKE 'evt_sig_%'
        OR provider_event_id LIKE 'evt_ok_%'
        OR provider_event_id LIKE 'evt_fail_%'
      )
  `;
}

async function usdBalance(): Promise<string> {
  const rows = await sql<{ balance_usd: string }[]>`
    SELECT balance_usd::text AS balance_usd FROM users WHERE id = ${PLAID_USER}
  `;
  return rows[0].balance_usd;
}

async function cadBalance(): Promise<string> {
  const rows = await sql<{ balance_cad: string }[]>`
    SELECT balance_cad::text AS balance_cad FROM users WHERE id = ${STRIPE_USER}
  `;
  return rows[0].balance_cad;
}

function statusUpdate(transferId: string, status: string, nonce = ''): string {
  return JSON.stringify({
    webhook_type: 'TRANSFER',
    webhook_code: 'STATUS_UPDATE',
    data: { transfer_id: transferId, status, nonce },
  });
}

beforeAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_route_test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_route_test_key';
  await initializeSchema();
  await deleteWebhookRows();
  await sql`DELETE FROM ledger_entries WHERE user_id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await sql`DELETE FROM transfer_intents WHERE user_id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await sql`DELETE FROM users WHERE id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd)
    VALUES
      (${PLAID_USER}, 'Plaid Webhook', 'plaid_webhook', 'plaid-webhook@example.test', 'x', 'US', 0, 0),
      (${STRIPE_USER}, 'Stripe Webhook', 'stripe_webhook', 'stripe-webhook@example.test', 'x', 'CA', 0, 0)
  `;
}, 60000);

beforeEach(async () => {
  verification.fail = false;
  verification.alg = 'ES256';
  verification.iat = Math.floor(Date.now() / 1000);
  verification.hash = '';
  await sql`DELETE FROM ledger_entries WHERE user_id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await sql`DELETE FROM transfer_intents WHERE user_id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await sql`UPDATE users SET balance_usd = 0, balance_cad = 0 WHERE id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await deleteWebhookRows();
});

afterAll(async () => {
  await deleteWebhookRows();
  await sql`DELETE FROM ledger_entries WHERE user_id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await sql`DELETE FROM transfer_intents WHERE user_id IN (${PLAID_USER}, ${STRIPE_USER})`;
  await sql`DELETE FROM users WHERE id IN (${PLAID_USER}, ${STRIPE_USER})`;
}, 60000);

describe('Plaid transfer status mapping', () => {
  it('maps terminal and in-flight statuses and refuses to guess', () => {
    expect(mapPlaidTransferStatus('settled')).toBe('settled');
    expect(mapPlaidTransferStatus('funds_available')).toBe('settled');
    expect(mapPlaidTransferStatus('failed')).toBe('failed');
    expect(mapPlaidTransferStatus('returned')).toBe('returned');
    expect(mapPlaidTransferStatus('cancelled')).toBe('cancelled');
    expect(mapPlaidTransferStatus('pending')).toBe('pending');
    expect(mapPlaidTransferStatus('posted')).toBe('pending');
    expect(mapPlaidTransferStatus('mystery')).toBeNull();
    expect(mapPlaidTransferStatus(undefined)).toBeNull();
  });
});

describe('Plaid TRANSFER.STATUS_UPDATE', () => {
  async function post(body: string): Promise<Response> {
    verification.hash = sha256(body);
    return plaidWebhook(plaidRequest(body));
  }

  it('rejects a missing or invalid signature before writing anything', async () => {
    const reference = `plaid_sig_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const body = statusUpdate(reference, 'settled');

    const missing = await plaidWebhook(plaidRequest(body, null));
    expect(missing.status).toBe(400);

    verification.fail = true;
    const invalid = await plaidWebhook(plaidRequest(body));
    expect(invalid.status).toBe(400);

    expect(await intentStatus(intentId)).toBe('processing');
    expect(await usdBalance()).toBe('0.00');
    const events = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM provider_webhook_events
      WHERE provider = 'plaid' AND related_provider_reference = ${reference}
    `;
    expect(events[0].n).toBe(0);
  });

  it('settles an add-money intent and credits the wallet once', async () => {
    const reference = `plaid_ok_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const body = statusUpdate(reference, 'settled');

    const res = await post(body);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true, outcome: 'applied' });
    expect(await intentStatus(intentId)).toBe('settled');
    expect(await usdBalance()).toBe('25.00');

    const again = await post(body);
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ received: true, duplicate: true });
    expect(await usdBalance()).toBe('25.00');
  });

  it('treats funds_available as settled and posted as still in flight', async () => {
    const availableRef = `plaid_funds_${Date.now()}`;
    const postedRef = `plaid_posted_${Date.now()}`;
    const availableId = await plaidIntent(availableRef);
    const postedId = await plaidIntent(postedRef);

    expect((await post(statusUpdate(availableRef, 'funds_available'))).status).toBe(200);
    expect(await intentStatus(availableId)).toBe('settled');
    expect(await usdBalance()).toBe('25.00');

    const posted = await post(statusUpdate(postedRef, 'posted'));
    await expect(posted.json()).resolves.toMatchObject({ outcome: 'no_change' });
    expect(await intentStatus(postedId)).toBe('processing');
    expect(await usdBalance()).toBe('25.00');
  });

  it('moves a failed transfer to failed without crediting the wallet', async () => {
    const reference = `plaid_fail_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const res = await post(statusUpdate(reference, 'failed'));
    await expect(res.json()).resolves.toMatchObject({ outcome: 'applied' });
    expect(await intentStatus(intentId)).toBe('failed');
    expect(await usdBalance()).toBe('0.00');
  });

  it('does not apply an unknown status', async () => {
    const reference = `plaid_unknown_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const res = await post(statusUpdate(reference, 'mystery'));
    await expect(res.json()).resolves.toMatchObject({ outcome: 'recorded_only' });
    expect(await intentStatus(intentId)).toBe('processing');
    expect(await usdBalance()).toBe('0.00');
  });

  it('credits once when two different deliveries both say settled', async () => {
    const reference = `plaid_twice_${Date.now()}`;
    await plaidIntent(reference);
    expect((await post(statusUpdate(reference, 'settled', 'a'))).status).toBe(200);
    const second = await post(statusUpdate(reference, 'settled', 'b'));
    await expect(second.json()).resolves.toMatchObject({ outcome: 'no_change' });
    expect(await usdBalance()).toBe('25.00');
    const ledger = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE user_id = ${PLAID_USER}
    `;
    expect(ledger[0].n).toBe(1);
  });

  it('returns a settled transfer and reverses the wallet credit', async () => {
    const reference = `plaid_return_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    await post(statusUpdate(reference, 'settled', 'settle'));
    expect(await usdBalance()).toBe('25.00');

    const returned = await post(statusUpdate(reference, 'returned', 'return'));
    await expect(returned.json()).resolves.toMatchObject({ outcome: 'applied' });
    expect(await intentStatus(intentId)).toBe('returned');
    expect(await usdBalance()).toBe('0.00');
  });
});

describe('Stripe ACSS webhook', () => {
  function event(type: string, objectId: string, eventId: string) {
    return JSON.stringify({
      id: eventId,
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: objectId } },
    });
  }

  it('rejects an invalid signature before settlement', async () => {
    const reference = `pi_sig_${Date.now()}`;
    const intentId = await stripeIntent(reference);
    const body = event('payment_intent.succeeded', reference, `evt_sig_${Date.now()}`);

    const missing = await stripeWebhook(stripeRequest(body, null));
    expect(missing.status).toBe(400);

    const invalid = await stripeWebhook(stripeRequest(body, 't=1,v1=nope'));
    expect(invalid.status).toBe(400);
    expect(await intentStatus(intentId)).toBe('processing');
    expect(await cadBalance()).toBe('0.00');
  });

  it('settles payment_intent.succeeded once, including a redelivery', async () => {
    const reference = `pi_ok_${Date.now()}`;
    const eventId = `evt_ok_${Date.now()}`;
    const intentId = await stripeIntent(reference);
    const body = event('payment_intent.succeeded', reference, eventId);

    const res = await stripeWebhook(stripeRequest(body, 't=1,v1=valid'));
    expect(res.status).toBe(200);
    expect(await intentStatus(intentId)).toBe('settled');
    expect(await cadBalance()).toBe('25.00');

    const again = await stripeWebhook(stripeRequest(body, 't=1,v1=valid'));
    expect(again.status).toBe(200);
    expect(await cadBalance()).toBe('25.00');
    const ledger = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ledger_entries WHERE user_id = ${STRIPE_USER}
    `;
    expect(ledger[0].n).toBe(1);
  });

  it('maps payment_intent.payment_failed onto failed and does not credit the wallet', async () => {
    const reference = `pi_fail_${Date.now()}`;
    const intentId = await stripeIntent(reference);
    const body = event('payment_intent.payment_failed', reference, `evt_fail_${Date.now()}`);
    const res = await stripeWebhook(stripeRequest(body, 't=1,v1=valid'));
    expect(res.status).toBe(200);
    expect(await intentStatus(intentId)).toBe('failed');
    expect(await cadBalance()).toBe('0.00');
  });
});
