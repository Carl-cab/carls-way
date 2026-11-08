/**
 * Claim-bounded velocity release.
 *
 * `reverseVelocity()` released `min(amount, current window total)` — and that
 * window total is the user's volume from **every** money path. So a returned
 * transfer freed budget `money:send` and `money:split-pay` had genuinely
 * consumed. The abuse shape is plain: fund by `add_money`, spend the credit
 * through P2P, let the funding transfer return NSF, recover outbound budget
 * that was actually used. See `docs/decisions/0012`.
 *
 * The fix is to give a release an identity. A webhook names an **intent**, not
 * a window, so a claim is keyed by `(provider, reference)` and a release can
 * only ever return that claim's own amount, to that claim's own windows.
 *
 * Three properties are structural rather than conventional, which is the
 * point — each is enforced by the database or by control flow, not by a
 * caller remembering:
 *
 *   - **Domain-separated.** Funding and withdrawal exposure live in
 *     `velocity_claims` and are DERIVED from claim state by
 *     `claimedExposure()`. Nothing here writes to `velocity_checks`, which is
 *     the P2P outbound pool and has no domain column — so a credit into it
 *     would be cross-domain by construction. A release reduces only the
 *     exposure of its own `claim_kind`, for its own user and currency.
 *   - **Incapable of creating capacity.** Exposure is a SUM over the positive
 *     amounts of the reserved subset, so it cannot go negative. That is a
 *     property of the model, not a clamp on a negative row.
 *   - **Idempotent.** The release is a conditional `UPDATE ... WHERE state <>
 *     'released'`. A redelivered webhook updates zero rows and the function
 *     returns `already_released` without changing any exposure.
 *   - **Atomic.** Claim state and compensating rows commit together. The old
 *     implementation wrote three window rows in three separate statements with
 *     no transaction, so a failure part-way left a partial release committed
 *     and still reported success.
 */

import type postgres from 'postgres';
import { getSql } from '@/lib/db';
import { velocityWindows, type VelocityExecutor } from '@/lib/auth';
import { jsonbParam } from '@/lib/jsonb';
import {
  type MinorUnits,
  MoneyValidationError,
  parseSignedDatabaseMoney,
  toDatabaseDecimal,
} from '@/lib/money';

/**
 * Which exposure a claim belongs to. Funding and withdrawal are deliberately
 * distinct: a funding ceiling guards against return fraud over a window
 * measured in days, while withdrawal is the outbound direction velocity was
 * designed for. Decision 0009 keeps their budgets separate, and a release
 * must never move value between them.
 */
export type VelocityClaimKind = 'funding' | 'withdrawal';

/**
 * Namespace for claims keyed by transfer intent id.
 *
 * A constant rather than the rail's own provider name, deliberately: the
 * claim's identity is the intent, and an intent keeps its id when
 * `TransferProviderFactory` routes it to a different provider or when a
 * sandbox intent is later replayed against a live rail. Keying on the rail
 * would let one intent hold two claims.
 */
export const VELOCITY_CLAIM_PROVIDER = 'transfer_intent';

export interface VelocityClaim {
  id: number;
  userId: number;
  provider: string;
  reference: string;
  claimKind: VelocityClaimKind;
  amount: MinorUnits;
  currency: string;
  state: 'reserved' | 'finalized' | 'released';
  releasedAmount: MinorUnits;
}

export type VelocityReleaseOutcome =
  /** The claim existed, was not already released, and its amount was returned. */
  | { released: true; amount: MinorUnits; claimId: number }
  /** A duplicate delivery. Nothing changed. */
  | { released: false; reason: 'already_released'; claimId: number }
  /**
   * No claim for this reference. Nothing is released — deliberately. The rail
   * consumed no budget, so there is none to give back, and guessing an amount
   * from a window is exactly the defect this module replaces. Recorded for
   * reconciliation rather than silently ignored.
   */
  | { released: false; reason: 'no_claim' };

function rowToClaim(row: Record<string, unknown>): VelocityClaim {
  const currency = String(row.currency);
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    provider: String(row.provider),
    reference: String(row.reference),
    claimKind: String(row.claim_kind) as VelocityClaimKind,
    amount: parseSignedDatabaseMoney(String(row.amount), currency),
    currency,
    state: String(row.state) as VelocityClaim['state'],
    releasedAmount: parseSignedDatabaseMoney(String(row.released_amount ?? '0'), currency),
  };
}

