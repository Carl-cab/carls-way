/**
 * Claim-bounded velocity release — `lib/velocity-claims.ts`.
 *
 * The defect this replaces: `reverseVelocity()` released
 * `min(amount, current window total)`, and that window total is the user's
 * volume from **every** money path. So a returned transfer freed budget
 * `money:send` and `money:split-pay` had genuinely consumed. Abuse shape:
 * fund by `add_money`, spend the credit through P2P, let the funding transfer
 * return NSF, recover outbound budget that was actually used.
 *
 * Each case below maps to one of the owner's stated requirements, named in the
 * test title, so a reader can check coverage against the decision rather than
 * against my summary of it.
 *
 * Real PostgreSQL only. The subject is row locks, transaction boundaries,
 * snapshot visibility and a unique index; a fake has none of them and would
 * report this correct under any implementation.
 */

import { getSql } from '../db';
import { parseDatabaseMoney, parsePositiveMoney } from '../money';
import { admitVelocity, VELOCITY_LIMITS } from '../auth';
import {
  createVelocityClaim,
  finalizeVelocityClaim,
  findVelocityClaim,
  findVelocityClaimsNeedingReconciliation,
  releaseVelocityClaim,
  fundingExposure,
  withdrawalExposure,
  VELOCITY_CLAIM_PROVIDER,
} from '../velocity-claims';

// Its own fixture user: vitest runs files in parallel and this file drives a
// payer to a ceiling and then releases budget, so sharing a user with another
// velocity file would make each one's result depend on the other's timing.
const PAYER = 9131;
const OTHER = 9132;

const sql = getSql();
const cad = (a: string) => parsePositiveMoney(a, 'CAD');
const usd = (a: string) => parsePositiveMoney(a, 'USD');
const LIMITS = VELOCITY_LIMITS.new_user; // 'pending' KYC: 500 hourly, 1000 daily, 5 count

async function consumed(user = PAYER, currency: 'CAD' | 'USD' = 'CAD', windowType = 'hourly') {
  const rows = await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
    WHERE user_id = ${user} AND window_type = ${windowType} AND currency = ${currency}
  `;
  return parseDatabaseMoney(String(rows[0].total), currency);
}

async function mismatchCount() {
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'velocity_claim_release_mismatch'
  `;
  return rows[0].n as number;
}

async function cleanup() {
  for (const u of [PAYER, OTHER]) {
    await sql`DELETE FROM velocity_checks WHERE user_id = ${u}`;
    await sql`DELETE FROM velocity_claims WHERE user_id = ${u}`;
    await sql`DELETE FROM audit_logs WHERE user_id = ${u}`;
  }
  // Mismatch rows carry user_id NULL by design — the reference did not resolve
  // to a user — so they need their own scoped delete rather than riding on the
  // per-user cleanup above.
  await sql`
    DELETE FROM audit_logs
    WHERE action = 'velocity_claim_release_mismatch'
      AND metadata->>'reference' LIKE 'claim-test-%'
  `;
}

beforeEach(cleanup);
afterAll(cleanup);

