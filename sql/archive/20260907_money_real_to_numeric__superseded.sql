-- HISTORICAL / SUPERSEDED — DO NOT EXECUTE
--
-- This is the original 2026-09-07 draft of the Manna money precision migration.
-- It is retained solely for audit traceability. It is NOT an approved production
-- migration and must never be run against any database.
--
-- Why it is superseded:
--   * Its fixed 0.00001 float tolerance rejects legitimate FLOAT4 representations
--     at ordinary monetary magnitudes.
--   * It proposes automatic rounding/conversion for values where FLOAT4 cannot
--     safely distinguish adjacent cents; those rows require reconciliation.
--   * Financial type conversions require a separately reviewed maintenance
--     procedure with backups and a write drain.
--
-- Manna money precision migration (historical draft)
--
-- Original purpose:
--   Convert every persisted currency amount that is (or may historically have been)
--   REAL/FLOAT to NUMERIC(14,2), without silently rounding values that materially
--   differ from a cent value.
--
-- HISTORICAL OPERATING PROCEDURE — DO NOT FOLLOW OR EXECUTE THIS DRAFT
--   1. Take and verify a Neon point-in-time restore / backup before running.
--   2. Put the application in maintenance mode or drain writes. Stage 2 takes
--      ACCESS EXCLUSIVE locks and blocks wallet/payment writes while converting.
--   3. Run this script with psql -v ON_ERROR_STOP=1 -f ...
--   4. Review Stage 1 exceptions. If any exist, reconcile them before Stage 2.
--
-- The migration does not and cannot recover precision already lost while data was
-- stored as REAL. It preserves the currently stored value if it is within
-- FLOAT_NOISE_TOLERANCE of an exact cent; otherwise it aborts before conversion.

-- ================================================================
-- STAGE 1: Persist a preflight audit of material float-to-cent differences
-- ================================================================

CREATE TABLE IF NOT EXISTS money_precision_migration_exceptions (
  migration_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  stored_value NUMERIC,
  rounded_value NUMERIC(14,2),
  absolute_delta NUMERIC,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  PRIMARY KEY (migration_name, table_name, column_name, row_id)
);

DO $preflight$
DECLARE
  spec RECORD;
  column_type TEXT;
  migration_name CONSTANT TEXT := '20260907_money_real_to_numeric';
  -- Float4 representation noise at ordinary wallet values is expected to be far
  -- below one hundredth. Any larger discrepancy requires human reconciliation.
  float_noise_tolerance CONSTANT NUMERIC := 0.00001;
  max_numeric_14_2 CONSTANT NUMERIC := 999999999999.99;
BEGIN
  FOR spec IN
    SELECT *
    FROM (
      VALUES
        ('users',            'balance'),
        ('users',            'balance_cad'),
        ('users',            'balance_usd'),
        ('transactions',     'amount'),
        ('transactions',     'sender_amount'),
        ('transactions',     'receiver_amount'),
        ('transactions',     'fx_fee'),
        ('transfer_intents', 'amount'),
        ('splits',           'total_amount'),
        ('split_participants','amount_owed'),
        ('velocity_checks',  'total_amount'),
        ('ledger_entries',   'debit'),
        ('ledger_entries',   'credit')
    ) AS money_columns(table_name, column_name)
  LOOP
    SELECT c.data_type
    INTO column_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = spec.table_name
      AND c.column_name = spec.column_name;

    -- A missing table/column belongs to an older deployment and is handled by
    -- its normal schema bootstrap. NUMERIC columns already have exact decimal
    -- storage and need no preflight conversion.
    IF column_type IS NULL OR column_type NOT IN ('real', 'double precision') THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        INSERT INTO public.money_precision_migration_exceptions (
          migration_name, table_name, column_name, row_id,
          stored_value, rounded_value, absolute_delta
        )
        SELECT
          %L,
          %L,
          %L,
          id::text,
          (%I::double precision)::numeric,
          ROUND((%I::double precision)::numeric, 2),
          ABS(
            (%I::double precision)::numeric -
            ROUND((%I::double precision)::numeric, 2)
          )
        FROM public.%I
        WHERE %I IS NOT NULL
          AND (
            %I::text IN ('NaN', 'Infinity', '-Infinity')
            OR ABS((%I::double precision)::numeric) > %L::numeric
            OR ABS(
              (%I::double precision)::numeric -
              ROUND((%I::double precision)::numeric, 2)
            ) > %L::numeric
          )
        ON CONFLICT (migration_name, table_name, column_name, row_id)
        DO UPDATE SET
          stored_value = EXCLUDED.stored_value,
          rounded_value = EXCLUDED.rounded_value,
          absolute_delta = EXCLUDED.absolute_delta,
          detected_at = NOW()
      $sql$,
      migration_name,
      spec.table_name,
      spec.column_name,
      spec.column_name,
      spec.column_name,
      spec.column_name,
      spec.column_name,
      spec.table_name,
      spec.column_name,
      spec.column_name,
      spec.column_name,
      max_numeric_14_2,
      spec.column_name,
      spec.column_name,
      float_noise_tolerance
    );
  END LOOP;
END
$preflight$;

-- Review this result before Stage 2. It must return zero rows.
SELECT
  table_name,
  column_name,
  row_id,
  stored_value,
  rounded_value,
  absolute_delta,
  detected_at
FROM money_precision_migration_exceptions
WHERE migration_name = '20260907_money_real_to_numeric'
  AND resolved_at IS NULL
ORDER BY absolute_delta DESC, table_name, column_name, row_id;

