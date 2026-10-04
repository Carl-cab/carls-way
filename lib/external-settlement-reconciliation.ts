import type postgres from 'postgres';
import { getSql } from '@/lib/db';

/** Aggregate-only operational controls; no raw identifiers leave the database. */
export const EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_NAMES = [
  'provider_settlement_events_in_scope',
  'provider_events_missing_intent',
  'external_intents_missing_provider_event',
  'settled_external_intents_missing_ledger',
  'settled_external_intents_missing_balance_confirmation',
  'open_webhook_dead_letters',
] as const;

export type ExternalSettlementReconciliationCheckName =
  (typeof EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_NAMES)[number];

export interface ExternalSettlementReconciliationCheck {
  checkName: ExternalSettlementReconciliationCheckName;
  observedCount: number;
  discrepancyCount: number;
  status: 'PASS' | 'FAIL';
}

export interface ExternalSettlementReconciliationResult {
  passed: boolean;
  checks: ExternalSettlementReconciliationCheck[];
}

interface DatabaseReconciliationRow {
  check_name: string;
  observed_count: number | string;
  discrepancy_count: number | string;
  status: 'PASS' | 'FAIL';
}

/**
 * Reconcile only persisted evidence. In-flight transfers are eligible for the
 * missing-event control after seven calendar days without a status update;
 * this is an investigation threshold, NOT a provider settlement SLA. Terminal
 * settled intents are checked immediately. No provider calls or financial writes.
 *
 * The provider object/transfer ID is authoritative. Only if no intent has
 * that reference may a Stripe event use its verified object metadata's opaque
 * stripe_corr_<UUIDv4> value, and only if exactly one LIVE intent has persisted
 * that value and is not bound to a different reference. Request tracing
 * correlation_id is never a match key. Malformed metadata and ambiguous
 * references remain discrepancies; no user, bank, or amount guess is made.
 */
