-- Manna money precision migration
--
-- Purpose:
--   Convert every persisted currency amount that is (or may historically have been)
--   REAL/FLOAT to NUMERIC(14,2), without silently rounding values that materially
--   differ from a cent value.
--
-- IMPORTANT OPERATING PROCEDURE
--   1. Take and verify a point-in-time restore / backup before running.
--   2. Put the application in maintenance mode or drain writes. Stage 2 takes
--      ACCESS EXCLUSIVE locks and blocks wallet/payment writes while converting.
--   3. Run this script with psql -v ON_ERROR_STOP=1 -f ...
--   4. Review Stage 1 exceptions. If any exist, reconcile them before Stage 2.
--
-- The migration does not and cannot recover precision already lost while data was
-- stored as REAL. It preserves the currently stored value when that value is the
-- float4 encoding of an exact cent amount; otherwise it aborts before conversion.
--
--
-- ── ON THE SAFETY TEST ──────────────────────────────────────────────────────
--
-- An earlier draft of this migration compared each stored value against its
-- rounded cent value and aborted when the difference exceeded a fixed absolute
-- tolerance of 0.00001. That test does not work on REAL columns, and would have
-- aborted the migration on ordinary production data.
--
-- float4 carries a 24-bit mantissa, so its representation error is proportional
-- to magnitude — roughly value * 6e-8 — not a fixed quantity. The fixed
-- tolerance is exceeded by any balance over a few hundred dollars. Measured
-- against realistic wallet values:
--
--     stored      true float4 value        delta        fixed 0.00001 test
--     --------------------------------------------------------------------
--       99.99      99.9899978637695     0.0000021       passes
--      512.40     512.400024414062     0.0000244       ABORTS
--     1234.56    1234.56005859375      0.0000586       ABORTS
--     9876.54    9876.5400390625       0.0000391       ABORTS
--   123456.78  123456.78125            0.00125         ABORTS
--
-- Five of ten realistic balances aborted. The test below replaces it with a
-- round-trip identity that is independent of magnitude:
--
--     stored_value <> ROUND(stored_value::numeric, 2)::real
--
-- Read it as: "re-encode the cent value as float4; is it the same bits?" If it
-- is, the stored value IS the float4 encoding of that cent amount and rounding
-- discards nothing. If it is not, the stored value was never a cent amount —
-- a third of a dollar, fractional cents, sub-cent dust — and a human must
-- decide what it should become. That is exactly the distinction the guard is
-- meant to draw, and it draws it at every magnitude.
--
-- Stage 1 additionally reports, without aborting, any value large enough that
-- float4 cannot represent cents at all (|value| >= 131072, where one unit in
-- the last place exceeds a cent). Those rows are already wrong in the database
-- and no conversion can repair them; aborting on them would only block the fix.

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
  severity TEXT NOT NULL DEFAULT 'blocking',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  PRIMARY KEY (migration_name, table_name, column_name, row_id)
);

-- Older runs of this migration created the table without `severity`.
ALTER TABLE money_precision_migration_exceptions
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'blocking';

DO $preflight$
DECLARE
  spec RECORD;
  column_type TEXT;
  migration_name CONSTANT TEXT := '20260907_money_real_to_numeric';
  max_numeric_14_2 CONSTANT NUMERIC := 999999999999.99;
  -- Above this magnitude one float4 ULP exceeds a cent, so the stored value
  -- cannot express cents no matter what we convert it to. Advisory only.
  cent_representable_limit CONSTANT NUMERIC := 131072;
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
          stored_value, rounded_value, absolute_delta, severity
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
          ),
          CASE
            WHEN ABS((%I::double precision)::numeric) >= %L::numeric
                 AND %I = ROUND((%I::double precision)::numeric, 2)::%s
            THEN 'advisory'
            ELSE 'blocking'
          END
        FROM public.%I
        WHERE %I IS NOT NULL
          AND (
            %I::text IN ('NaN', 'Infinity', '-Infinity')
            OR ABS((%I::double precision)::numeric) > %L::numeric
            OR ABS((%I::double precision)::numeric) >= %L::numeric
            -- Round-trip identity: is the stored value the float encoding of
            -- its own cent value? See the note at the top of this file.
            OR %I <> ROUND((%I::double precision)::numeric, 2)::%s
          )
        ON CONFLICT (migration_name, table_name, column_name, row_id)
        DO UPDATE SET
          stored_value = EXCLUDED.stored_value,
          rounded_value = EXCLUDED.rounded_value,
          absolute_delta = EXCLUDED.absolute_delta,
          severity = EXCLUDED.severity,
          detected_at = NOW()
      $sql$,
      migration_name,
      spec.table_name,
      spec.column_name,
      spec.column_name,                                   -- stored_value
      spec.column_name,                                   -- rounded_value
      spec.column_name, spec.column_name,                 -- absolute_delta
      spec.column_name, cent_representable_limit,         -- severity: magnitude
      spec.column_name, spec.column_name, column_type,    -- severity: round-trip
      spec.table_name,
      spec.column_name,
      spec.column_name,                                   -- NaN / Infinity
      spec.column_name, max_numeric_14_2,                 -- out of range
      spec.column_name, cent_representable_limit,         -- cents unrepresentable
      spec.column_name, spec.column_name, column_type     -- round-trip identity
    );
  END LOOP;
END
$preflight$;

-- Review this result before Stage 2. Rows with severity='blocking' must be
-- reconciled; Stage 2 refuses to run while any remain unresolved.
SELECT
  severity,
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
ORDER BY severity, absolute_delta DESC, table_name, column_name, row_id;

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
  locked_table TEXT;
BEGIN
  FOREACH locked_table IN ARRAY ARRAY[
    'users',
    'transactions',
    'transfer_intents',
    'splits',
    'split_participants',
    'velocity_checks',
    'ledger_entries'
  ]
  LOOP
    IF to_regclass('public.' || locked_table) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', locked_table);
    END IF;
  END LOOP;
END
$lock$;

DO $convert$
DECLARE
  spec RECORD;
  column_type TEXT;
  unsafe_count BIGINT;
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
    -- fractional-cent or out-of-range value after Stage 1. Values too large for
    -- float4 to express cents are NOT counted here: they are already imprecise
    -- in the database and blocking on them would prevent the repair.
    EXECUTE format(
      $sql$
        SELECT COUNT(*)
        FROM public.%I
        WHERE %I IS NOT NULL
          AND (
            %I::text IN ('NaN', 'Infinity', '-Infinity')
            OR ABS((%I::double precision)::numeric) > %L::numeric
            OR %I <> ROUND((%I::double precision)::numeric, 2)::%s
          )
      $sql$,
      spec.table_name,
      spec.column_name,
      spec.column_name,
      spec.column_name, max_numeric_14_2,
      spec.column_name, spec.column_name, column_type
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
