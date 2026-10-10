-- Read-only verification that GET /api/migrate applied everything the
-- application reads. Makes no changes; safe to run against production.
--
-- Every row should read OK. A MISSING row means application code that reads
-- that object will raise 42703 (column) or 42P01 (table) at runtime.

-- ── 1. Tables ───────────────────────────────────────────────────────────────
SELECT
  t.name AS object,
  CASE WHEN c.table_name IS NULL THEN 'MISSING' ELSE 'OK' END AS status
FROM (VALUES
  ('velocity_checks'), ('audit_logs'), ('fx_rates'),
  ('notifications'), ('provider_webhook_events'),
  ('webhook_dead_letters'), ('ledger_entries'),
  ('password_reset_tokens'),
  -- TRANSFER_EVENTS_UPDATE cursor. Missing means the real Plaid Transfer
  -- webhook cannot persist its sync position and answers 500.
  ('plaid_transfer_event_cursors')
) AS t(name)
LEFT JOIN information_schema.tables c
  ON c.table_schema = 'public' AND c.table_name = t.name
ORDER BY 2 DESC, 1;

-- ── 2. Columns read by application code ─────────────────────────────────────
SELECT
  t.tbl || '.' || t.col AS object,
  CASE WHEN c.column_name IS NULL THEN 'MISSING' ELSE 'OK — ' || c.data_type END AS status
FROM (VALUES
  -- C1.4 dead-letter queue: written by markProviderEventFailed()
  ('provider_webhook_events', 'retry_count'),
  ('provider_webhook_events', 'dead_letter_at'),
  -- Milestone 2 correlation ids: filtered by the four admin services
  ('transfer_intents',        'correlation_id'),
  ('provider_webhook_events', 'correlation_id'),
  ('ledger_entries',          'correlation_id'),
  ('transactions',            'correlation_id'),
  -- JWT revocation: read on every authenticated request
  ('users',                   'token_version')
) AS t(tbl, col)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = t.col
ORDER BY 2 DESC, 1;

-- ── 3. Arbiter indexes for the two ON CONFLICT upserts ──────────────────────
-- Matched by shape, not by name. Both upserts name a column list rather than
-- a constraint, so PostgreSQL selects the arbiter by matching columns and
-- predicate — any unique index of the right shape works, whatever it is
-- called. lib/db.ts gets these from an inline UNIQUE (default name), while
-- app/api/migrate/route.ts creates them as fx_rates_pair_key and
-- velocity_checks_window_key, so a name check reports a false MISSING.
--
-- recordVelocity() upserts with `WHERE transaction_count >= 0`, which only a
-- PARTIAL unique index can arbitrate; a plain UNIQUE will NOT satisfy it.
SELECT
  'velocity_checks partial unique (recordVelocity upsert)' AS object,
  CASE WHEN COUNT(*) = 0 THEN 'MISSING — upsert will fail'
       ELSE 'OK — ' || string_agg(indexname, ', ') END AS status
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'velocity_checks'
  AND indexdef ILIKE '%UNIQUE%'
  AND indexdef ILIKE '%user_id%' AND indexdef ILIKE '%window_type%'
  AND indexdef ILIKE '%window_start%' AND indexdef ILIKE '%currency%'
  AND indexdef ILIKE '%transaction_count >= 0%'
UNION ALL
SELECT
  'fx_rates pair unique (getFxRate upsert)' AS object,
  CASE WHEN COUNT(*) = 0 THEN 'MISSING — upsert will fail'
       ELSE 'OK — ' || string_agg(indexname, ', ') END AS status
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'fx_rates'
  AND indexdef ILIKE '%UNIQUE%'
  AND indexdef ILIKE '%from_currency%' AND indexdef ILIKE '%to_currency%';

-- ── 4. What would have blocked those indexes ────────────────────────────────
-- Both should return zero rows. Any row here is a duplicate that a human must
-- resolve before the unique index can be created.
SELECT 'velocity_checks duplicate window' AS problem,
       user_id, window_type, window_start, currency, COUNT(*)
FROM velocity_checks
WHERE transaction_count >= 0
GROUP BY user_id, window_type, window_start, currency
HAVING COUNT(*) > 1;

SELECT 'fx_rates duplicate pair' AS problem,
       from_currency, to_currency, COUNT(*)
FROM fx_rates
GROUP BY from_currency, to_currency
HAVING COUNT(*) > 1;

-- ── 5. Money columns must be NUMERIC, never float ───────────────────────────
-- A REAL or DOUBLE PRECISION row here is a decimal-correctness problem:
-- run migrations/20260907_money_real_to_numeric.sql.
-- Driven from a VALUES list rather than selected out of information_schema:
-- a column that is absent entirely must report ABSENT, not vanish from the
-- result set and read as clean.
SELECT
  t.tbl || '.' || t.col AS object,
  CASE WHEN c.data_type IS NULL THEN 'ABSENT'
       WHEN c.data_type = 'numeric' THEN 'OK — numeric'
       ELSE 'WRONG TYPE — ' || upper(c.data_type) END AS status
FROM (VALUES
  ('users','balance'), ('users','balance_cad'), ('users','balance_usd'),
  ('transactions','amount'), ('transactions','sender_amount'),
  ('transactions','receiver_amount'), ('transfer_intents','amount')
) AS t(tbl, col)
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = t.col
ORDER BY 2 DESC, 1;