describe('accounting domains are separate — a release touches only its own', () => {
  // THESE CASES REPLACE A BLOCK THAT ASSERTED THE DEFECT.
  //
  // The previous versions asserted that a funding release REDUCED the payer's
  // P2P consumption — "expect(await consumed()).toBe(cad('350.00'))" after
  // releasing a 100 claim against 450 of pure P2P volume. That assertion was
  // accurate about the code and wrong about what the code should do, which is
  // exactly the trap the deleted reverseVelocity tests fell into one revision
  // earlier. Measured consequences of the old behaviour, on a real database:
  // a withdrawal release cut the P2P pool 400 -> 250; and a release with no
  // prior charge drove usage to -300, after which the payer moved 750 of P2P
  // against a 500 hourly ceiling.

  it('a funding release does NOT reduce P2P consumption', async () => {
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-p2p',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    const outcome = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-p2p');

    expect(outcome).toMatchObject({ released: true, amount: cad('100.00') });
    // The invariant. Under the old implementation this read 350.
    expect(await consumed()).toBe(cad('450.00'));
  });

  it('a withdrawal release does NOT reduce P2P consumption', async () => {
    await admitVelocity(PAYER, cad('400.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-wd',
      claimKind: 'withdrawal', amount: cad('150.00'), currency: 'CAD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-wd');

    // Under the old implementation this read 250.
    expect(await consumed()).toBe(cad('400.00'));
  });

  it('a withdrawal release does NOT reduce funding exposure, and vice versa', async () => {
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-fund-a',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-wd-a',
      claimKind: 'withdrawal', amount: cad('80.00'), currency: 'CAD',
    });
    expect(await fundingExposure(PAYER, 'CAD')).toBe(cad('100.00'));
    expect(await withdrawalExposure(PAYER, 'CAD')).toBe(cad('80.00'));

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-wd-a');

    // Only the withdrawal domain moved.
    expect(await withdrawalExposure(PAYER, 'CAD')).toBe(0);
    expect(await fundingExposure(PAYER, 'CAD')).toBe(cad('100.00'));
  });

  it('a release reduces its own domain exposure by exactly the claim amount', async () => {
    for (const [ref, amt] of [['claim-test-e1', '60.00'], ['claim-test-e2', '40.00']] as const) {
      await createVelocityClaim({
        userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: ref,
        claimKind: 'funding', amount: cad(amt), currency: 'CAD',
      });
    }
    expect(await fundingExposure(PAYER, 'CAD')).toBe(cad('100.00'));

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-e1');

    expect(await fundingExposure(PAYER, 'CAD')).toBe(cad('40.00'));
  });

  it('a release with NO original charge cannot create negative usage or capacity', async () => {
    // The worst of the measured cases. From an empty start the old code drove
    // usage to -300 and then admitted 750 against a 500 ceiling.
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-nocharge',
      claimKind: 'funding', amount: cad('300.00'), currency: 'CAD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-nocharge');

    // No P2P usage was created or destroyed...
    expect(await consumed()).toBe(0);
    // ...exposure is zero, not negative...
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    // ...and the P2P ceiling still binds at its real value: 450 fits, a
    // further 100 does not. Under the old behaviour both were admitted.
    await expect(admitVelocity(PAYER, cad('450.00'), 'CAD')).resolves.toBeUndefined();
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(/Hourly limit/i);
  });

  it('exposure is never negative, however many claims are released', async () => {
    for (const ref of ['claim-test-n1', 'claim-test-n2', 'claim-test-n3']) {
      await createVelocityClaim({
        userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: ref,
        claimKind: 'funding', amount: cad('50.00'), currency: 'CAD',
      });
      await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, ref);
    }
    // A SUM over a subset of positive amounts has no way to go below zero.
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    expect(await consumed()).toBe(0);
  });

  it('releases NOTHING when no claim exists, and records a reconciliation signal', async () => {
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    const before = await mismatchCount();

    const outcome = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-absent');

    expect(outcome).toEqual({ released: false, reason: 'no_claim' });
    expect(await consumed()).toBe(cad('450.00'));
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    expect(await mismatchCount()).toBe(before + 1);
  });

  it('never touches another user exposure', async () => {
    await admitVelocity(OTHER, cad('400.00'), 'CAD');
    await createVelocityClaim({
      userId: OTHER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-othersown',
      claimKind: 'funding', amount: cad('70.00'), currency: 'CAD',
    });
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-crossuser',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-crossuser');

    expect(await consumed(OTHER)).toBe(cad('400.00'));
    expect(await fundingExposure(OTHER, 'CAD')).toBe(cad('70.00'));
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
  });

  it('never touches another currency exposure', async () => {
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-ccy-cad',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-ccy-usd',
      claimKind: 'funding', amount: usd('100.00'), currency: 'USD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-ccy-cad');

    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    expect(await fundingExposure(PAYER, 'USD')).toBe(usd('100.00'));
  });
});

