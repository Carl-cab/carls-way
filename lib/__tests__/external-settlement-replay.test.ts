import { describe, expect, it, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { getSql, initializeSchema } from '@/lib/db';
import { reconcileExternalSettlements } from '@/lib/external-settlement-reconciliation';
import { listDeadLetters } from '@/lib/webhooks/dlq';
import { replayDeadLetterForLocalSettlement } from '@/lib/webhooks/replay';

const sql = getSql();
const USER_ID = 9807;
let sequence = 0;

function nextId(prefix: string) {
  sequence += 1;
  return `${prefix}_${Date.now()}_${sequence}`;
}

async function createIntent(
  reference: string,
  status: string,
  options?: { executionMode?: 'live' | 'sandbox'; type?: 'add_money' | 'cash_out' },
): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO transfer_intents (
      user_id, type, amount, currency, status, provider_name, execution_mode, provider_reference_id
    ) VALUES (
      ${USER_ID}, ${options?.type ?? 'add_money'}, 25.00, 'CAD', ${status},
      'canadian_eft', ${options?.executionMode ?? 'live'}, ${reference}
    )
    RETURNING id
  `;
  return rows[0].id;
}

async function insertStripeSettlementEvent(
  eventId: string,
  reference: string,
  options?: { deadLetter?: boolean; balanceProcessed?: boolean },
): Promise<void> {
  const payload = {
    id: eventId,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: reference } },
  };
  await sql`
    INSERT INTO provider_webhook_events (
      provider, provider_event_id, event_type, related_provider_reference, raw_payload,
      processing_status, retry_count, dead_letter_at, balance_processed_at
    ) VALUES (
      'stripe', ${eventId}, 'payment_intent.succeeded', ${reference}, ${sql.json(payload)},
      ${options?.deadLetter ? 'dead_letter' : 'processed'},
      ${options?.deadLetter ? 5 : 0},
      ${options?.deadLetter ? new Date().toISOString() : null},
      ${options?.balanceProcessed ? new Date().toISOString() : null}
    )
  `;
  if (options?.deadLetter) {
    await sql`
      INSERT INTO webhook_dead_letters (
        provider, provider_event_id, event_type, raw_payload, failure_count, last_error
      ) VALUES (
        'stripe', ${eventId}, 'payment_intent.succeeded', ${sql.json(payload)}, 5, 'test failure'
      )
    `;
  }
}

async function cleanup() {
  await sql`DELETE FROM webhook_dead_letters WHERE provider = 'stripe' AND provider_event_id LIKE 'ext_recon_%'`;
  await sql`DELETE FROM provider_webhook_events WHERE provider = 'stripe' AND provider_event_id LIKE 'ext_recon_%'`;
  await sql`DELETE FROM ledger_entries WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM audit_logs WHERE action IN (
    'webhook_dead_lettered',
    'webhook_dead_letter_replay_queued'
  )`;
}

beforeAll(async () => {
  await initializeSchema();
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd)
    VALUES (${USER_ID}, 'External Recon Tester', 'external_recon_tester', 'external-recon@example.test', 'x', 'CA', 0, 0)
    ON CONFLICT (id) DO UPDATE SET balance_cad = 0, balance_usd = 0
  `;
}, 60000);

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
}, 60000);

