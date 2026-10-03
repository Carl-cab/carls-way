-- Manna transaction cross-border amount capacity alignment
--
-- Purpose:
--   Widen public.transactions.sender_amount and receiver_amount from
--   NUMERIC(12,2) to NUMERIC(14,2), aligning production with the current
--   application migration and test-schema contract.
--
-- Safety properties:
--   * Both source and target types use scale 2, so this migration cannot round
--     or otherwise change a stored cent value.
--   * It fails closed unless both columns are either NUMERIC(12,2) (upgrade
--     needed) or NUMERIC(14,2) (already complete).
--   * The two columns are changed in one transaction under one table lock; a
--     failure rolls back the entire DDL transaction.
--   * It is idempotent. A later approved retry verifies NUMERIC(14,2) and
--     performs no schema change.
--
-- STATUS: maintenance-only. This script is NOT run by application startup,
-- Vercel deployment, the authenticated /api/migrate route, or the daily cron.
--
-- AUTHORIZATION REQUIRED BEFORE APPLYING:
--   1. Verify a Neon point-in-time recovery / backup plan.
--   2. Drain application writers or place the application in maintenance mode.
--   3. Obtain explicit authorization for the production DDL change.
--
-- Default invocation is read-only:
--   psql -v ON_ERROR_STOP=1 -f migrations/20261003_widen_transactions_cross_border_amounts.sql "$DATABASE_URL"
--
-- Approved maintenance invocation (the only mode that performs DDL):
--   psql -v ON_ERROR_STOP=1 -v apply=true \
--     -f migrations/20261003_widen_transactions_cross_border_amounts.sql "$DATABASE_URL"
--
-- Optional psql variable (default: false). Any non-true value leaves Stage 2
-- skipped, so an accidental invocation cannot alter the production schema.
\if :{?apply}
\else
\set apply false
\endif

-- ============================================================================
-- STAGE 1: Read-only preflight
-- ============================================================================
-- Both rows must show NUMERIC with scale 2. NUMERIC(12,2) is ready to widen;
-- NUMERIC(14,2) means the migration has already completed.
WITH expected(column_name) AS (
  VALUES ('sender_amount'), ('receiver_amount')
)
SELECT
  expected.column_name,
  COALESCE(columns.data_type, 'MISSING') AS data_type,
  columns.numeric_precision,
  columns.numeric_scale,
  CASE
    WHEN columns.data_type = 'numeric'
     AND columns.numeric_precision = 12
     AND columns.numeric_scale = 2
    THEN 'READY_TO_WIDEN'
    WHEN columns.data_type = 'numeric'
     AND columns.numeric_precision = 14
     AND columns.numeric_scale = 2
    THEN 'ALREADY_WIDENED'
    ELSE 'BLOCKED_UNEXPECTED_SCHEMA'
  END AS preflight_status
FROM expected
LEFT JOIN information_schema.columns AS columns
  ON columns.table_schema = 'public'
 AND columns.table_name = 'transactions'
 AND columns.column_name = expected.column_name
ORDER BY expected.column_name;

-- ============================================================================
-- STAGE 2: Authorized atomic DDL (requires -v apply=true)
-- ============================================================================
\if :apply
BEGIN;

-- Fail rather than wait indefinitely for a lock or a DDL operation. The caller
-- must resolve active writers deliberately, not silently extend the change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.transactions IN ACCESS EXCLUSIVE MODE;

DO $validate_and_widen$
DECLARE
  sender_precision INTEGER;
  sender_scale INTEGER;
  receiver_precision INTEGER;
  receiver_scale INTEGER;
BEGIN
  SELECT numeric_precision, numeric_scale
    INTO sender_precision, sender_scale
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'transactions'
    AND column_name = 'sender_amount';

  SELECT numeric_precision, numeric_scale
    INTO receiver_precision, receiver_scale
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'transactions'
    AND column_name = 'receiver_amount';

  IF sender_precision IS NULL OR sender_scale IS NULL
     OR receiver_precision IS NULL OR receiver_scale IS NULL THEN
    RAISE EXCEPTION
      'Aborting capacity alignment: transactions.sender_amount and receiver_amount must both exist';
  END IF;

  IF sender_scale <> 2 OR receiver_scale <> 2
     OR sender_precision NOT IN (12, 14)
     OR receiver_precision NOT IN (12, 14) THEN
    RAISE EXCEPTION
      'Aborting capacity alignment: expected NUMERIC(12,2) or NUMERIC(14,2); found sender NUMERIC(%,%) and receiver NUMERIC(%,%)',
      sender_precision, sender_scale, receiver_precision, receiver_scale;
  END IF;

  IF sender_precision = 14 AND receiver_precision = 14 THEN
    RAISE NOTICE 'transactions.sender_amount and receiver_amount are already NUMERIC(14,2); no DDL applied';
    RETURN;
  END IF;

  -- This widens integer capacity only. The scale remains 2, so stored decimal
  -- values are preserved exactly and no USING expression is permitted here.
  ALTER TABLE public.transactions
    ALTER COLUMN sender_amount TYPE NUMERIC(14,2),
    ALTER COLUMN receiver_amount TYPE NUMERIC(14,2);
END
$validate_and_widen$;

-- Enforce the postcondition before committing. Any failure rolls back both
-- column changes together.
DO $verify_postcondition$
DECLARE
  wrong_columns TEXT;
BEGIN
  SELECT string_agg(column_name, ', ' ORDER BY column_name)
    INTO wrong_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'transactions'
    AND column_name IN ('sender_amount', 'receiver_amount')
    AND NOT (
      data_type = 'numeric'
      AND numeric_precision = 14
      AND numeric_scale = 2
    );

  IF wrong_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'Aborting capacity alignment: postcondition failed for transactions.%',
      wrong_columns;
  END IF;
END
$verify_postcondition$;

COMMIT;
\else
\echo 'Stage 2 skipped: no DDL executed. Re-run only after authorization with -v apply=true.'
\endif

-- ============================================================================
-- STAGE 3: Post-run evidence (read-only)
-- ============================================================================
-- After an authorized run, both rows must return NUMERIC(14,2). On a dry run,
-- this query records the current state without making any change.
SELECT
  column_name,
  data_type,
  numeric_precision,
  numeric_scale,
  CASE
    WHEN data_type = 'numeric'
     AND numeric_precision = 14
     AND numeric_scale = 2
    THEN 'PASS'
    ELSE 'NOT_YET_ALIGNED'
  END AS verification_status
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'transactions'
  AND column_name IN ('sender_amount', 'receiver_amount')
ORDER BY column_name;