describe('duplicate delivery cannot double-release', () => {
  it('a redelivered return releases once', async () => {
    await admitVelocity(PAYER, cad('400.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-dupe',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    const first = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-dupe', { eventId: 'evt_1' });
    const second = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-dupe', { eventId: 'evt_1' });
    const third = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-dupe', { eventId: 'evt_2' });

    expect(first.released).toBe(true);
    expect(second).toMatchObject({ released: false, reason: 'already_released' });
    // A DIFFERENT event id must also not re-release. Keying idempotency on the
    // event rather than the claim would let two distinct deliveries each take
    // the amount once.
    expect(third).toMatchObject({ released: false, reason: 'already_released' });
    // Exposure went to zero once, and P2P was never involved.
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    expect(await consumed()).toBe(cad('400.00'));
  });

  it('concurrent deliveries of the same return release once', async () => {
    await admitVelocity(PAYER, cad('400.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-concurrent',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    const outcomes = await Promise.all([
      releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-concurrent'),
      releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-concurrent'),
      releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-concurrent'),
    ]);

    expect(outcomes.filter((o) => o.released)).toHaveLength(1);
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    expect(await consumed()).toBe(cad('400.00'));
  });

  it('a duplicate confirmation cannot create a second claim for one intent', async () => {
    const first = await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-onceonly',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });
    const second = await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-onceonly',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    expect(first).not.toBeNull();
    // The unique index does this, not a prior read — a check-then-insert would
    // carry the same race the velocity TOCTOU had.
    expect(second).toBeNull();
  });
});

describe('late returns and adversarial ordering', () => {
  it('a late return credits the claim original windows, not the current ones', async () => {
    // A US unauthorized-debit return can arrive 60 calendar days later and a
    // CA PAD personal dispute 90. By then the claim's hourly and daily
    // windows are long gone. Crediting the CURRENT windows would hand back
    // headroom in a window that never carried the charge — which is free
    // budget, the same class of defect from the other direction.
    const claim = await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-late',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });
    expect(claim).not.toBeNull();

    // Age the claim's recorded windows by 40 days.
    await sql`
      UPDATE velocity_claims
      SET hourly_window_start = hourly_window_start - INTERVAL '40 days',
          daily_window_start  = daily_window_start  - INTERVAL '40 days',
          weekly_window_start = weekly_window_start - INTERVAL '40 days'
      WHERE id = ${claim!.id}
    `;

    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-late');

    // The current hourly window still holds the full 450. Not because a
    // compensating row landed 40 days back -- no row is written anywhere --
    // but because the release only moves the claim out of the reserved set,
    // and velocity_checks is a different domain the release never touches.
    const current = await sql`
      SELECT COALESCE(SUM(total_amount), 0) AS total FROM velocity_checks
      WHERE user_id = ${PAYER} AND window_type = 'hourly'
        AND window_start >= date_trunc('hour', NOW())
    `;
    expect(parseDatabaseMoney(String(current[0].total), 'CAD')).toBe(cad('450.00'));

    // And the payer did NOT regain capacity they had already spent.
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(/Hourly limit/i);
  });

  it('a return arriving before finalize still releases exactly once', async () => {
    // Out-of-order delivery: the provider's returned event outruns its
    // settled event. The release must not depend on having been finalized,
    // and the later finalize must not resurrect the claim.
    await admitVelocity(PAYER, cad('400.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-ooo',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    const released = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-ooo');
    expect(released.released).toBe(true);

    // finalize must refuse a released claim rather than move it back.
    expect(await finalizeVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-ooo')).toBe(false);
    expect((await findVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-ooo'))!.state).toBe('released');
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    expect(await consumed()).toBe(cad('400.00'));
  });

  it('repeated returns across separate claims each release their own amount only', async () => {
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    for (const ref of ['claim-test-r1', 'claim-test-r2', 'claim-test-r3']) {
      await createVelocityClaim({
        userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: ref,
        claimKind: 'funding', amount: cad('50.00'), currency: 'CAD',
      });
    }

    for (const ref of ['claim-test-r1', 'claim-test-r2', 'claim-test-r3']) {
      expect((await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, ref)).released).toBe(true);
    }

    // Each release reduced only its own claim's funding exposure; the P2P
    // pool is untouched. The previous version of this case expected 450 − 150
    // in the P2P pool, which was the cross-domain defect.
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    expect(await consumed()).toBe(cad('450.00'));
  });
});

describe('a database error does not silently create budget', () => {
  /**
   * Injects a failure part-way through the release by proxying the executor.
   *
   * An earlier draft tried to force the failure by pointing the claim at a
   * non-existent user — which cannot work, because `velocity_claims.user_id`
   * has a foreign key, so the *setup* threw rather than the release. Proxying
   * the executor is both honest and closer to the real hazard: it fails after
   * the claim-state change has been written but before its audit row lands,
   * which is the shape of the old implementation's failure mode -- that one
   * could leave one window released and two not, and still report success.
   */
  function failOnNthVelocityInsert(tx: unknown, n: number) {
    let seen = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy = ((...args: any[]) => {
      const text = String(args[0]?.[0] ?? '');
      // The release's only write beyond the claim state change is its audit
      // row, which is now transaction-bound. Failing it must roll the whole
      // release back rather than leaving a released claim with no record.
      if (text.includes('INSERT INTO audit_logs')) {
        seen += 1;
        if (seen === n) throw new Error('simulated database failure mid-release');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (tx as any)(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    // jsonbParam() reaches for sql.json, so a bare function proxy fails with
    // "sql.json is not a function" — a test-harness bug that looked like a
    // production one on the first run. Carry the driver's own helpers across.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proxy.json = (tx as any).json?.bind(tx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proxy.unsafe = (tx as any).unsafe?.bind(tx);
    return proxy;
  }

  it('a failure part-way leaves the claim unreleased and NO window credited', async () => {
    // The old implementation wrote its three window rows in three separate
    // statements with NO transaction, so a failure on the second left the
    // first one's release committed — real budget handed back for a release
    // that did not complete. Here all of it is one transaction.
    await admitVelocity(PAYER, cad('400.00'), 'CAD');
    const claim = await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-fail',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });
    expect(claim).not.toBeNull();

    await expect(
      sql.begin(async (tx) => {
        await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-fail', {
          executor: failOnNthVelocityInsert(tx, 1),
        });
      }),
    ).rejects.toThrow(/simulated database failure/);

    // Nothing moved: not the claim state, and not the first window that had
    // already been written when the second failed.
    expect((await findVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-fail'))!.state)
      .toBe('reserved');
    expect(await consumed()).toBe(cad('400.00'));
    // Exposure is still held: the release did not take effect.
    expect(await fundingExposure(PAYER, 'CAD')).toBe(cad('100.00'));
    // And no negative row exists anywhere — this module writes none at all now.
    const anyNegative = await sql`
      SELECT COUNT(*)::int AS n FROM velocity_checks
      WHERE user_id = ${PAYER} AND transaction_count < 0
    `;
    expect(anyNegative[0].n).toBe(0);
  });

  it('propagates the error instead of reporting success', async () => {
    // Separate from the case above on purpose: "rolled back" and "reported"
    // are different properties, and the old implementation had the first
    // without the second — its catch logged and returned normally, so a
    // caller could not tell a failed release from a completed one.
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-noswallow',
      claimKind: 'funding', amount: cad('10.00'), currency: 'CAD',
    });

    const outcome = await sql
      .begin(async (tx) => {
        await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-noswallow', {
          executor: failOnNthVelocityInsert(tx, 1),
        });
      })
      .then(() => 'resolved' as const)
      .catch(() => 'threw' as const);

    expect(outcome).toBe('threw');
    expect((await findVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-noswallow'))!.state)
      .toBe('reserved');
  });
});

describe('transaction and audit integrity', () => {
  it('does not exhaust the connection pool under concurrent releases', async () => {
    // `lib/db.ts` sets max: 5. The previous revision called auditLog() from
    // inside the release transaction, and auditLog() takes its OWN connection
    // from getSql() — so a release holding one pool connection asked the same
    // 5-connection pool for a second while holding it. Six concurrent
    // releases is one past that ceiling. Under the defect this does not fail
    // an assertion, it HANGS until the vitest timeout, which is what the bug
    // does to a request. The audit row is now written on the release's own
    // executor, so no second connection is ever requested.
    const refs = Array.from({ length: 6 }, (_, i) => `claim-test-pool-${i}`);
    for (const ref of refs) {
      await createVelocityClaim({
        userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: ref,
        claimKind: 'funding', amount: cad('10.00'), currency: 'CAD',
      });
    }

    const outcomes = await Promise.all(
      refs.map((ref) => releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, ref)),
    );

    expect(outcomes.filter((o) => o.released)).toHaveLength(6);
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
  });

  it('writes exactly one audit row per release, and none for a duplicate', async () => {
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-audit',
      claimKind: 'funding', amount: cad('25.00'), currency: 'CAD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-audit', { eventId: 'evt_a' });
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-audit', { eventId: 'evt_a' });

    const rows = await sql`
      SELECT metadata FROM audit_logs
      WHERE user_id = ${PAYER} AND action = 'velocity_claim_released'
    `;
    expect(rows).toHaveLength(1);
    // And the record is queryable — jsonbParam(), not JSON.stringify(), so
    // metadata->>'reference' is not silently NULL. This repo has shipped that
    // defect twice on other writers.
    const queryable = await sql`
      SELECT COUNT(*)::int AS n FROM audit_logs
      WHERE action = 'velocity_claim_released'
        AND metadata->>'reference' = 'claim-test-audit'
        AND metadata->>'claimKind' = 'funding'
    `;
    expect(queryable[0].n).toBe(1);
  });

  it('rolls the audit row back with the release when the caller aborts', async () => {
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-auditrb',
      claimKind: 'funding', amount: cad('25.00'), currency: 'CAD',
    });

    await expect(
      sql.begin(async (tx) => {
        await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-auditrb', {
          executor: tx as never,
        });
        throw new Error('caller aborted after release');
      }),
    ).rejects.toThrow(/caller aborted/);

    // Neither the state change nor its audit row survived. Under the old
    // auditLog() call the audit row committed on its own connection and
    // survived a rollback of the release — a record of something that did not
    // happen, which is worse than a missing one.
    expect((await findVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-auditrb'))!.state)
      .toBe('reserved');
    const rows = await sql`
      SELECT COUNT(*)::int AS n FROM audit_logs
      WHERE action = 'velocity_claim_released'
        AND metadata->>'reference' = 'claim-test-auditrb'
    `;
    expect(rows[0].n).toBe(0);
  });
});

describe('reconciliation can identify mismatched claims', () => {
  it('reports claims stuck in reserved past their age, and release mismatches', async () => {
    const claim = await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-stale',
      claimKind: 'funding', amount: cad('40.00'), currency: 'CAD',
    });
    await sql`UPDATE velocity_claims SET created_at = NOW() - INTERVAL '5 days' WHERE id = ${claim!.id}`;

    // And a return for something that never reserved.
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-unknown-ref');

    const report = await findVelocityClaimsNeedingReconciliation(72);

    expect(report.staleReserved.map((c) => c.reference)).toContain('claim-test-stale');
    expect(report.mismatchCount).toBeGreaterThan(0);
  });

  it('does not report a fresh reserved claim or a released one', async () => {
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-fresh',
      claimKind: 'funding', amount: cad('40.00'), currency: 'CAD',
    });
    const done = await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-done',
      claimKind: 'funding', amount: cad('40.00'), currency: 'CAD',
    });
    expect(done).not.toBeNull();
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-done');

    const report = await findVelocityClaimsNeedingReconciliation(72);
    const refs = report.staleReserved.map((c) => c.reference);

    expect(refs).not.toContain('claim-test-fresh');
    expect(refs).not.toContain('claim-test-done');
  });
});