describe('external provider settlement reconciliation', () => {
  it('passes for a clean live provider event, settled intent, ledger, and balance marker', async () => {
    const reference = nextId('pi_clean');
    const intentId = await createIntent(reference, 'settled');
    await insertStripeSettlementEvent(nextId('ext_recon_clean'), reference, { balanceProcessed: true });
    await sql`
      INSERT INTO ledger_entries (
        user_id, transfer_intent_id, currency, account_type, entry_type, debit, credit,
        provider, provider_reference, provider_event_id
      ) VALUES (
        ${USER_ID}, ${intentId}, 'CAD', 'wallet', 'add_money_settled', 25.00, 0,
        'stripe', ${reference}, 'ledger_clean'
      )
    `;

    const result = await reconcileExternalSettlements();

    expect(result.passed).toBe(true);
  });

  it('flags a provider settlement event with no matching transfer intent', async () => {
    await insertStripeSettlementEvent(nextId('ext_recon_missing_intent'), nextId('pi_missing'));

    const result = await reconcileExternalSettlements();

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      checkName: 'provider_events_missing_intent',
      discrepancyCount: 1,
      status: 'FAIL',
    }));
  });

  it('does not flag a newly in-flight external intent before the investigation age threshold', async () => {
    await createIntent(nextId('pi_unmatched'), 'processing');

    const result = await reconcileExternalSettlements();

    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      checkName: 'external_intents_missing_provider_event',
      observedCount: 0,
      discrepancyCount: 0,
      status: 'PASS',
    }));
  });

  it('flags an in-flight external intent older than seven days with no matched provider event', async () => {
    const intentId = await createIntent(nextId('pi_unmatched'), 'processing');
    await sql`
      UPDATE transfer_intents
      SET updated_at = NOW() - INTERVAL '8 days'
      WHERE id = ${intentId}
    `;

    const result = await reconcileExternalSettlements();

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      checkName: 'external_intents_missing_provider_event',
      discrepancyCount: 1,
      status: 'FAIL',
    }));
  });

  it('flags a settled live intent missing both ledger and balance completion evidence', async () => {
    const reference = nextId('pi_missing_effects');
    await createIntent(reference, 'settled');
    await insertStripeSettlementEvent(nextId('ext_recon_missing_effects'), reference);

    const result = await reconcileExternalSettlements();

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkName: 'settled_external_intents_missing_ledger',
        discrepancyCount: 1,
        status: 'FAIL',
      }),
      expect.objectContaining({
        checkName: 'settled_external_intents_missing_balance_confirmation',
        discrepancyCount: 1,
        status: 'FAIL',
      }),
    ]));
  });
});

describe('local verified settlement replay', () => {
  it('lists an open DLQ item, atomically transitions it through local settlement, and never makes an external HTTP call', async () => {
    const reference = nextId('pi_replay');
    const intentId = await createIntent(reference, 'processing');
    const eventId = nextId('ext_recon_replay');
    await insertStripeSettlementEvent(eventId, reference, { deadLetter: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const listed = await listDeadLetters();
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'stripe', providerEventId: eventId }),
    ]));

    const result = await replayDeadLetterForLocalSettlement('stripe', eventId, { requeuedBy: 'test' });

    expect(result).toMatchObject({ outcome: 'replayed', settlementOutcome: 'applied', markedProcessed: true });
    expect(fetchSpy).not.toHaveBeenCalled();

    const intent = await sql<{ status: string }[]>`
      SELECT status FROM transfer_intents WHERE id = ${intentId}
    `;
    expect(intent[0].status).toBe('settled');

    const replayed = await sql<{ processing_status: string; retry_count: number; balance_processed_at: string | null }[]>`
      SELECT processing_status, retry_count, balance_processed_at
      FROM provider_webhook_events
      WHERE provider = 'stripe' AND provider_event_id = ${eventId}
    `;
    expect(replayed[0]).toMatchObject({ processing_status: 'processed', retry_count: 0 });
    expect(replayed[0].balance_processed_at).not.toBeNull();
    expect((await listDeadLetters()).some((letter) => letter.providerEventId === eventId)).toBe(false);
    fetchSpy.mockRestore();
  });

  it('rejects a duplicate replay after the first claim without reapplying settlement', async () => {
    const reference = nextId('pi_duplicate');
    const intentId = await createIntent(reference, 'processing');
    const eventId = nextId('ext_recon_duplicate');
    await insertStripeSettlementEvent(eventId, reference, { deadLetter: true });

    expect((await replayDeadLetterForLocalSettlement('stripe', eventId)).outcome).toBe('replayed');
    expect((await replayDeadLetterForLocalSettlement('stripe', eventId)).outcome)
      .toBe('not_found_or_already_replayed');

    const ledger = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;
    expect(ledger[0].count).toBe(1);
  });
});