/**
 * Record a velocity claim against a transfer intent.
 *
 * Pass `executor` when the caller already holds a transaction and the claim
 * must commit with whatever else it is doing — on a sandbox balance movement,
 * for instance, where the claim and the balance change have to be one unit.
 * `lib/db.ts` sets `max: 5`, so a caller inside `sql.begin` that lets this
 * acquire its own connection risks the pool deadlock documented in
 * `CLAUDE.md`.
 *
 * Returns `null` when a claim for this `(provider, reference)` already exists.
 * That is the duplicate-confirmation guard, and it is the unique index doing
 * the work rather than a prior read — a check-then-insert would have the same
 * race the velocity TOCTOU had.
 */
export async function createVelocityClaim(
  params: {
    userId: number;
    provider: string;
    reference: string;
    claimKind: VelocityClaimKind;
    amount: MinorUnits;
    currency: string;
  },
  options?: { executor?: VelocityExecutor },
): Promise<VelocityClaim | null> {
  const { userId, provider, reference, claimKind, amount, currency } = params;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new MoneyValidationError('Claim amount must be positive integer minor units.');
  }
  if (currency !== 'CAD' && currency !== 'USD') {
    throw new MoneyValidationError(`Invalid currency: ${currency}. Must be CAD or USD.`);
  }
  if (claimKind !== 'funding' && claimKind !== 'withdrawal') {
    throw new MoneyValidationError(`Invalid claim kind: ${claimKind}.`);
  }

  const sql = options?.executor ?? getSql();
  const [hourly, daily, weekly] = velocityWindows();

  const rows = await sql`
    INSERT INTO velocity_claims (
      user_id, provider, reference, claim_kind, amount, currency,
      hourly_window_start, daily_window_start, weekly_window_start, state
    ) VALUES (
      ${userId}, ${provider}, ${reference}, ${claimKind},
      ${toDatabaseDecimal(amount)}, ${currency},
      ${hourly.start.toISOString()}, ${daily.start.toISOString()},
      ${weekly.start.toISOString()}, 'reserved'
    )
    ON CONFLICT (provider, reference) DO NOTHING
    RETURNING *
  `;
  return rows.length === 0 ? null : rowToClaim(rows[0] as Record<string, unknown>);
}

/**
 * Current exposure for one accounting domain, derived from claim state.
 *
 * **This is what a release reduces.** `velocity_checks` is the P2P outbound
 * pool and is deliberately untouched by anything in this module: it has no
 * domain column, so writing into it mixes funding, withdrawal and P2P
 * accounting in one number. Funding and withdrawal exposure are therefore
 * computed here instead of mirrored there.
 *
 * Only `reserved` claims count. A `finalized` claim has settled, so it is no
 * longer unsettled value in flight — that is the quantity 0009's funding
 * budget is meant to bound. A `released` claim is gone. Per decision 0011,
 * realized loss after a return is a **separate** counter and is not this.
 *
 * `claimKind` scoping is what keeps a withdrawal release from reducing
 * funding exposure, and vice versa.
 *
 * Returns minor units, and is never negative: it sums the positive `amount`
 * of a subset of rows.
 */
export async function claimedExposure(
  userId: number,
  claimKind: VelocityClaimKind,
  currency: string,
  options?: { executor?: VelocityExecutor; windowType?: 'hourly' | 'daily' | 'weekly' },
): Promise<MinorUnits> {
  const sql = options?.executor ?? getSql();
  const windowType = options?.windowType ?? 'daily';
  const column =
    windowType === 'hourly' ? 'hourly_window_start'
    : windowType === 'weekly' ? 'weekly_window_start'
    : 'daily_window_start';
  const [hourly, daily, weekly] = velocityWindows();
  const boundary =
    windowType === 'hourly' ? hourly.start
    : windowType === 'weekly' ? weekly.start
    : daily.start;

  // The claim's OWN recorded window boundary is compared against the current
  // one, so a claim made in a past window has already rolled out of exposure
  // without any compensating write. A late return therefore cannot credit a
  // current window, because no credit is ever written.
  const rows = await sql`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM velocity_claims
    WHERE user_id = ${userId}
      AND claim_kind = ${claimKind}
      AND currency = ${currency}
      AND state = 'reserved'
      AND ${sql(column)} >= ${boundary.toISOString()}
  `;
  return parseSignedDatabaseMoney(String(rows[0]?.total ?? '0'), currency);
}