-- ================================================================
-- STAGE 2: Lock, revalidate, and convert
-- ================================================================
--
-- This block is atomic. If any conversion cannot be validated, the entire block
-- rolls back. The persisted Stage 1 exception audit remains available because it
-- was written before this transaction.

BEGIN;

DO $lock$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'transactions',
    'transfer_intents',
    'splits',
    'split_participants',
    'velocity_checks',
    'ledger_entries'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', table_name);
    END IF;
  END LOOP;
END
$lock$;

DO $convert$
DECLARE
  spec RECORD;
  column_type TEXT;
  unsafe_count BIGINT;
  float_noise_tolerance CONSTANT NUMERIC := 0.00001;
  max_numeric_14_2 CONSTANT NUMERIC := 999999999999.99;
BEGIN
  FOR spec IN
    SELECT *
    FROM (
      VALUES
        ('users',            'balance'),
        ('users',            'balance_cad'),
        ('users',            'balance_usd'),
        ('transactions',     'amount'),
        ('transactions',     'sender_amount'),
        ('transactions',     'receiver_amount'),
        ('transactions',     'fx_fee'),
        ('transfer_intents', 'amount'),
        ('splits',           'total_amount'),
        ('split_participants','amount_owed'),
        ('velocity_checks',  'total_amount'),
        ('ledger_entries',   'debit'),
        ('ledger_entries',   'credit')
    ) AS money_columns(table_name, column_name)
  LOOP
    SELECT c.data_type
    INTO column_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = spec.table_name
      AND c.column_name = spec.column_name;

    IF column_type IS NULL OR column_type NOT IN ('real', 'double precision') THEN
      CONTINUE;
    END IF;

    -- Recheck under the table lock so concurrent writes cannot introduce a
    -- fractional-cent or out-of-range value after Stage 1.
    EXECUTE format(
      $sql$
        SELECT COUNT(*)
        FROM public.%I
        WHERE %I IS NOT NULL
          AND (
            %I::text IN ('NaN', 'Infinity', '-Infinity')
            OR ABS((%I::double precision)::numeric) > %L::numeric
            OR ABS(
              (%I::double precision)::numeric -
              ROUND((%I::double precision)::numeric, 2)
            ) > %L::numeric
          )
      $sql$,
      spec.table_name,
      spec.column_name,
      spec.column_name,
      spec.column_name,
      max_numeric_14_2,
      spec.column_name,
      spec.column_name,
      float_noise_tolerance
    ) INTO unsafe_count;

    IF unsafe_count > 0 THEN
      RAISE EXCEPTION
        'Aborting money precision migration: %.% has % non-cent, non-finite, or out-of-range values. Review money_precision_migration_exceptions before retrying.',
        spec.table_name,
        spec.column_name,
        unsafe_count;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I TYPE NUMERIC(14,2) USING ROUND((%I::double precision)::numeric, 2)',
      spec.table_name,
      spec.column_name,
      spec.column_name
    );
  END LOOP;
END
$convert$;

-- Align defaults after type conversion. Dynamic checks keep this safe for
-- historical schemas that lack the legacy `users.balance` column.
DO $defaults$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT *
    FROM (
      VALUES
        ('users', 'balance',     '100.00::NUMERIC(14,2)'),
        ('users', 'balance_cad', '0.00::NUMERIC(14,2)'),
        ('users', 'balance_usd', '0.00::NUMERIC(14,2)')
    ) AS defaults_to_set(table_name, column_name, default_expression)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = spec.table_name
        AND column_name = spec.column_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT %s',
        spec.table_name,
        spec.column_name,
        spec.default_expression
      );
    END IF;
  END LOOP;

  FOR spec IN
    SELECT *
    FROM (VALUES ('transactions', 'amount'), ('transfer_intents', 'amount'))
      AS defaults_to_drop(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = spec.table_name
        AND column_name = spec.column_name
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP DEFAULT', spec.table_name, spec.column_name);
    END IF;
  END LOOP;
END
$defaults$;

COMMIT;

-- ================================================================
-- STAGE 3: Post-conversion verification
-- ================================================================

SELECT
  table_name,
  column_name,
  data_type,
  numeric_precision,
  numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name) IN (
    ('users', 'balance'),
    ('users', 'balance_cad'),
    ('users', 'balance_usd'),
    ('transactions', 'amount'),
    ('transactions', 'sender_amount'),
    ('transactions', 'receiver_amount'),
    ('transactions', 'fx_fee'),
    ('transfer_intents', 'amount'),
    ('splits', 'total_amount'),
    ('split_participants', 'amount_owed'),
    ('velocity_checks', 'total_amount'),
    ('ledger_entries', 'debit'),
    ('ledger_entries', 'credit')
  )
ORDER BY table_name, column_name;

-- This must return zero rows. It proves there is no active REAL/DOUBLE money
-- column among the enumerated settlement, wallet, transaction, split, velocity,
-- and ledger amounts.
SELECT
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type IN ('real', 'double precision')
  AND (table_name, column_name) IN (
    ('users', 'balance'),
    ('users', 'balance_cad'),
    ('users', 'balance_usd'),
    ('transactions', 'amount'),
    ('transactions', 'sender_amount'),
    ('transactions', 'receiver_amount'),
    ('transactions', 'fx_fee'),
    ('transfer_intents', 'amount'),
    ('splits', 'total_amount'),
    ('split_participants', 'amount_owed'),
    ('velocity_checks', 'total_amount'),
    ('ledger_entries', 'debit'),
    ('ledger_entries', 'credit')
  );
