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

// Only the ids this file creates. Everything below was `TRUNCATE
// provider_webhook_events`, which is two isolation faults in one statement on
// a suite that shares one database: it destroyed rows belonging to other test
// files, and it left this file's own rows behind for whoever ran next.
//
// The second fault is the one that bit. `external-settlement-replay.test.ts`
// counts stripe events in scope and expects the one it seeded; with
// `evt_dupe_3` still present it saw two and three of its assertions failed.
// On `master` that was invisible because `stripe-settlement.test.ts` deletes
// `provider_event_id LIKE 'evt_%'` for its own reasons and happened to run in
// between — one file's unrelated cleanup masking another file's leak, which
// holds only as long as nobody changes the file order. Adding two test files
// changed it.
//
// A scoped delete gives this file exactly what it needs — its own ids absent
// before each test — without touching a row it did not write.
const OWN_IDS = ['evt_dupe_1', 'evt_dupe_2', 'evt_dupe_3'];

async function removeOwnRows() {
  const sql = getSql();
  await sql`DELETE FROM provider_webhook_events WHERE provider_event_id IN ${sql(OWN_IDS)}`;
}

describe('recordProviderEvent duplicate detection', () => {
  beforeAll(ensureTable);

  beforeEach(removeOwnRows);
  afterAll(removeOwnRows);

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
