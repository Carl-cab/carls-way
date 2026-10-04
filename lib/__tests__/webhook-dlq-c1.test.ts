/**
 * C1.4: webhook dead-letter queue.
 *
 * Runs against real PostgreSQL: the retry-count transition, the partial
 * dead-letter insert, and the requeue reset are all database behaviour.
 */
import {
  recordProviderEvent,
  markProviderEventFailed,
  getProviderEvent,
  MAX_WEBHOOK_RETRIES,
} from '../provider-events';
import * as deadLetterQueue from '../webhooks/dlq';
import { listDeadLetters } from '../webhooks/dlq';
import { getSql, initializeSchema } from '../db';

const sql = getSql();
const PROVIDER = 'dlqtest';

async function eventRow(id: string) {
  return (await getProviderEvent(PROVIDER, id)) as {
    processing_status: string;
    retry_count: number;
    dead_letter_at: string | null;
  } | null;
}

async function seedEvent(id: string): Promise<void> {
  await recordProviderEvent(PROVIDER, id, 'TRANSFER.STATUS_UPDATE', {
    rawPayload: { webhook_id: id, amount: '12.34' },
  });
}

beforeAll(async () => {
  await initializeSchema();
});

beforeEach(async () => {
  await sql`DELETE FROM webhook_dead_letters WHERE provider = ${PROVIDER}`;
  await sql`DELETE FROM provider_webhook_events WHERE provider = ${PROVIDER}`;
  await sql`DELETE FROM audit_logs WHERE action IN ('webhook_dead_lettered', 'webhook_dead_letter_requeued')`;
});

afterAll(async () => {
  await sql`DELETE FROM webhook_dead_letters WHERE provider = ${PROVIDER}`;
  await sql`DELETE FROM provider_webhook_events WHERE provider = ${PROVIDER}`;
  await sql`DELETE FROM audit_logs WHERE action IN ('webhook_dead_lettered', 'webhook_dead_letter_requeued')`;
});

describe('markProviderEventFailed', () => {
  it(`keeps status 'failed' for the first ${MAX_WEBHOOK_RETRIES - 1} failures`, async () => {
    await seedEvent('evt-early');
    for (let i = 1; i < MAX_WEBHOOK_RETRIES; i++) {
      const outcome = await markProviderEventFailed(PROVIDER, 'evt-early', `boom ${i}`);
      expect(outcome).toMatchObject({ recorded: true, retryCount: i, deadLettered: false });
    }
    const row = await eventRow('evt-early');
    expect(row?.processing_status).toBe('failed');
    expect(row?.retry_count).toBe(MAX_WEBHOOK_RETRIES - 1);

    const letters = await listDeadLetters();
    expect(letters.filter((l) => l.providerEventId === 'evt-early')).toHaveLength(0);
  });

  it(`dead-letters on failure #${MAX_WEBHOOK_RETRIES} and preserves the payload`, async () => {
    await seedEvent('evt-dl');
    let outcome = await markProviderEventFailed(PROVIDER, 'evt-dl', 'boom');
    for (let i = 2; i <= MAX_WEBHOOK_RETRIES; i++) {
      outcome = await markProviderEventFailed(PROVIDER, 'evt-dl', `boom ${i}`);
    }

    expect(outcome).toMatchObject({ recorded: true, deadLettered: true, retryCount: MAX_WEBHOOK_RETRIES });

    const row = await eventRow('evt-dl');
    expect(row?.processing_status).toBe('dead_letter');
    expect(row?.dead_letter_at).not.toBeNull();

    const letters = await listDeadLetters();
    const mine = letters.filter((l) => l.providerEventId === 'evt-dl');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      provider: PROVIDER,
      eventType: 'TRANSFER.STATUS_UPDATE',
      failureCount: MAX_WEBHOOK_RETRIES,
    });
    expect(mine[0]).not.toHaveProperty('rawPayload');
    expect(mine[0]).not.toHaveProperty('lastError');
    const stored = await sql`
      SELECT raw_payload, last_error FROM webhook_dead_letters
      WHERE provider = ${PROVIDER} AND provider_event_id = 'evt-dl'
    `;
    const payload = typeof stored[0].raw_payload === 'string'
      ? JSON.parse(stored[0].raw_payload as string) : stored[0].raw_payload;
    expect(payload).toMatchObject({ webhook_id: 'evt-dl' });
    expect(stored[0].last_error).toBe(`boom ${MAX_WEBHOOK_RETRIES}`);

    const audits = await sql`
      SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'webhook_dead_lettered'
    `;
    expect(Number(audits[0].n)).toBeGreaterThanOrEqual(1);
  });

  it('refreshes rather than duplicates the DLQ entry on further failures', async () => {
    await seedEvent('evt-repeat');
    for (let i = 0; i < MAX_WEBHOOK_RETRIES + 2; i++) {
      await markProviderEventFailed(PROVIDER, 'evt-repeat', `boom ${i}`);
    }
    const letters = await listDeadLetters();
    const mine = letters.filter((l) => l.providerEventId === 'evt-repeat');
    expect(mine).toHaveLength(1);
    expect(mine[0].failureCount).toBe(MAX_WEBHOOK_RETRIES + 2);
    expect(mine[0]).not.toHaveProperty('lastError');
    const stored = await sql`
      SELECT last_error FROM webhook_dead_letters
      WHERE provider = ${PROVIDER} AND provider_event_id = 'evt-repeat'
    `;
    expect(stored[0].last_error).toBe(`boom ${MAX_WEBHOOK_RETRIES + 1}`);
  });

  it('reports recorded=false for an unknown event instead of throwing', async () => {
    const outcome = await markProviderEventFailed(PROVIDER, 'evt-ghost', 'boom');
    expect(outcome).toEqual({ recorded: false, retryCount: 0, deadLettered: false });
  });
});

describe('dead-letter safety', () => {
  it('does not export a generic requeue that bypasses verified local settlement', () => {
    expect(deadLetterQueue).not.toHaveProperty('requeueDeadLetter');
  });
});
