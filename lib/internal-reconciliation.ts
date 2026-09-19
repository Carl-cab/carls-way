import type postgres from 'postgres';
import { getSql } from '@/lib/db';

/**
 * Fixed reconciliation checks for internal P2P transactions. The names are
 * stable because cron audit records and operations runbooks rely on them.
 */
export const INTERNAL_RECONCILIATION_CHECK_NAMES = [
  'completed_internal_payments_in_scope',
  'payment_ledger_pair_cardinality',
  'payer_recipient_direction_currency_and_type',
  'internal_payment_amounts_match_ledger',
  'internal_ledger_entries_on_noncompleted_records',
  'user_wallets_exactly_match_ledger',
  'internal_ledger_currency_debits_equal_credits',
] as const;

export type InternalReconciliationCheckName =
  (typeof INTERNAL_RECONCILIATION_CHECK_NAMES)[number];

export interface InternalReconciliationCheck {
  checkName: InternalReconciliationCheckName;
  observedCount: number;
  discrepancyCount: number;
  status: 'PASS' | 'FAIL';
}

export interface InternalReconciliationResult {
  passed: boolean;
  checks: InternalReconciliationCheck[];
}

interface DatabaseReconciliationRow {
  check_name: string;
  observed_count: number | string;
  discrepancy_count: number | string;
  status: 'PASS' | 'FAIL';
}

/**
 * Run the deterministic, database-side reconciliation for all completed
 * internal P2P payments.
 *
 * The query deliberately compares PostgreSQL NUMERIC values directly. No
 * JavaScript money arithmetic or tolerance is used. It also includes both the
 * legacy `pay` transaction type and the current `payment` type so historical
 * production records cannot silently fall out of scope.
 *
 * The optional executor allows callers to include the result and its audit
 * record in the same database transaction.
 */
