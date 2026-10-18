/**
 * `webhook_dead_letters.raw_payload` stores a JSONB document, not a string
 * scalar.
 *
 * Both writers of `provider_webhook_events.raw_payload` already bind correctly
 * (`sql.json`), so that column holds documents. The dead-letter path then took
 * the document back out, re-serialised it, and cast the text:
 *
 *   const payload = typeof row.raw_payload === 'string'
 *     ? row.raw_payload
 *     : JSON.stringify(row.raw_payload ?? null);
 *   ... VALUES (..., ${payload}::jsonb, ...)
 *
 * `postgres.js` returns a jsonb document as a JS object, so the `typeof` test
 * takes the `JSON.stringify` branch, and `::jsonb` applied to text that is
 * already a complete JSON document yields a **string scalar** — the same defect
 * the audit writers had, reached by a different route. An explicit cast does
 * not avoid it; that is exactly what makes this shape easy to write.
 *
 * Consequence: `webhook_dead_letters` is the operator-review queue, and every
 * SQL-side look into a dead-lettered payload (`raw_payload->>'id'`, a `@>`
 * filter, a path into `data.object`) returned NULL or no rows, silently.
 * Replay itself kept working because `parseStoredStripeEvent` tolerates the
 * string form — the same compensating reader that hid the audit defect.
 *
 * Legacy rows of either shape are read, not rewritten.
 *
 * These tests drive the real `recordProviderEvent` and
 * `markProviderEventFailed` against a real database. The bug is in what
 * PostgreSQL stores, so a mock cannot see it.
 */
import { getSql } from '../db';
import {
  recordProviderEvent,
  markProviderEventFailed,
  MAX_WEBHOOK_RETRIES,
} from '../provider-events';

const sql = getSql();

