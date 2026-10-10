/**
 * TRANSFER_EVENTS_UPDATE syncs Plaid Transfer events from a persisted cursor.
 *
 * The webhook body never names a transfer. Settlement still goes through
 * applySettlementAtomically, against PostgreSQL, with the Plaid client mocked.
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getSql, initializeSchema } from '@/lib/db';
import {
  PLAID_TRANSFER_EVENT_CURSOR_ID,
  PLAID_TRANSFER_SYNC_MAX_PAGES,
  PLAID_TRANSFER_SYNC_PAGE_SIZE,
} from '@/lib/settlement/plaid-transfer-event-sync';

const verification = vi.hoisted(() => ({
  hash: '',
  fail: false,
  alg: 'ES256' as string,
  iat: 0,
}));

const plaid = vi.hoisted(() => ({
  transferEventSync: vi.fn(),
  inFlight: 0,
  maxInFlight: 0,
}));

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

vi.mock('@/lib/plaid', () => ({
  plaidClient: {
    transferEventSync: (...args: unknown[]) => plaid.transferEventSync(...args),
  },
}));

import { POST as plaidWebhook } from '@/app/api/webhooks/plaid/route';
import * as applySettlement from '@/lib/settlement/apply-settlement';

const sql = getSql();
const USER_ID = 9610;

interface SyncEvent {
  event_id: number;
  event_type: string;
  transfer_id: string;
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function plaidRequest(body: string, header: string | null = 'signed-jwt'): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': '203.0.113.77' });
  if (header !== null) headers.set('plaid-verification', header);
  return new NextRequest('https://manna.example.test/api/webhooks/plaid', {
    method: 'POST',
    headers,
    body,
  });
}

function eventsUpdateBody(): string {
  return JSON.stringify({
    webhook_type: 'TRANSFER',
    webhook_code: 'TRANSFER_EVENTS_UPDATE',
    environment: 'sandbox',
  });
}

function statusUpdate(transferId: string, status: string): string {
  return JSON.stringify({
    webhook_type: 'TRANSFER',
    webhook_code: 'STATUS_UPDATE',
    data: { transfer_id: transferId, status },
  });
}

function event(eventId: number, transferId: string, eventType: string): SyncEvent {
  return { event_id: eventId, event_type: eventType, transfer_id: transferId };
}

function page(events: SyncEvent[], hasMore: boolean) {
  return { data: { transfer_events: events, has_more: hasMore, request_id: 'req_test' } };
}

async function post(body: string): Promise<Response> {
  verification.hash = sha256(body);
  return plaidWebhook(plaidRequest(body));
}

async function plaidIntent(reference: string, status = 'processing', amount = 25): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO transfer_intents (
      user_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, provider_reference_id
    ) VALUES (
      ${USER_ID}, 'add_money', ${amount}, 'USD', ${status},
      'US', 'plaid_transfer', 'live', ${reference}
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

async function usdBalance(): Promise<string> {
  const rows = await sql<{ balance_usd: string }[]>`
    SELECT balance_usd::text AS balance_usd FROM users WHERE id = ${USER_ID}
  `;
  return rows[0].balance_usd;
}

async function cursorAfterId(): Promise<number> {
  const rows = await sql<{ after_id: string | number }[]>`
    SELECT after_id FROM plaid_transfer_event_cursors
    WHERE cursor_id = ${PLAID_TRANSFER_EVENT_CURSOR_ID}
  `;
  return Number(rows[0].after_id);
}

async function ledgerCount(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM ledger_entries WHERE user_id = ${USER_ID}
  `;
  return rows[0].n;
}

async function deleteSyncRows(): Promise<void> {
  await sql`
    DELETE FROM webhook_dead_letters
    WHERE provider = 'plaid'
      AND (
        provider_event_id LIKE 'plaid_transfer_event:%'
        OR provider_event_id LIKE 'plaid_transfer_events_update:%'
        OR provider_event_id IN (
          SELECT provider_event_id FROM provider_webhook_events
          WHERE provider = 'plaid' AND raw_payload::text LIKE '%plaid_sync_%'
        )
      )
  `;
  await sql`
    DELETE FROM provider_webhook_events
    WHERE provider = 'plaid'
      AND (
        provider_event_id LIKE 'plaid_transfer_event:%'
        OR provider_event_id LIKE 'plaid_transfer_events_update:%'
        OR related_provider_reference LIKE 'plaid_sync_%'
        OR raw_payload::text LIKE '%plaid_sync_%'
      )
  `;
}

beforeAll(async () => {
  await initializeSchema();
  await deleteSyncRows();
  await sql`DELETE FROM ledger_entries WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd)
    VALUES (
      ${USER_ID}, 'Plaid Sync', 'plaid_sync_user', 'plaid-sync@example.test', 'x', 'US', 0, 0
    )
  `;
  await sql`
    INSERT INTO plaid_transfer_event_cursors (cursor_id, after_id)
    VALUES (${PLAID_TRANSFER_EVENT_CURSOR_ID}, 0)
    ON CONFLICT (cursor_id) DO NOTHING
  `;
}, 60000);

beforeEach(async () => {
  verification.fail = false;
  verification.alg = 'ES256';
  verification.iat = Math.floor(Date.now() / 1000);
  verification.hash = '';
  plaid.inFlight = 0;
  plaid.maxInFlight = 0;
  plaid.transferEventSync.mockReset();
  await deleteSyncRows();
  await sql`DELETE FROM ledger_entries WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`UPDATE users SET balance_usd = 0, balance_cad = 0 WHERE id = ${USER_ID}`;
  await sql`
    UPDATE plaid_transfer_event_cursors
    SET after_id = 0, updated_at = NOW()
    WHERE cursor_id = ${PLAID_TRANSFER_EVENT_CURSOR_ID}
  `;
});

afterAll(async () => {
  await deleteSyncRows();
  await sql`DELETE FROM ledger_entries WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
  await sql`
    UPDATE plaid_transfer_event_cursors
    SET after_id = 0, updated_at = NOW()
    WHERE cursor_id = ${PLAID_TRANSFER_EVENT_CURSOR_ID}
  `;
}, 60000);

describe('Plaid TRANSFER_EVENTS_UPDATE', () => {
  it('rejects a missing or invalid signature before calling Plaid or moving the cursor', async () => {
    const reference = `plaid_sync_sig_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const body = eventsUpdateBody();

    const missing = await plaidWebhook(plaidRequest(body, null));
    expect(missing.status).toBe(400);

    verification.fail = true;
    const invalid = await post(body);
    expect(invalid.status).toBe(400);

    expect(plaid.transferEventSync).not.toHaveBeenCalled();
    expect(await cursorAfterId()).toBe(0);
    expect(await intentStatus(intentId)).toBe('processing');
    expect(await usdBalance()).toBe('0.00');
  });

  it('pages events, persists the cursor, and settles each intent once', async () => {
    const first = `plaid_sync_page_a_${Date.now()}`;
    const second = `plaid_sync_page_b_${Date.now()}`;
    const third = `plaid_sync_page_c_${Date.now()}`;
    const firstId = await plaidIntent(first);
    const secondId = await plaidIntent(second);
    const thirdId = await plaidIntent(third);
    const afterIds: number[] = [];

    plaid.transferEventSync.mockImplementation(async (req: { after_id: number; count: number }) => {
      afterIds.push(req.after_id);
      expect(req.count).toBe(PLAID_TRANSFER_SYNC_PAGE_SIZE);
      if (req.after_id === 0) {
        // Out of order on purpose: the cursor must follow event_id, not arrival order.
        return page([event(2, second, 'settled'), event(1, first, 'settled')], true);
      }
      if (req.after_id === 2) {
        return page([event(3, third, 'settled')], false);
      }
      throw new Error(`unexpected after_id ${req.after_id}`);
    });

    const res = await post(eventsUpdateBody());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true, synced: true });
    expect(afterIds).toEqual([0, 2]);
    expect(await cursorAfterId()).toBe(3);
    expect(await intentStatus(firstId)).toBe('settled');
    expect(await intentStatus(secondId)).toBe('settled');
    expect(await intentStatus(thirdId)).toBe('settled');
    expect(await usdBalance()).toBe('75.00');
    expect(await ledgerCount()).toBe(3);
  });

  it('does not apply a duplicate event id twice', async () => {
    const reference = `plaid_sync_dup_event_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    plaid.transferEventSync.mockResolvedValue(
      page([event(5, reference, 'settled'), event(5, reference, 'settled')], false),
    );

    const res = await post(eventsUpdateBody());
    expect(res.status).toBe(200);
    expect(await cursorAfterId()).toBe(5);
    expect(await intentStatus(intentId)).toBe('settled');
    expect(await usdBalance()).toBe('25.00');
    expect(await ledgerCount()).toBe(1);
  });

  it('syncs a second delivery from the persisted cursor and does not credit again', async () => {
    const reference = `plaid_sync_dup_hook_${Date.now()}`;
    await plaidIntent(reference);
    const afterIds: number[] = [];
    plaid.transferEventSync.mockImplementation(async (req: { after_id: number }) => {
      afterIds.push(req.after_id);
      if (req.after_id === 0) return page([event(4, reference, 'settled')], false);
      return page([], false);
    });

    const body = eventsUpdateBody();
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);
    expect(afterIds).toEqual([0, 4]);
    expect(await cursorAfterId()).toBe(4);
    expect(await usdBalance()).toBe('25.00');
    expect(await ledgerCount()).toBe(1);
  });

  it('marks a failed transfer failed without crediting the wallet', async () => {
    const reference = `plaid_sync_fail_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    plaid.transferEventSync.mockResolvedValue(page([event(6, reference, 'failed')], false));

    expect((await post(eventsUpdateBody())).status).toBe(200);
    expect(await intentStatus(intentId)).toBe('failed');
    expect(await usdBalance()).toBe('0.00');
    expect(await cursorAfterId()).toBe(6);
  });

  it('settles and then returns, reversing the wallet credit', async () => {
    const reference = `plaid_sync_return_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    plaid.transferEventSync.mockResolvedValue(
      page([event(7, reference, 'settled'), event(8, reference, 'returned')], false),
    );

    expect((await post(eventsUpdateBody())).status).toBe(200);
    expect(await intentStatus(intentId)).toBe('returned');
    expect(await usdBalance()).toBe('0.00');
    expect(await ledgerCount()).toBe(2);
    expect(await cursorAfterId()).toBe(8);
  });

  it('advances past an unmapped sweep and still settles the following transfer', async () => {
    const reference = `plaid_sync_sweep_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    plaid.transferEventSync.mockResolvedValue(
      page([event(9, '', 'swept'), event(10, reference, 'settled')], false),
    );

    expect((await post(eventsUpdateBody())).status).toBe(200);
    expect(await intentStatus(intentId)).toBe('settled');
    expect(await usdBalance()).toBe('25.00');
    expect(await cursorAfterId()).toBe(10);
  });

  it('keeps TRANSFER.STATUS_UPDATE settling without calling event sync', async () => {
    const reference = `plaid_sync_status_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const body = statusUpdate(reference, 'settled');

    const res = await post(body);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true, outcome: 'applied' });
    expect(plaid.transferEventSync).not.toHaveBeenCalled();
    expect(await intentStatus(intentId)).toBe('settled');
    expect(await usdBalance()).toBe('25.00');
    expect(await cursorAfterId()).toBe(0);
  });

  it('does not advance the cursor past a retryable settlement failure', async () => {
    const reference = `plaid_sync_retry_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const spy = vi
      .spyOn(applySettlement, 'applySettlementAtomically')
      .mockRejectedValueOnce(new Error('db blip'));
    plaid.transferEventSync.mockResolvedValue(page([event(11, reference, 'settled')], false));

    try {
      const res = await post(eventsUpdateBody());
      expect(res.status).toBe(500);
      expect(await cursorAfterId()).toBe(0);
      expect(await intentStatus(intentId)).toBe('processing');
      expect(await usdBalance()).toBe('0.00');
    } finally {
      spy.mockRestore();
    }
  });

  it('stops at the page cap, keeps the events it finished, and asks for a retry', async () => {
    const reference = `plaid_sync_cap_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    let calls = 0;
    plaid.transferEventSync.mockImplementation(async (req: { after_id: number }) => {
      calls += 1;
      return page([event(req.after_id + 1, reference, 'pending')], true);
    });

    const res = await post(eventsUpdateBody());
    expect(res.status).toBe(500);
    expect(calls).toBe(PLAID_TRANSFER_SYNC_MAX_PAGES);
    expect(await cursorAfterId()).toBe(PLAID_TRANSFER_SYNC_MAX_PAGES);
    expect(await intentStatus(intentId)).toBe('processing');
    expect(await usdBalance()).toBe('0.00');
  });

  it('serialises concurrent webhooks so the transfer is processed once', async () => {
    const reference = `plaid_sync_concurrent_${Date.now()}`;
    const intentId = await plaidIntent(reference);
    const afterIds: number[] = [];
    plaid.transferEventSync.mockImplementation(async (req: { after_id: number }) => {
      plaid.inFlight += 1;
      plaid.maxInFlight = Math.max(plaid.maxInFlight, plaid.inFlight);
      afterIds.push(req.after_id);
      await new Promise((resolve) => setTimeout(resolve, 80));
      plaid.inFlight -= 1;
      if (req.after_id === 0) return page([event(12, reference, 'settled')], false);
      return page([], false);
    });

    const body = eventsUpdateBody();
    const [first, second] = await Promise.all([post(body), post(body)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(plaid.maxInFlight).toBe(1);
    expect(afterIds).toEqual([0, 12]);
    expect(await cursorAfterId()).toBe(12);
    expect(await intentStatus(intentId)).toBe('settled');
    expect(await usdBalance()).toBe('25.00');
    expect(await ledgerCount()).toBe(1);
  });
});
