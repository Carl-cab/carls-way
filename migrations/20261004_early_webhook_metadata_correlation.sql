-- Manna Stripe early-webhook metadata correlation guard
--
-- Purpose:
--   Make the already-persisted transfer_intents.correlation_id structurally
--   unique, so a verified Stripe PaymentIntent metadata value can resolve at
--   most one local transfer during the provider-reference write window.
--
-- Safety properties:
--   * This migration does not create, enable, or call a payment provider.
--   * It does not alter live-rail flags (PLAID_TRANSFER_LIVE / CA_EFT_LIVE).
--   * It is read-only by default. DDL requires explicit -v apply=true.
--   * It refuses to create the index if duplicate non-null correlations exist;
--     the duplicates must be manually investigated rather than arbitrarily
--     deduplicated by a migration.
--   * The unique partial index permits legacy null values.
--
-- STATUS: maintenance-only. Do NOT execute against production without the
-- approved financial-schema maintenance procedure, verified backup/recovery,
-- application write drain, and explicit authorization.
--
-- Default read-only invocation:
--   psql -v ON_ERROR_STOP=1 \
--     -f migrations/20261004_early_webhook_metadata_correlation.sql "$DATABASE_URL"
--
-- Authorized maintenance invocation only:
--   psql -v ON_ERROR_STOP=1 -v apply=true \
--     -f migrations/20261004_early_webhook_metadata_correlation.sql "$DATABASE_URL"

\if :{?apply}
\else
\set apply false
\endif

-- ============================================================================
-- STAGE 1: Read-only preflight
-- ============================================================================
-- This must return zero rows before Stage 2 can safely add the unique index.
SELECT correlation_id, COUNT(*) AS transfer_count
FROM public.transfer_intents
WHERE correlation_id IS NOT NULL
GROUP BY correlation_id
HAVING COUNT(*) > 1
ORDER BY transfer_count DESC, correlation_id;

-- ============================================================================
-- STAGE 2: Authorized atomic DDL (requires -v apply=true)
-- ============================================================================
\if :apply
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

LOCK TABLE public.transfer_intents IN SHARE ROW EXCLUSIVE MODE;

DO $validate_correlation_index$
DECLARE
  duplicate_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO duplicate_count
  FROM (
    SELECT correlation_id
    FROM public.transfer_intents
    WHERE correlation_id IS NOT NULL
    GROUP BY correlation_id
    HAVING COUNT(*) > 1
  ) AS duplicate_correlations;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'Aborting early-webhook correlation guard: % duplicate non-null correlation_id value(s) require manual review',
      duplicate_count;
  END IF;
END
$validate_correlation_index$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_correlation_id
  ON public.transfer_intents(correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMIT;
\else
\echo 'Stage 2 skipped: no DDL executed. Re-run only after authorization with -v apply=true.'
\endif

-- ============================================================================
-- STAGE 3: Read-only verification
-- ============================================================================
SELECT
  indexname,
  indexdef,
  CASE
    WHEN indexdef LIKE '%UNIQUE INDEX%'
     AND indexdef LIKE '%(correlation_id)%'
     AND indexdef LIKE '%correlation_id IS NOT NULL%'
    THEN 'PASS'
    ELSE 'UNEXPECTED_DEFINITION'
  END AS verification_status
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'transfer_intents'
  AND indexname = 'idx_transfer_intents_correlation_id';
