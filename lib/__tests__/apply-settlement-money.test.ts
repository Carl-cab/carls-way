import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSql, initializeSchema } from '../db';
import { applySettlementAtomically } from '../settlement/apply-settlement';
import type { SettlementPlan } from '../settlement/SettlementOrchestrator';

const USER_ID = 9751;
const sql = getSql();
let intentId = '';

function settledPlan(overrides: Partial<SettlementPlan> = {}): SettlementPlan {
  return {
    intentId,
    previousStatus: 'processing',
    nextStatus: 'settled',
    transition: 'processing→settled',
    provider: 'stripe',
    provider_event_id: `evt_cent_${intentId}`,
    provider_reference_id: `pi_cent_${intentId}`,
    bind_provider_reference: false,
    correlationId: 'cent-precision',
    updateBalance: { shouldUpdate: true, currency: 'CAD', amount: '100.10', operation: 'add' },
    createLedgerEntries: {
      shouldCreate: true,
      entries: [{
        currency: 'CAD', debit: '0.00', credit: '100.10', entryType: 'transfer_settlement',
        description: 'Exact-cent settlement test',
      }],
    },
    notifyUser: false,
    reverseVelocity: false,
    requiresManualReview: false,
    idempotent: false,
    reason: 'Exact-cent settlement regression',
    ...overrides,
  };
}

beforeAll(async () => {
  await initializeSchema();
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd, kyc_status)
    VALUES (${USER_ID}, 'Settlement Cents', 'settlement_cents', 'settlement-cents@example.test', 'x', 'CA', '0.00', '0.00', 'verified')
    ON CONFLICT (id) DO UPDATE SET balance_cad = '0.00', balance_usd = '0.00'
  `;
});

beforeEach(async () => {
  await sql`DELETE FROM ledger_entries WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO transfer_intents (user_id, type, amount, currency, status, provider_reference_id)
    VALUES (${USER_ID}, 'add_money', '100.10', 'CAD', 'processing', 'pi_cent_test')
    RETURNING id
  `;
  intentId = rows[0].id;
  await sql`UPDATE users SET balance_cad = '0.00' WHERE id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM ledger_entries WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
});

describe('applySettlementAtomically money boundary', () => {
  it('applies a decimal-string plan exactly once with matching ledger and wallet cents', async () => {
    const first = await applySettlementAtomically(settledPlan());
    expect(first).toEqual({ applied: true, ledgerEntriesCreated: 1, balanceChanged: true });

    const balances = await sql<{ balance_cad: string }[]>`SELECT balance_cad FROM users WHERE id = ${USER_ID}`;
    const entries = await sql<{ debit: string; credit: string }[]>`
      SELECT debit, credit FROM ledger_entries WHERE transfer_intent_id = ${intentId}
    `;
    expect(balances[0].balance_cad).toBe('100.10');
    expect(entries).toEqual([{ debit: '0.00', credit: '100.10' }]);

    const duplicate = await applySettlementAtomically(settledPlan());
    expect(duplicate).toMatchObject({ applied: false, reason: 'already_applied', ledgerEntriesCreated: 0, balanceChanged: false });

    const count = await sql`SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}`;
    expect(count[0].n).toBe(1);
  });

  it('rolls back the status and ledger when an exact subtraction would overdraw', async () => {
    const plan = settledPlan({
      nextStatus: 'returned',
      transition: 'processing→returned',
      updateBalance: { shouldUpdate: true, currency: 'CAD', amount: '0.01', operation: 'subtract' },
      createLedgerEntries: {
        shouldCreate: true,
        entries: [{
          currency: 'CAD', debit: '0.01', credit: '0.00', entryType: 'transfer_returned',
          description: 'Exact-cent return test',
        }],
      },
    });

    await expect(applySettlementAtomically(plan)).rejects.toThrow('Settlement balance update could not be applied.');

    const intent = await sql<{ status: string }[]>`SELECT status FROM transfer_intents WHERE id = ${intentId}`;
    const ledgerCount = await sql`SELECT COUNT(*)::int AS n FROM ledger_entries WHERE transfer_intent_id = ${intentId}`;
    expect(intent[0].status).toBe('processing');
    expect(ledgerCount[0].n).toBe(0);
  });
});
