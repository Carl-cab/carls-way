import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
  EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_NAMES,
  reconcileExternalSettlements,
} from '@/lib/external-settlement-reconciliation';

function makeRows(
  overrides: Partial<Record<string, { discrepancies: number; status: 'PASS' | 'FAIL' }>> = {},
) {
  return EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_NAMES.map((checkName) => {
    const override = overrides[checkName];
    return {
      check_name: checkName,
      observed_count: '2',
      discrepancy_count: String(override?.discrepancies ?? 0),
      status: override?.status ?? 'PASS',
    };
  });
}

function executorReturning(rows: ReturnType<typeof makeRows>): postgres.ISql {
  return vi.fn(async () => rows) as unknown as postgres.ISql;
}

describe('reconcileExternalSettlements', () => {
  it('reports a clean provider-to-intent-to-ledger reconciliation', async () => {
    const result = await reconcileExternalSettlements(executorReturning(makeRows()));

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(EXTERNAL_SETTLEMENT_RECONCILIATION_CHECK_NAMES.length);
    expect(result.checks).toContainEqual({
      checkName: 'settled_external_intents_missing_balance_confirmation',
      observedCount: 2,
      discrepancyCount: 0,
      status: 'PASS',
    });
  });

  it('detects a provider settlement event with no matching intent', async () => {
    const result = await reconcileExternalSettlements(
      executorReturning(makeRows({ provider_events_missing_intent: { discrepancies: 1, status: 'FAIL' } })),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      checkName: 'provider_events_missing_intent',
      observedCount: 2,
      discrepancyCount: 1,
      status: 'FAIL',
    });
  });

  it('detects a live external intent with no matching provider settlement event', async () => {
    const result = await reconcileExternalSettlements(
      executorReturning(
        makeRows({ external_intents_missing_provider_event: { discrepancies: 1, status: 'FAIL' } }),
      ),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      checkName: 'external_intents_missing_provider_event',
      observedCount: 2,
      discrepancyCount: 1,
      status: 'FAIL',
    });
  });

  it('detects settled intents missing ledger or balance completion evidence', async () => {
    const result = await reconcileExternalSettlements(
      executorReturning(
        makeRows({
          settled_external_intents_missing_ledger: { discrepancies: 1, status: 'FAIL' },
          settled_external_intents_missing_balance_confirmation: { discrepancies: 1, status: 'FAIL' },
        }),
      ),
    );

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkName: 'settled_external_intents_missing_ledger', discrepancyCount: 1 }),
        expect.objectContaining({
          checkName: 'settled_external_intents_missing_balance_confirmation',
          discrepancyCount: 1,
        }),
      ]),
    );
  });

  it('fails closed if a required aggregate row is absent', async () => {
    const rows = makeRows().filter((row) => row.check_name !== 'open_webhook_dead_letters');
    const result = await reconcileExternalSettlements(executorReturning(rows));

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({
      checkName: 'open_webhook_dead_letters',
      observedCount: 0,
      discrepancyCount: 1,
      status: 'FAIL',
    });
  });
});