export async function reconcileInternalTransactions(
  executor: postgres.ISql = getSql(),
): Promise<InternalReconciliationResult> {
  const rows = await executor<DatabaseReconciliationRow[]>`
    WITH internal_payments AS (
      SELECT
        t.id,
        t.sender_id,
        t.receiver_id,
        COALESCE(t.sender_currency, t.currency) AS sender_currency,
        COALESCE(t.receiver_currency, t.currency) AS receiver_currency,
        COALESCE(t.sender_amount, t.amount) AS sender_amount,
        COALESCE(t.receiver_amount, t.amount) AS receiver_amount
      FROM transactions AS t
      WHERE t.payment_rail = 'internal'
        AND t.type IN ('pay', 'payment')
        AND t.status = 'completed'
    ),
    per_payment AS (
      SELECT
        p.id,
        p.sender_id,
        p.receiver_id,
        p.sender_currency,
        p.receiver_currency,
        p.sender_amount,
        p.receiver_amount,
        COUNT(le.id) AS wallet_ledger_entry_count,
        COUNT(le.id) FILTER (
          WHERE le.user_id = p.sender_id
            AND le.account_type = 'wallet'
            AND le.entry_type = 'payment_sent'
            AND le.currency = p.sender_currency
            AND le.debit > 0
            AND le.credit = 0
        ) AS valid_sender_debit_count,
        COUNT(le.id) FILTER (
          WHERE le.user_id = p.receiver_id
            AND le.account_type = 'wallet'
            AND le.entry_type = 'payment_received'
            AND le.currency = p.receiver_currency
            AND le.debit = 0
            AND le.credit > 0
        ) AS valid_receiver_credit_count,
        COALESCE(SUM(le.debit) FILTER (
          WHERE le.user_id = p.sender_id
            AND le.account_type = 'wallet'
            AND le.entry_type = 'payment_sent'
            AND le.currency = p.sender_currency
        ), 0) AS sender_debit_total,
        COALESCE(SUM(le.credit) FILTER (
          WHERE le.user_id = p.receiver_id
            AND le.account_type = 'wallet'
            AND le.entry_type = 'payment_received'
            AND le.currency = p.receiver_currency
        ), 0) AS receiver_credit_total,
        COUNT(le.id) FILTER (
          WHERE le.user_id NOT IN (p.sender_id, p.receiver_id)
             OR le.account_type <> 'wallet'
        ) AS unexpected_entry_count
      FROM internal_payments AS p
      LEFT JOIN ledger_entries AS le ON le.transaction_id = p.id
      GROUP BY
        p.id,
        p.sender_id,
        p.receiver_id,
        p.sender_currency,
        p.receiver_currency,
        p.sender_amount,
        p.receiver_amount
    ),
    user_wallets AS (
      SELECT
        u.id AS user_id,
        'CAD'::text AS currency,
        u.balance_cad AS wallet_balance,
        COALESCE(SUM(le.credit - le.debit) FILTER (
          WHERE le.currency = 'CAD' AND le.account_type = 'wallet'
        ), 0) AS ledger_balance
      FROM users AS u
      LEFT JOIN ledger_entries AS le ON le.user_id = u.id
      GROUP BY u.id, u.balance_cad

      UNION ALL

      SELECT
        u.id AS user_id,
        'USD'::text AS currency,
        u.balance_usd AS wallet_balance,
        COALESCE(SUM(le.credit - le.debit) FILTER (
          WHERE le.currency = 'USD' AND le.account_type = 'wallet'
        ), 0) AS ledger_balance
      FROM users AS u
      LEFT JOIN ledger_entries AS le ON le.user_id = u.id
      GROUP BY u.id, u.balance_usd
    ),
    internal_currency_totals AS (
      SELECT
        le.currency,
        COALESCE(SUM(le.debit), 0) AS total_debit,
        COALESCE(SUM(le.credit), 0) AS total_credit
      FROM ledger_entries AS le
      JOIN internal_payments AS p ON p.id = le.transaction_id
      WHERE le.account_type = 'wallet'
      GROUP BY le.currency
    )
    SELECT
      'completed_internal_payments_in_scope' AS check_name,
      COUNT(*)::bigint AS observed_count,
      0::bigint AS discrepancy_count,
      'PASS' AS status
    FROM internal_payments

    UNION ALL

    SELECT
      'payment_ledger_pair_cardinality',
      COUNT(*)::bigint,
      COUNT(*) FILTER (WHERE wallet_ledger_entry_count <> 2)::bigint,
      CASE WHEN COUNT(*) FILTER (WHERE wallet_ledger_entry_count <> 2) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM per_payment

    UNION ALL

    SELECT
      'payer_recipient_direction_currency_and_type',
      COUNT(*)::bigint,
      COUNT(*) FILTER (
        WHERE valid_sender_debit_count <> 1
           OR valid_receiver_credit_count <> 1
           OR unexpected_entry_count <> 0
      )::bigint,
      CASE WHEN COUNT(*) FILTER (
        WHERE valid_sender_debit_count <> 1
           OR valid_receiver_credit_count <> 1
           OR unexpected_entry_count <> 0
      ) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM per_payment

    UNION ALL

    SELECT
      'internal_payment_amounts_match_ledger',
      COUNT(*)::bigint,
      COUNT(*) FILTER (
        WHERE sender_debit_total IS DISTINCT FROM sender_amount
           OR receiver_credit_total IS DISTINCT FROM receiver_amount
      )::bigint,
      CASE WHEN COUNT(*) FILTER (
        WHERE sender_debit_total IS DISTINCT FROM sender_amount
           OR receiver_credit_total IS DISTINCT FROM receiver_amount
      ) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM per_payment

    UNION ALL

    SELECT
      'internal_ledger_entries_on_noncompleted_records',
      COUNT(le.id)::bigint,
      COUNT(le.id)::bigint,
      CASE WHEN COUNT(le.id) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM ledger_entries AS le
    JOIN transactions AS t ON t.id = le.transaction_id
    WHERE t.payment_rail = 'internal'
      AND (t.type NOT IN ('pay', 'payment') OR t.status <> 'completed')

    UNION ALL

    SELECT
      'user_wallets_exactly_match_ledger',
      COUNT(*)::bigint,
      COUNT(*) FILTER (WHERE wallet_balance IS DISTINCT FROM ledger_balance)::bigint,
      CASE WHEN COUNT(*) FILTER (WHERE wallet_balance IS DISTINCT FROM ledger_balance) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM user_wallets

    UNION ALL

    SELECT
      'internal_ledger_currency_debits_equal_credits',
      COUNT(*)::bigint,
      COUNT(*) FILTER (WHERE total_debit IS DISTINCT FROM total_credit)::bigint,
      CASE WHEN COUNT(*) FILTER (WHERE total_debit IS DISTINCT FROM total_credit) = 0 THEN 'PASS' ELSE 'FAIL' END
    FROM internal_currency_totals

    ORDER BY check_name
  `;

  const byName = new Map(rows.map((row) => [row.check_name, row]));
  const checks = INTERNAL_RECONCILIATION_CHECK_NAMES.map((checkName) => {
    const row = byName.get(checkName);

    // A missing summary row is a monitoring failure, not a pass. This prevents
    // a future query edit from accidentally dropping an invariant silently.
    if (!row) {
      return {
        checkName,
        observedCount: 0,
        discrepancyCount: 1,
        status: 'FAIL' as const,
      };
    }

    return {
      checkName,
      observedCount: Number(row.observed_count),
      discrepancyCount: Number(row.discrepancy_count),
      status: row.status,
    };
  });

  return {
    passed: checks.every((check) => check.status === 'PASS' && check.discrepancyCount === 0),
    checks,
  };
}
