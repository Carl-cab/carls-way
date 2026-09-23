/**
 * Phase B3.3: notification & velocity executors.
 *
 * Runs against a real PostgreSQL instance, because the defects these cover
 * are mismatches between the SQL in SettlementExecutor and the actual
 * tables — exactly what a mocked driver cannot catch.
 */
import { SettlementExecutor } from '../settlement/SettlementExecutor';
import type { SettlementPlan } from '../settlement/SettlementOrchestrator';
import { recordVelocity } from '../auth';
import { getSql, initializeSchema } from '../db';

const USER_ID = 9302;
const sql = getSql();
const executor = new SettlementExecutor();

let intentId: number;

function makePlan(overrides: Partial<SettlementPlan>): SettlementPlan {
  return {
    intentId: String(intentId),
    previousStatus: 'posted',
    nextStatus: 'settled',
    transition: 'posted→settled',
    provider: 'plaid',
    provider_event_id: 'evt_test_b33',
    provider_reference_id: 'trf_test_b33',
    correlationId: 'corr-b33',
    updateBalance: { shouldUpdate: false },
    createLedgerEntries: { shouldCreate: false },
    notifyUser: false,
    reverseVelocity: false,
    requiresManualReview: false,
    idempotent: false,
    reason: 'test plan',
    ...overrides,
  };
}

async function notificationCount(): Promise<number> {
  const rows = await sql`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ${USER_ID}`;
  return Number(rows[0].n);
}

async function dailyVelocityTotal(): Promise<number> {
  const rows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
    WHERE user_id = ${USER_ID} AND window_type = 'daily' AND currency = 'CAD'
  `;
  return Number(rows[0].total);
}

beforeAll(async () => {
  await initializeSchema();
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
    VALUES (${USER_ID}, 'B33 Tester', 'b33_tester', 'b33@example.test', 'x', 'CA', 'verified')
    ON CONFLICT (id) DO UPDATE SET kyc_status = 'verified'
  `;
  const rows = await sql`
    INSERT INTO transfer_intents (user_id, type, amount, currency, status, provider_reference_id)
    VALUES (${USER_ID}, 'add_money', 100.00, 'CAD', 'posted', 'trf_test_b33')
    RETURNING id
  `;
  intentId = Number(rows[0].id);
});

beforeEach(async () => {
  await sql`DELETE FROM notifications WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM velocity_checks WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM notifications WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM velocity_checks WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
});

describe('executeNotification', () => {
  it('does nothing when the plan does not require notification', async () => {
    const result = await executor.executeNotification(makePlan({ notifyUser: false }));
    expect(result.success).toBe(true);
    expect(result.notificationSent).toBe(false);
    expect(await notificationCount()).toBe(0);
  });

  it('creates a settled notification with amount, currency and intent link', async () => {
    const result = await executor.executeNotification(
      makePlan({ notifyUser: true, nextStatus: 'settled' })
    );
    expect(result.success).toBe(true);
    expect(result.notificationSent).toBe(true);

    const rows = await sql`
      SELECT type, title, message, related_entity_type, related_entity_id
      FROM notifications WHERE user_id = ${USER_ID}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('transfer_settled');
    expect(rows[0].title).toBe('Transfer settled');
    expect(rows[0].message).toContain('100.00 CAD');
    expect(rows[0].related_entity_type).toBe('transfer_intent');
    expect(rows[0].related_entity_id).toBe(intentId);
  });

  it('creates failed and returned notifications with the right types', async () => {
    const failed = await executor.executeNotification(
      makePlan({ notifyUser: true, nextStatus: 'failed' })
    );
    expect(failed.notificationSent).toBe(true);

    const returned = await executor.executeNotification(
      makePlan({ notifyUser: true, nextStatus: 'returned' })
    );
    expect(returned.notificationSent).toBe(true);

    const rows = await sql`
      SELECT type FROM notifications WHERE user_id = ${USER_ID} ORDER BY id
    `;
    expect(rows.map((r) => r.type)).toEqual(['transfer_failed', 'transfer_returned']);
  });

  it('returns failure (never throws) when the intent is missing', async () => {
    const result = await executor.executeNotification(
      makePlan({ notifyUser: true, intentId: '999999999' })
    );
    expect(result.success).toBe(false);
    expect(result.notificationSent).toBe(false);
    expect(result.error).toBe('INTENT_NOT_FOUND');
    expect(await notificationCount()).toBe(0);
  });
});

describe('executeVelocityReversal', () => {
  it('does nothing when the plan does not require reversal', async () => {
    await recordVelocity(USER_ID, 100, 'CAD');
    const before = await dailyVelocityTotal();

    const result = await executor.executeVelocityReversal(makePlan({ reverseVelocity: false }));

    expect(result.success).toBe(true);
    expect(result.velocityReversed).toBe(false);
    expect(await dailyVelocityTotal()).toBe(before);
  });

  it('reverses recorded velocity for a returned transfer', async () => {
    await recordVelocity(USER_ID, 100, 'CAD');
    expect(await dailyVelocityTotal()).toBe(100);

    const result = await executor.executeVelocityReversal(
      makePlan({ reverseVelocity: true, nextStatus: 'returned' })
    );

    expect(result.success).toBe(true);
    expect(result.velocityReversed).toBe(true);
    // Compensating rows net the window back to zero.
    expect(await dailyVelocityTotal()).toBe(0);
  });

  it('returns failure (never throws) when the intent is missing', async () => {
    const result = await executor.executeVelocityReversal(
      makePlan({ reverseVelocity: true, intentId: '999999999' })
    );
    expect(result.success).toBe(false);
    expect(result.velocityReversed).toBe(false);
    expect(result.error).toBe('INTENT_NOT_FOUND');
  });
});
