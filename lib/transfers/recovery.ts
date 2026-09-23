import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';

export type RecoveryAction = 'retry_execute' | 'manual_review';

export interface RecoveryTimeout {
  /** Minutes an intent may sit in this status before it counts as stuck. */
  olderThanMinutes: number;
  action: RecoveryAction;
  reason: string;
}

/**
 * C1.3: per-status stuck thresholds.
 *
 * - `submitting`: the execute endpoint claimed ready → submitting under lock
 *   and then the provider call never completed (crash, deploy, timeout). The
 *   providers persist idempotency keys / authorization ids before calling
 *   out, so resuming via the execute endpoint is safe — flag as retryable.
 * - `submitted` / `posted`: the provider accepted the transfer but no
 *   settlement webhook arrived. Re-driving the provider call here would risk
 *   a duplicate movement, so these go to human review, never automation.
 */
export const RECOVERY_TIMEOUTS: Record<string, RecoveryTimeout> = {
  submitting: {
    olderThanMinutes: 30,
    action: 'retry_execute',
    reason:
      'Execute claimed the intent but the provider call never completed; safe to resume via the idempotent execute endpoint.',
  },
  submitted: {
    olderThanMinutes: 24 * 60,
    action: 'manual_review',
    reason:
      'Provider accepted the transfer but no settlement webhook arrived within 24h; do not re-drive automatically.',
  },
  posted: {
    olderThanMinutes: 24 * 60,
    action: 'manual_review',
    reason:
      'Transfer posted but no settlement webhook arrived within 24h; do not re-drive automatically.',
  },
};

export interface StuckTransfer {
  intentId: number;
  userId: number;
  type: string;
  amount: number;
  currency: string;
  status: string;
  providerName: string;
  executionMode: string;
  updatedAt: string;
  stuckMinutes: number;
  recoveryAction: RecoveryAction;
  reason: string;
  alreadyFlagged: boolean;
}

/** DDL for the recovery flags table; executed by initializeSchema(). */
export const TRANSFER_RECOVERY_FLAGS_DDL = `
  CREATE TABLE IF NOT EXISTS transfer_recovery_flags (
    id SERIAL PRIMARY KEY,
    transfer_intent_id INTEGER NOT NULL REFERENCES transfer_intents(id),
    status TEXT NOT NULL,
    recovery_action TEXT NOT NULL,
    reason TEXT NOT NULL,
    flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_open_recovery_flag
    ON transfer_recovery_flags (transfer_intent_id) WHERE resolved_at IS NULL;
`;

/**
 * Find transfer intents stuck in a non-terminal status past their timeout.
 * Never mutates anything — flagging is a separate, explicit step.
 */
export async function findStuckTransfers(): Promise<StuckTransfer[]> {
  const sql = getSql();
  const statuses = Object.keys(RECOVERY_TIMEOUTS);
  const minMinutes = Math.min(...Object.values(RECOVERY_TIMEOUTS).map((t) => t.olderThanMinutes));

  const rows = await sql`
    SELECT
      ti.id, ti.user_id, ti.type, ti.amount, ti.currency, ti.status,
      ti.provider_name, ti.execution_mode, ti.updated_at,
      (EXTRACT(EPOCH FROM (NOW() - ti.updated_at)) / 60)::int AS stuck_minutes,
      (rf.id IS NOT NULL) AS already_flagged
    FROM transfer_intents ti
    LEFT JOIN transfer_recovery_flags rf
      ON rf.transfer_intent_id = ti.id AND rf.resolved_at IS NULL
    WHERE ti.status = ANY(${statuses})
      AND ti.updated_at < NOW() - (${minMinutes} * INTERVAL '1 minute')
    ORDER BY ti.updated_at ASC
  `;

  return rows
    .map((r) => {
      const timeout = RECOVERY_TIMEOUTS[r.status as string];
      return {
        intentId: r.id as number,
        userId: r.user_id as number,
        type: r.type as string,
        amount: Number(r.amount),
        currency: r.currency as string,
        status: r.status as string,
        providerName: r.provider_name as string,
        executionMode: r.execution_mode as string,
        updatedAt: r.updated_at as string,
        stuckMinutes: r.stuck_minutes as number,
        recoveryAction: timeout.action,
        reason: timeout.reason,
        alreadyFlagged: r.already_flagged as boolean,
      } satisfies StuckTransfer;
    })
    .filter((t) => t.stuckMinutes >= RECOVERY_TIMEOUTS[t.status].olderThanMinutes);
}

export interface RecoverySweepResult {
  scanned: number;
  newlyFlagged: number;
  alreadyFlagged: number;
  dryRun: boolean;
  transfers: StuckTransfer[];
}

/**
 * Flag every stuck transfer exactly once.
 *
 * Flagging never touches the intent row itself — the state machine is owned
 * by the provider lifecycle, and a sweeper must not rewrite it. The partial
 * unique index on open flags makes concurrent sweeps safe: the second writer
 * inserts nothing.
 */
export async function runTransferRecoverySweep(
  opts?: { dryRun?: boolean },
): Promise<RecoverySweepResult> {
  const dryRun = opts?.dryRun ?? false;
  const sql = getSql();
  const stuck = await findStuckTransfers();

  let newlyFlagged = 0;
  let alreadyFlagged = 0;

  for (const t of stuck) {
    if (t.alreadyFlagged) {
      alreadyFlagged++;
      continue;
    }
    if (dryRun) continue;

    const inserted = await sql`
      INSERT INTO transfer_recovery_flags (transfer_intent_id, status, recovery_action, reason)
      VALUES (${t.intentId}, ${t.status}, ${t.recoveryAction}, ${t.reason})
      ON CONFLICT (transfer_intent_id) WHERE resolved_at IS NULL DO NOTHING
      RETURNING id
    `;

    if (inserted.length > 0) {
      newlyFlagged++;
      await auditLog(t.userId, 'transfer_flagged_stuck', {
        transfer_intent_id: t.intentId,
        status: t.status,
        stuck_minutes: t.stuckMinutes,
        recovery_action: t.recoveryAction,
        reason: t.reason,
      });
    } else {
      // Lost a race with a concurrent sweep; the other writer owns the flag.
      alreadyFlagged++;
    }
  }

  return {
    scanned: stuck.length,
    newlyFlagged,
    alreadyFlagged,
    dryRun,
    transfers: stuck,
  };
}

/** Open (unresolved) recovery flags with their intent details, for operators. */
export async function listOpenRecoveryFlags(): Promise<
  Array<{
    flagId: number;
    intentId: number;
    userId: number;
    type: string;
    amount: number;
    currency: string;
    status: string;
    recoveryAction: string;
    reason: string;
    flaggedAt: string;
  }>
> {
  const sql = getSql();
  const rows = await sql`
    SELECT rf.id AS flag_id, rf.transfer_intent_id, rf.status, rf.recovery_action,
           rf.reason, rf.flagged_at,
           ti.user_id, ti.type, ti.amount, ti.currency
    FROM transfer_recovery_flags rf
    JOIN transfer_intents ti ON ti.id = rf.transfer_intent_id
    WHERE rf.resolved_at IS NULL
    ORDER BY rf.flagged_at ASC
  `;
  return rows.map((r) => ({
    flagId: r.flag_id as number,
    intentId: r.transfer_intent_id as number,
    userId: r.user_id as number,
    type: r.type as string,
    amount: Number(r.amount),
    currency: r.currency as string,
    status: r.status as string,
    recoveryAction: r.recovery_action as string,
    reason: r.reason as string,
    flaggedAt: r.flagged_at as string,
  }));
}
