import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  INTERNAL_RECONCILIATION_CHECK_NAMES,
  reconcileInternalTransactions,
} from '@/lib/internal-reconciliation';

function makeRows(overrides: Partial<Record<string, { discrepancies: number; status: 'PASS' | 'FAIL' }>> = {}) {
  return INTERNAL_RECONCILIATION_CHECK_NAMES.map((checkName) => {
    const override = overrides[checkName];
    return {
      check_name: checkName,
      observed_count: '3',
      discrepancy_count: String(override?.discrepancies ?? 0),
      status: override?.status ?? 'PASS',
    };
  });
}

function executorReturning(rows: ReturnType<typeof makeRows>): postgres.ISql {
  return vi.fn(async () => rows) as unknown as postgres.ISql;
}

describe('reconcileInternalTransactions', () => {
  it('passes only when every required database check reports zero discrepancies', async () => {
    const result = await reconcileInternalTransactions(executorReturning(makeRows()));

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(INTERNAL_RECONCILIATION_CHECK_NAMES.length);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkName: 'internal_payment_amounts_match_ledger',
          observedCount: 3,
          discrepancyCount: 0,
          status: 'PASS',
        }),
      ]),
    );
  });

  it('fails closed when the database reports a discrepancy', async () => {
    const result = await reconcileInternalTransactions(
      executorReturning(makeRows({ user_wallets_exactly_match_ledger: { discrepancies: 1, status: 'FAIL' } })),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      checkName: 'user_wallets_exactly_match_ledger',
      observedCount: 3,
      discrepancyCount: 1,
      status: 'FAIL',
    });
  });

  it('fails closed when an expected database invariant is missing from the query result', async () => {
    const rows = makeRows().filter((row) => row.check_name !== 'payment_ledger_pair_cardinality');
    const result = await reconcileInternalTransactions(executorReturning(rows));

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      checkName: 'payment_ledger_pair_cardinality',
      observedCount: 0,
      discrepancyCount: 1,
      status: 'FAIL',
    });
  });
});