describe('funding and withdrawal are distinguished', () => {
  it('records the claim kind, so the two exposures can be budgeted separately', async () => {
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-funding',
      claimKind: 'funding', amount: cad('10.00'), currency: 'CAD',
    });
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-withdrawal',
      claimKind: 'withdrawal', amount: cad('10.00'), currency: 'CAD',
    });

    expect((await findVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-funding'))!.claimKind)
      .toBe('funding');
    expect((await findVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-withdrawal'))!.claimKind)
      .toBe('withdrawal');
  });

  it('rejects an unknown claim kind rather than defaulting it', async () => {
    await expect(createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-badkind',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claimKind: 'something_else' as any, amount: cad('10.00'), currency: 'CAD',
    })).rejects.toThrow(/claim kind/i);
  });

  it('rejects a non-positive amount and an unsupported currency', async () => {
    await expect(createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-zero',
      claimKind: 'funding', amount: 0, currency: 'CAD',
    })).rejects.toThrow();
    await expect(createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-eur',
      claimKind: 'funding', amount: cad('10.00'), currency: 'EUR',
    })).rejects.toThrow(/currency/i);
  });
});

describe('a release frees its own domain capacity, not P2P capacity', () => {
  it('released funding exposure frees FUNDING room and leaves the P2P ceiling where it was', async () => {
    // The previous version of this case asserted that released budget became
    // spendable on P2P — "admitVelocity(100) resolves" after releasing a 100
    // funding claim against 450 of P2P volume. That was the cross-domain
    // defect stated as an expectation.
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-ceiling',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });
    expect(await fundingExposure(PAYER, 'CAD')).toBe(cad('100.00'));

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-ceiling');

    // Funding room came back...
    expect(await fundingExposure(PAYER, 'CAD')).toBe(0);
    // ...and the P2P pool is exactly where it was, so the P2P ceiling still
    // binds at 450 of 500: 50 fits, 100 does not.
    expect(await consumed()).toBe(cad('450.00'));
    await expect(admitVelocity(PAYER, cad('50.00'), 'CAD')).resolves.toBeUndefined();
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(/Hourly limit/i);
    expect(await consumed()).toBeLessThanOrEqual(LIMITS.hourly_max_amount * 100);
  });
});
