/**
 * Duplicate provider-webhook detection.
 *
 * Regression test: recordProviderEvent used to check `error.constraint` for the
 * unique-violation constraint name, but postgres.js exposes it as
 * `constraint_name`. The check was therefore always false, so a duplicate
 * webhook delivery was rethrown, the webhook answered 500, and the provider
 * retried the same event indefinitely.
 */
import { getSql } from '../db';
import { recordProviderEvent } from '../provider-events';

async function ensureTable() {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS provider_webhook_events (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      related_provider_reference TEXT,
      raw_payload JSONB,
      processing_status TEXT NOT NULL DEFAULT 'received',
      processing_error TEXT,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, provider_event_id)
    )
  `;
}

describe('recordProviderEvent duplicate detection', () => {
  beforeAll(ensureTable);

  beforeEach(async () => {
    const sql = getSql();
    await sql`TRUNCATE provider_webhook_events`;
  });

  it('returns true on first delivery', async () => {
    await expect(
      recordProviderEvent('stripe', 'evt_dupe_1', 'payment_intent.succeeded'),
    ).resolves.toBe(true);
  });

  it('returns false on duplicate delivery instead of throwing', async () => {
    await recordProviderEvent('stripe', 'evt_dupe_2', 'payment_intent.succeeded');
    await expect(
      recordProviderEvent('stripe', 'evt_dupe_2', 'payment_intent.succeeded'),
    ).resolves.toBe(false);
  });

  it('treats the same event id from different providers as distinct', async () => {
    await recordProviderEvent('stripe', 'evt_dupe_3', 'payment_intent.succeeded');
    await expect(
      recordProviderEvent('plaid', 'evt_dupe_3', 'TRANSFER_EVENTS_UPDATE'),
    ).resolves.toBe(true);
  });
});
