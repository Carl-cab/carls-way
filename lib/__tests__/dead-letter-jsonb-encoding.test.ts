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

  it('PRESERVES a legacy string-scalar source shape rather than repairing it', async () => {
    // The first version of this fix normalized a legacy string scalar into a
    // document on the way into the queue, which seemed like a free repair. It
    // is not: see the replay-equality test below. The source shape must be
    // carried across unchanged.
    const eventId = `${RUN}-legacy`;
    const payload = { id: 'evt_4', data: { object: { id: 'pi_4' } } };
    await sql`
      INSERT INTO provider_webhook_events
        (provider, provider_event_id, event_type, raw_payload, processing_status)
      VALUES (${PROVIDER}, ${eventId}, 'legacy.event', ${JSON.stringify(payload)}, 'received')
    `;

    // Confirm the fixture really is the legacy shape, so this cannot pass by
    // having accidentally written a correct row.
    const src = await sql`
      SELECT jsonb_typeof(raw_payload) AS typ FROM provider_webhook_events
      WHERE provider_event_id = ${eventId}
    `;
    expect(src[0].typ).toBe('string');

    await deadLetter(eventId);

    const rows = await sql`
      SELECT jsonb_typeof(raw_payload) AS typ, raw_payload #>> '{}' AS text
      FROM webhook_dead_letters WHERE provider_event_id = ${eventId}
    `;
    // Same shape as the source, not 'object'.
    expect(rows[0].typ).toBe('string');
    expect(JSON.parse(rows[0].text as string)).toEqual(payload);
  });
});

/**
 * The invariant that makes the shape question non-cosmetic.
 *
 * `claimDeadLetterForReplay` joins the queue row to its source row and
 * requires `dl.raw_payload IS NOT DISTINCT FROM e.raw_payload`
 * (`lib/webhooks/replay.ts`), deliberately, so a corrupt row cannot be
 * replayed under another event. That equality is between the two **stored**
 * representations, so any transformation applied to only one side silently
 * makes the event unreplayable — the claim returns no row and the caller sees
 * `not_found_or_already_replayed` rather than reaching recovery.
 *
 * Measured: with the queue copy normalized and the source left alone,
 * `IS NOT DISTINCT FROM` is false. These cases are the guard whose absence let
 * that regression be written in the first place, so they assert the invariant
 * directly rather than inferring it from the shape.
 */
describe('replay claim equality between the queue row and its source', () => {
  it('holds for a document payload', async () => {
    const eventId = `${RUN}-eq-doc`;
    await recordProviderEvent(PROVIDER, eventId, 'payment_intent.succeeded', {
      rawPayload: { id: 'evt_eq1', data: { object: { id: 'pi_eq1' } } },
    });
    await deadLetter(eventId);

    const rows = await sql`
      SELECT (dl.raw_payload IS NOT DISTINCT FROM e.raw_payload) AS matches
      FROM webhook_dead_letters dl
      JOIN provider_webhook_events e
        ON e.provider = dl.provider AND e.provider_event_id = dl.provider_event_id
      WHERE dl.provider_event_id = ${eventId}
    `;
    expect(rows[0].matches).toBe(true);
  });

  it('holds for a legacy string-scalar payload', async () => {
    const eventId = `${RUN}-eq-legacy`;
    await sql`
      INSERT INTO provider_webhook_events
        (provider, provider_event_id, event_type, raw_payload, processing_status)
      VALUES (
        ${PROVIDER}, ${eventId}, 'payment_intent.succeeded',
        ${JSON.stringify({ id: 'evt_eq2' })}, 'received'
      )
    `;
    await deadLetter(eventId);

    const rows = await sql`
      SELECT (dl.raw_payload IS NOT DISTINCT FROM e.raw_payload) AS matches
      FROM webhook_dead_letters dl
      JOIN provider_webhook_events e
        ON e.provider = dl.provider AND e.provider_event_id = dl.provider_event_id
      WHERE dl.provider_event_id = ${eventId}
    `;
    // False while the queue copy was being "repaired" into a document.
    expect(rows[0].matches).toBe(true);
  });

  it('holds for a NULL payload', async () => {
    const eventId = `${RUN}-eq-null`;
    await recordProviderEvent(PROVIDER, eventId, 'payment_intent.succeeded');
    await deadLetter(eventId);

    // IS NOT DISTINCT FROM is the reason a NULL payload is still claimable;
    // plain `=` would be NULL and the row would never match.
    const rows = await sql`
      SELECT (dl.raw_payload IS NOT DISTINCT FROM e.raw_payload) AS matches
      FROM webhook_dead_letters dl
      JOIN provider_webhook_events e
        ON e.provider = dl.provider AND e.provider_event_id = dl.provider_event_id
      WHERE dl.provider_event_id = ${eventId}
    `;
    expect(rows[0].matches).toBe(true);
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