export async function reconcileExternalSettlements(
  executor: postgres.ISql = getSql(),
): Promise<ExternalSettlementReconciliationResult> {
  const rows = await executor<DatabaseReconciliationRow[]>`
    WITH live_intents AS (
      SELECT id, type, amount, currency, status, provider_name,
             provider_reference_id, correlation_id, updated_at
      FROM transfer_intents
      WHERE execution_mode = 'live'
        AND provider_name IN ('canadian_eft', 'plaid_transfer')
    ),
    raw_events AS (
      SELECT e.provider, e.provider_event_id, e.event_type,
             e.balance_processed_at,
             e.related_provider_reference AS stored_reference,
             -- Historical writers passed JSON.stringify(payload) to a JSONB
             -- parameter, which stores a JSON *string*. New writers use
             -- sql.json(payload) and store an object. Normalize both durable
             -- representations before extracting a provider reference; never
             -- fall back to user, amount, or timestamp matching.
             CASE WHEN jsonb_typeof(e.raw_payload) = 'string'
               THEN (e.raw_payload #>> '{}')::jsonb
               ELSE e.raw_payload
             END AS payload,
             CASE
               WHEN e.provider = 'stripe' AND e.event_type = 'payment_intent.succeeded' THEN 'settled'
               WHEN e.provider = 'plaid' AND e.event_type = 'TRANSFER.STATUS_UPDATE'
                 THEN LOWER(COALESCE((CASE WHEN jsonb_typeof(e.raw_payload) = 'string'
                   THEN (e.raw_payload #>> '{}')::jsonb ELSE e.raw_payload END) #>> '{data,status}', ''))
               ELSE NULL END AS outcome
      FROM provider_webhook_events e
      WHERE (e.provider = 'stripe' AND e.event_type IN (
        'payment_intent.succeeded', 'payment_intent.processing',
        'payment_intent.payment_failed', 'payment_intent.canceled'
      )) OR (e.provider = 'plaid' AND e.event_type = 'TRANSFER.STATUS_UPDATE')
    ),
    events AS (
      SELECT e.provider, e.provider_event_id, e.event_type, e.balance_processed_at,
             CASE WHEN e.provider = 'stripe' THEN e.payload #>> '{data,object,id}'
                  ELSE e.payload #>> '{data,transfer_id}' END AS payload_reference,
             e.stored_reference,
             e.payload #> '{data,object,metadata,manna_transfer_correlation_id}' AS metadata_value,
             e.payload #>> '{data,object,metadata,manna_transfer_correlation_id}' AS metadata_correlation,
             e.outcome
      FROM raw_events e
    ),
    matches AS (
      SELECT e.*,
             ref.id AS reference_intent_id,
             ref.candidate_count AS reference_candidates,
             corr.id AS correlation_intent_id,
             COALESCE(corr.candidate_count, 0) AS correlation_candidates,
             corr.references_compatible,
             -- JSON string only; a malformed metadata value cannot be ignored.
             (e.metadata_value IS NOT NULL AND (
               jsonb_typeof(e.metadata_value) <> 'string'
               OR e.metadata_correlation !~* '^stripe_corr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             )) AS invalid_metadata
      FROM events e
      LEFT JOIN LATERAL (
        SELECT MIN(i.id) AS id, COUNT(*) AS candidate_count
        FROM live_intents i
        WHERE i.provider_reference_id = e.payload_reference
          AND i.provider_name = CASE WHEN e.provider = 'stripe' THEN 'canadian_eft' ELSE 'plaid_transfer' END
      ) ref ON true
      LEFT JOIN LATERAL (
        SELECT MIN(i.id) AS id, COUNT(*) AS candidate_count,
               BOOL_AND(i.provider_reference_id IS NULL
                 OR i.provider_reference_id = e.payload_reference) AS references_compatible
        FROM live_intents i
        WHERE e.provider = 'stripe'
          AND i.provider_name = 'canadian_eft'
          AND i.correlation_id = e.metadata_correlation
          AND e.metadata_correlation ~* '^stripe_corr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ) corr ON true
    ),
    resolved AS (
      SELECT m.*,
        CASE
          WHEN m.payload_reference IS NULL OR m.payload_reference = ''
            OR (m.stored_reference IS NOT NULL AND m.provider = 'stripe'
                AND m.stored_reference <> m.payload_reference)
            OR m.invalid_metadata THEN NULL
          WHEN m.reference_candidates = 1 THEN m.reference_intent_id
          WHEN m.reference_candidates = 0
            AND m.provider = 'stripe' AND m.metadata_value IS NOT NULL
            AND m.correlation_candidates = 1 AND m.references_compatible
            THEN m.correlation_intent_id
          ELSE NULL
        END AS intent_id
      FROM matches m
    ),
    settled_intents AS (
      SELECT * FROM live_intents WHERE status = 'settled'
    ),
    per_settled AS (
      SELECT i.id, i.type, i.amount, i.currency,
             COUNT(le.id) AS ledger_count,
             COUNT(le.id) FILTER (WHERE le.account_type = 'wallet'
                 AND le.currency = i.currency
                 AND le.entry_type = CASE WHEN i.type = 'add_money' THEN 'add_money_settled'
                                          ELSE 'cash_out_settled' END
                 AND ((i.type = 'add_money' AND le.debit = i.amount AND le.credit = 0)
                   OR (i.type = 'cash_out' AND le.credit = i.amount AND le.debit = 0))) AS valid_ledger_count
      FROM settled_intents i
      LEFT JOIN ledger_entries le ON le.transfer_intent_id = i.id
        AND le.entry_type IN ('add_money_settled', 'cash_out_settled')
      GROUP BY i.id, i.type, i.amount, i.currency
    )
    SELECT 'provider_settlement_events_in_scope' AS check_name,
           COUNT(*)::bigint AS observed_count, 0::bigint AS discrepancy_count,
           'PASS' AS status FROM events
    UNION ALL
    SELECT 'provider_events_missing_intent', COUNT(*)::bigint,
           COUNT(*) FILTER (WHERE intent_id IS NULL)::bigint,
           CASE WHEN COUNT(*) FILTER (WHERE intent_id IS NULL) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM resolved
    UNION ALL
    SELECT 'external_intents_missing_provider_event', COUNT(*)::bigint,
           COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM resolved r WHERE r.intent_id = i.id
           ))::bigint,
           CASE WHEN COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM resolved r WHERE r.intent_id = i.id
           )) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM live_intents i
    WHERE i.status = 'settled'
       OR (i.status IN ('submitting', 'processing')
           AND i.updated_at < NOW() - INTERVAL '7 days')
    UNION ALL
    SELECT 'settled_external_intents_missing_ledger', COUNT(*)::bigint,
           COUNT(*) FILTER (WHERE ledger_count <> 1 OR valid_ledger_count <> 1)::bigint,
           CASE WHEN COUNT(*) FILTER (WHERE ledger_count <> 1 OR valid_ledger_count <> 1) = 0
                THEN 'PASS' ELSE 'FAIL' END
    FROM per_settled
    UNION ALL
    SELECT 'settled_external_intents_missing_balance_confirmation', COUNT(*)::bigint,
           COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM resolved r WHERE r.intent_id = i.id
               AND r.outcome IN ('settled', 'posted')
               AND r.balance_processed_at IS NOT NULL
           ))::bigint,
           CASE WHEN COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM resolved r WHERE r.intent_id = i.id
               AND r.outcome IN ('settled', 'posted')
               AND r.balance_processed_at IS NOT NULL
           )) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM settled_intents i
    UNION ALL
    SELECT 'open_webhook_dead_letters', COUNT(*)::bigint, COUNT(*)::bigint,
           CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM webhook_dead_letters WHERE requeued_at IS NULL
    ORDER BY check_name
  `;

  const byName = new Map(rows.map((row) => [row.check_name, row]));
  const checks = EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_NAMES.map((checkName) => {
    const row = byName.get(checkName);
    if (!row) return { checkName, observedCount: 0, discrepancyCount: 1, status: 'FAIL' as const };
    return {
      checkName,
      observedCount: Number(row.observed_count),
      discrepancyCount: Number(row.discrepancy_count),
      status: row.status,
    };
  });
  return { passed: checks.every((check) => check.status === 'PASS' && check.discrepancyCount === 0), checks };
}