const RUN = `dlq-jsonb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PROVIDER = 'stripe';

/** Drive an event all the way to the dead-letter queue. */
async function deadLetter(eventId: string) {
  let outcome;
  for (let i = 0; i < MAX_WEBHOOK_RETRIES; i++) {
    outcome = await markProviderEventFailed(PROVIDER, eventId, 'synthetic failure');
  }
  return outcome;
}

afterAll(async () => {
  await sql`DELETE FROM webhook_dead_letters WHERE provider_event_id LIKE ${`${RUN}%`}`;
  await sql`DELETE FROM provider_webhook_events WHERE provider_event_id LIKE ${`${RUN}%`}`;
}, 60000);

describe('provider_webhook_events.raw_payload (already correct — guards against regression)', () => {
  it('recordProviderEvent stores a document', async () => {
    const eventId = `${RUN}-source`;
    await recordProviderEvent(PROVIDER, eventId, 'payment_intent.succeeded', {
      rawPayload: { id: 'evt_1', data: { object: { id: 'pi_1', amount: 500 } } },
    });

    const rows = await sql`
      SELECT jsonb_typeof(raw_payload) AS typ, raw_payload->>'id' AS id
      FROM provider_webhook_events
      WHERE provider = ${PROVIDER} AND provider_event_id = ${eventId}
    `;
    expect(rows[0].typ).toBe('object');
    expect(rows[0].id).toBe('evt_1');
  });
});

describe('webhook_dead_letters.raw_payload', () => {
  it('stores a document, so an operator can query a dead-lettered payload', async () => {
    const eventId = `${RUN}-dl`;
    await recordProviderEvent(PROVIDER, eventId, 'payment_intent.succeeded', {
      rawPayload: { id: 'evt_2', data: { object: { id: 'pi_2', amount: 750 } } },
    });

    const outcome = await deadLetter(eventId);
    expect(outcome?.deadLettered).toBe(true);

    const rows = await sql`
      SELECT
        jsonb_typeof(raw_payload)                AS typ,
        raw_payload->>'id'                       AS id,
        raw_payload#>>'{data,object,id}'         AS object_id,
        (raw_payload#>>'{data,object,amount}')::int AS amount
      FROM webhook_dead_letters
      WHERE provider = ${PROVIDER} AND provider_event_id = ${eventId}
    `;

    expect(rows).toHaveLength(1);
    // Was 'string' before the fix.
    expect(rows[0].typ).toBe('object');
    // All three were NULL before the fix.
    expect(rows[0].id).toBe('evt_2');
    expect(rows[0].object_id).toBe('pi_2');
    expect(rows[0].amount).toBe(750);
  });

  it('a containment filter over the dead-letter queue matches', async () => {
    const eventId = `${RUN}-contain`;
    await recordProviderEvent(PROVIDER, eventId, 'payment_intent.payment_failed', {
      rawPayload: { id: 'evt_3', type: 'payment_intent.payment_failed' },
    });
    await deadLetter(eventId);

    // `@>` cannot match an object operand against a string scalar, so this
    // returned zero rows before the fix regardless of the data.
    const rows = await sql`
      SELECT id FROM webhook_dead_letters
      WHERE provider_event_id = ${eventId}
        AND raw_payload @> ${sql.json({ type: 'payment_intent.payment_failed' })}
    `;
    expect(rows).toHaveLength(1);
  });

  it('normalizes a legacy string-scalar source row into a document', async () => {
    // A provider_webhook_events row in the shape an older writer could have
    // produced. The dead-letter path must not carry the double-encoding
    // forward.
    const eventId = `${RUN}-legacy`;
    const payload = { id: 'evt_4', data: { object: { id: 'pi_4' } } };
    await sql`
      INSERT INTO provider_webhook_events
        (provider, provider_event_id, event_type, raw_payload, processing_status)
      VALUES (${PROVIDER}, ${eventId}, 'legacy.event', ${JSON.stringify(payload)}, 'received')
    `;

    // Confirm the fixture really is the broken shape, so this cannot pass by
    // having accidentally written a correct row.
    const src = await sql`
      SELECT jsonb_typeof(raw_payload) AS typ FROM provider_webhook_events
      WHERE provider_event_id = ${eventId}
    `;
    expect(src[0].typ).toBe('string');

    await deadLetter(eventId);

    const rows = await sql`
      SELECT jsonb_typeof(raw_payload) AS typ, raw_payload#>>'{data,object,id}' AS object_id
      FROM webhook_dead_letters WHERE provider_event_id = ${eventId}
    `;
    expect(rows[0].typ).toBe('object');
    expect(rows[0].object_id).toBe('pi_4');
  });

  it('preserves a legacy value that is not valid JSON rather than losing it', async () => {
    // A dead-letter entry is evidence for an operator. If the stored text
    // cannot be parsed it is kept verbatim as a jsonb string, not discarded.
    const eventId = `${RUN}-unparseable`;
    await sql`
      INSERT INTO provider_webhook_events
        (provider, provider_event_id, event_type, raw_payload, processing_status)
      VALUES (${PROVIDER}, ${eventId}, 'legacy.event', ${sql.json('not json at all')}, 'received')
    `;

    await deadLetter(eventId);

    const rows = await sql`
      SELECT jsonb_typeof(raw_payload) AS typ, raw_payload #>> '{}' AS text
      FROM webhook_dead_letters WHERE provider_event_id = ${eventId}
    `;
    expect(rows[0].typ).toBe('string');
    expect(rows[0].text).toBe('not json at all');
  });

  it('a NULL source payload stays NULL', async () => {
    const eventId = `${RUN}-null`;
    await recordProviderEvent(PROVIDER, eventId, 'payment_intent.succeeded');
    await deadLetter(eventId);

    const rows = await sql`
      SELECT raw_payload IS NULL AS is_null
      FROM webhook_dead_letters WHERE provider_event_id = ${eventId}
    `;
    expect(rows[0].is_null).toBe(true);
  });
});