/** Convenience wrappers, so call sites read as the domain they mean. */
export const fundingExposure = (
  userId: number,
  currency: string,
  options?: { executor?: VelocityExecutor; windowType?: 'hourly' | 'daily' | 'weekly' },
) => claimedExposure(userId, 'funding', currency, options);

export const withdrawalExposure = (
  userId: number,
  currency: string,
  options?: { executor?: VelocityExecutor; windowType?: 'hourly' | 'daily' | 'weekly' },
) => claimedExposure(userId, 'withdrawal', currency, options);

/** Read a claim without changing it. For reconciliation and for tests. */
export async function findVelocityClaim(
  provider: string,
  reference: string,
  options?: { executor?: VelocityExecutor },
): Promise<VelocityClaim | null> {
  const sql = options?.executor ?? getSql();
  const rows = await sql`
    SELECT * FROM velocity_claims
    WHERE provider = ${provider} AND reference = ${reference}
  `;
  return rows.length === 0 ? null : rowToClaim(rows[0] as Record<string, unknown>);
}

/** Mark a claim finalized — the transfer settled and the budget is consumed for good. */
export async function finalizeVelocityClaim(
  provider: string,
  reference: string,
  options?: { executor?: VelocityExecutor },
): Promise<boolean> {
  const sql = options?.executor ?? getSql();
  const rows = await sql`
    UPDATE velocity_claims
    SET state = 'finalized', updated_at = NOW()
    WHERE provider = ${provider} AND reference = ${reference} AND state = 'reserved'
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Release a claim's velocity budget, and only that claim's.
 *
 * Runs as one transaction containing the claim-state change and the
 * compensating `velocity_checks` rows, so a database error part-way through
 * leaves neither — the old implementation could leave one window released and
 * two not, and reported success. `eventId`, when given, is recorded on the
 * claim so a reconciliation pass can tell which delivery released it.
 *
 * Deliberately has **no `try/catch`**. A failure here must reach the caller:
 * swallowing it is how the previous implementation turned a partial release
 * into a silent one. `SettlementExecutor` already wraps its own call and
 * reports the error on its result object.
 */
export async function releaseVelocityClaim(
  provider: string,
  reference: string,
  options?: { eventId?: string; reason?: string; executor?: VelocityExecutor },
): Promise<VelocityReleaseOutcome> {
  const executor = options?.executor;
  if (executor) return releaseWithin(executor, provider, reference, options);
  return getSql().begin((tx) =>
    releaseWithin(tx as unknown as VelocityExecutor, provider, reference, options),
  ) as Promise<VelocityReleaseOutcome>;
}

async function releaseWithin(
  sql: VelocityExecutor,
  provider: string,
  reference: string,
  options?: { eventId?: string; reason?: string },
): Promise<VelocityReleaseOutcome> {
  // Lock the claim row for the transaction. Two concurrent deliveries of the
  // same return serialise here; the second sees state = 'released' and the
  // conditional update below matches nothing.
  const locked = await sql`
    SELECT * FROM velocity_claims
    WHERE provider = ${provider} AND reference = ${reference}
    FOR UPDATE
  `;

  if (locked.length === 0) {
    // No claim means the path consumed no budget, so the correct release is
    // zero. Recorded because a return against an unknown claim is a
    // reconciliation signal, not a no-op worth hiding.
    await recordMismatch(sql, provider, reference, options?.reason);
    return { released: false, reason: 'no_claim' };
  }

  const claim = rowToClaim(locked[0] as Record<string, unknown>);

  if (claim.state === 'released') {
    return { released: false, reason: 'already_released', claimId: claim.id };
  }

  // The conditional guard, kept even though the row is locked: the lock
  // serialises, the predicate decides. If a future caller releases outside a
  // transaction, this is still the thing that stops a double release.
  const claimed = await sql`
    UPDATE velocity_claims
    SET state = 'released',
        released_amount = amount,
        released_at = NOW(),
        release_event_id = ${options?.eventId ?? null},
        updated_at = NOW()
    WHERE id = ${claim.id} AND state <> 'released'
    RETURNING amount
  `;
  if (claimed.length === 0) {
    return { released: false, reason: 'already_released', claimId: claim.id };
  }

  // NOTHING is written to velocity_checks. That is the correction, and it is
  // the whole point of this function's second revision.
  //
  // The first version inserted negative "compensating" rows into
  // velocity_checks, reasoning by analogy with how reverseVelocity() worked.
  // That was wrong at the accounting level, not merely at the amount level:
  // velocity_checks has NO domain column, so it is one undifferentiated pool
  // per (user, window, currency) holding P2P send, request-accept and
  // split-pay consumption together. A credit into it is cross-domain by
  // construction. Measured on a real database:
  //
  //   - a funding claim of 100 released against 450 of pure P2P volume left
  //     350 — the funding return paid back P2P spending;
  //   - a WITHDRAWAL claim behaved the same way, 400 -> 250;
  //   - a release with no prior charge drove usage to -300, and the payer
  //     then moved 750 of P2P against a 500 hourly ceiling. A 50% ceiling
  //     bypass, from a return on a transfer that consumed nothing.
  //
  // Clamping the negative rows would have hidden the third case and left the
  // first two untouched, so the model changed instead: funding and withdrawal
  // exposure lives in velocity_claims and is DERIVED from claim state, never
  // mirrored into the P2P pool. Releasing a claim reduces funding exposure by
  // removing it from the reserved set — see claimedExposure(). Exposure is a
  // SUM over positive amounts of a subset, so it cannot go negative and
  // cannot create capacity, by construction rather than by a clamp.
  //
  // `lib/__tests__/velocity-claim-domains.test.ts` pins each invariant, and
  // `velocity-admission-callers.test.ts` fails if this file ever gains an
  // INSERT into velocity_checks again.

  // Transaction-bound audit. The previous revision called auditLog(), which
  // takes its OWN pool connection from getSql() and swallows its errors —
  // two defects at once, both already documented in CLAUDE.md and both of
  // which I reintroduced here. `lib/db.ts` sets max: 5, so a release holding
  // a transaction connection and asking for a second risks the pool
  // deadlock; and a swallowed audit failure means a release reported success
  // with no record of it. Writing on `sql` makes the audit row commit and
  // roll back with the release, and lets a failure propagate.
  await sql`
    INSERT INTO audit_logs (user_id, action, metadata)
    VALUES (
      ${claim.userId}, 'velocity_claim_released',
      ${jsonbParam(sql as unknown as postgres.Sql, {
        provider,
        reference,
        claimId: claim.id,
        claimKind: claim.claimKind,
        amount: toDatabaseDecimal(claim.amount),
        currency: claim.currency,
        reason: options?.reason ?? 'transfer_returned',
        eventId: options?.eventId ?? null,
      })}
    )
  `;

  return { released: true, amount: claim.amount, claimId: claim.id };
}

async function recordMismatch(
  sql: VelocityExecutor,
  provider: string,
  reference: string,
  reason?: string,
): Promise<void> {
  // Written on the caller's transaction rather than through auditLog(), which
  // uses its own connection and swallows errors. A mismatch is the signal
  // that a return arrived for something that never reserved budget, so losing
  // it is losing the only trace that reconciliation has to work from.
  await sql`
    INSERT INTO audit_logs (user_id, action, metadata)
    VALUES (
      NULL, 'velocity_claim_release_mismatch',
      ${jsonbParam(sql as unknown as postgres.Sql, {
        provider,
        reference,
        reason: reason ?? 'transfer_returned',
        note: 'release requested for a reference with no velocity claim; nothing released',
      })}
    )
  `;
}

/**
 * Claims that a reconciliation pass should look at.
 *
 * Two shapes, and they fail in opposite directions. A claim stuck in
 * `reserved` past `staleAfterHours` is budget held against a transfer whose
 * outcome is unknown — refusing the payer capacity they may be owed. A
 * `release_mismatch` audit row is the reverse: a return arrived for something
 * that never reserved, so either a claim was never created where it should
 * have been, or the reference is wrong.
 */
export async function findVelocityClaimsNeedingReconciliation(
  staleAfterHours = 72,
  options?: { executor?: VelocityExecutor },
): Promise<{ staleReserved: VelocityClaim[]; mismatchCount: number }> {
  const sql = options?.executor ?? getSql();
  const stale = await sql`
    SELECT * FROM velocity_claims
    WHERE state = 'reserved'
      AND created_at < NOW() - (${staleAfterHours} * INTERVAL '1 hour')
    ORDER BY created_at
  `;
  const mismatches = await sql`
    SELECT COUNT(*)::int AS n FROM audit_logs
    WHERE action = 'velocity_claim_release_mismatch'
  `;
  return {
    staleReserved: stale.map((r) => rowToClaim(r as Record<string, unknown>)),
    mismatchCount: Number(mismatches[0]?.n ?? 0),
  };
}
