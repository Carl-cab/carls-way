/**
 * C1.3: transfer timeout / recovery sweep.
 *
 * Runs against real PostgreSQL: the stuck-detection query, the partial
 * unique index on open flags, and the ON CONFLICT sweep path are all
 * database behaviour a mock cannot verify.
 */
import {
  findStuckTransfers,
  runTransferRecoverySweep,
  listOpenRecoveryFlags,
  RECOVERY_TIMEOUTS,
} from '../transfers/recovery';
import { getSql, initializeSchema } from '../db';

const USER_ID = 9402;
const sql = getSql();

async function createIntent(status: string, updatedAgo: string): Promise<number> {
  const rows = await sql`
    INSERT INTO transfer_intents (user_id, type, amount, currency, status, provider_reference_id)
    VALUES (${USER_ID}, 'add_money', 50.00, 'CAD', ${status}, ${`trf_c13_${status}_${Date.now()}`})
    RETURNING id
  `;
  const id = Number(rows[0].id);
  await sql`UPDATE transfer_intents SET updated_at = NOW() - ${updatedAgo}::interval WHERE id = ${id}`;
  return id;
}

async function intentStatus(id: number): Promise<string> {
  const rows = await sql`SELECT status FROM transfer_intents WHERE id = ${id}`;
  return rows[0].status as string;
}

beforeAll(async () => {
  await initializeSchema();
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
    VALUES (${USER_ID}, 'Recovery Tester', 'recovery_tester', 'recovery@example.test', 'x', 'CA', 'verified')
    ON CONFLICT (id) DO UPDATE SET kyc_status = 'verified'
  `;
});

beforeEach(async () => {
  await sql`DELETE FROM transfer_recovery_flags WHERE transfer_intent_id IN (SELECT id FROM transfer_intents WHERE user_id = ${USER_ID})`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM transfer_recovery_flags WHERE transfer_intent_id IN (SELECT id FROM transfer_intents WHERE user_id = ${USER_ID})`;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
});

describe('findStuckTransfers', () => {
  it('flags a submitting intent stuck past 30 minutes as retryable', async () => {
    await createIntent('submitting', '45 minutes');
    const stuck = await findStuckTransfers();
    const mine = stuck.filter((t) => t.userId === USER_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0].recoveryAction).toBe('retry_execute');
    expect(mine[0].stuckMinutes).toBeGreaterThanOrEqual(45);
  });

  it('ignores a submitting intent that is still fresh', async () => {
    await createIntent('submitting', '5 minutes');
    const stuck = await findStuckTransfers();
    expect(stuck.filter((t) => t.userId === USER_ID)).toHaveLength(0);
  });

  it('flags a posted intent stuck past 24h for manual review, not a fresh one', async () => {
    await createIntent('posted', '25 hours');
    await createIntent('posted', '1 hour');
    const stuck = await findStuckTransfers();
    const mine = stuck.filter((t) => t.userId === USER_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0].recoveryAction).toBe('manual_review');
    expect(mine[0].status).toBe('posted');
  });

  it('never flags terminal statuses', async () => {
    await createIntent('settled', '30 days');
    await createIntent('failed', '30 days');
    await createIntent('cancelled', '30 days');
    const stuck = await findStuckTransfers();
    expect(stuck.filter((t) => t.userId === USER_ID)).toHaveLength(0);
  });
});

describe('runTransferRecoverySweep', () => {
  it('flags each stuck transfer exactly once across repeated sweeps', async () => {
    await createIntent('submitting', '45 minutes');

    const first = await runTransferRecoverySweep();
    expect(first.scanned).toBeGreaterThanOrEqual(1);
    expect(first.newlyFlagged).toBe(1);
    expect(first.alreadyFlagged).toBe(0);

    const second = await runTransferRecoverySweep();
    expect(second.newlyFlagged).toBe(0);
    expect(second.alreadyFlagged).toBe(1);

    const flags = await listOpenRecoveryFlags();
    expect(flags.filter((f) => f.userId === USER_ID)).toHaveLength(1);
  });

  it('dry run scans without flagging or auditing', async () => {
    await createIntent('submitting', '45 minutes');

    const result = await runTransferRecoverySweep({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.newlyFlagged).toBe(0);

    const flags = await listOpenRecoveryFlags();
    expect(flags.filter((f) => f.userId === USER_ID)).toHaveLength(0);

    const audits = await sql`
      SELECT COUNT(*) AS n FROM audit_logs
      WHERE user_id = ${USER_ID} AND action = 'transfer_flagged_stuck'
    `;
    expect(Number(audits[0].n)).toBe(0);
  });

  it('writes an audit entry per newly flagged transfer', async () => {
    await createIntent('submitting', '45 minutes');
    await runTransferRecoverySweep();

    const audits = await sql`
      SELECT action FROM audit_logs
      WHERE user_id = ${USER_ID} AND action = 'transfer_flagged_stuck'
    `;
    expect(audits).toHaveLength(1);
  });

  it('never mutates the intent status when flagging', async () => {
    const id = await createIntent('submitted', '25 hours');
    await runTransferRecoverySweep();
    expect(await intentStatus(id)).toBe('submitted');
  });
});

describe('RECOVERY_TIMEOUTS', () => {
  it('keeps automation away from provider-accepted transfers', async () => {
    // submitted/posted must never be auto-retried: re-driving the provider
    // call could double-move money.
    expect(RECOVERY_TIMEOUTS.submitted.action).toBe('manual_review');
    expect(RECOVERY_TIMEOUTS.posted.action).toBe('manual_review');
    expect(RECOVERY_TIMEOUTS.submitting.action).toBe('retry_execute');
  });
});
