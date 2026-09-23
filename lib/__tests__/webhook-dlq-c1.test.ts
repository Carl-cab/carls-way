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
import { listDeadLetters, requeueDeadLetter } from '../webhooks/dlq';
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

async function cleanEvent(id: string): Promise<void> {
  await sql`DELETE FROM webhook_dead_letters WHERE provider = ${PROVIDER} AND provider_event_id = ${id}`;
  await sql`DELETE FROM provider_webhook_events WHERE provider = ${PROVIDER} AND provider_event_id = ${id}`;
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
      lastError: `boom ${MAX_WEBHOOK_RETRIES}`,
    });
    expect(mine[0].rawPayload).toMatchObject({ webhook_id: 'evt-dl' });

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
    expect(mine[0].lastError).toBe(`boom ${MAX_WEBHOOK_RETRIES + 1}`);
  });

  it('reports recorded=false for an unknown event instead of throwing', async () => {
    const outcome = await markProviderEventFailed(PROVIDER, 'evt-ghost', 'boom');
    expect(outcome).toEqual({ recorded: false, retryCount: 0, deadLettered: false });
  });
});

describe('requeueDeadLetter', () => {
  async function deadLetter(id: string): Promise<void> {
    await seedEvent(id);
    for (let i = 0; i < MAX_WEBHOOK_RETRIES; i++) {
      await markProviderEventFailed(PROVIDER, id, 'boom');
    }
  }

  it('resets the event for reprocessing and retires the DLQ entry', async () => {
    await deadLetter('evt-requeue');

    const ok = await requeueDeadLetter(PROVIDER, 'evt-requeue', { requeuedBy: 'test' });
    expect(ok).toBe(true);

    const row = await eventRow('evt-requeue');
    expect(row?.processing_status).toBe('received');
    expect(row?.retry_count).toBe(0);
    expect(row?.dead_letter_at).toBeNull();

    // Gone from the open queue, still in history.
    expect((await listDeadLetters()).filter((l) => l.providerEventId === 'evt-requeue')).toHaveLength(0);
    const history = (await listDeadLetters({ includeRequeued: true })).filter(
      (l) => l.providerEventId === 'evt-requeue'
    );
    expect(history).toHaveLength(1);
    expect(history[0].requeuedAt).not.toBeNull();

    const audits = await sql`
      SELECT metadata FROM audit_logs WHERE action = 'webhook_dead_letter_requeued'
    `;
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('counts failures from zero again after a requeue', async () => {
    await deadLetter('evt-recount');
    await requeueDeadLetter(PROVIDER, 'evt-recount');

    const outcome = await markProviderEventFailed(PROVIDER, 'evt-recount', 'boom again');
    expect(outcome).toMatchObject({ recorded: true, retryCount: 1, deadLettered: false });
    expect((await eventRow('evt-recount'))?.processing_status).toBe('failed');
  });

  it('returns false when there is no open dead-letter entry', async () => {
    await seedEvent('evt-never-dl');
    expect(await requeueDeadLetter(PROVIDER, 'evt-never-dl')).toBe(false);
    expect(await requeueDeadLetter(PROVIDER, 'evt-ghost')).toBe(false);
  });

  it('cannot requeue the same entry twice', async () => {
    await deadLetter('evt-once');
    expect(await requeueDeadLetter(PROVIDER, 'evt-once')).toBe(true);
    expect(await requeueDeadLetter(PROVIDER, 'evt-once')).toBe(false);
  });
});
