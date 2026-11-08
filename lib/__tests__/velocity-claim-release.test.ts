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

describe('a release identifies the original claim', () => {
  it('releases exactly the claimed amount, not the window total', async () => {
    // THE DEFECT, DIRECTLY. The payer has 450 of consumed budget from a P2P
    // path. A funding claim of 100 is released. The old implementation would
    // have released min(100, 450) = 100 here too — so the distinguishing case
    // is the next test, where the claim is SMALLER than the window holds and
    // the release must still be the claim's amount.
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-exact',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    const outcome = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-exact');

    expect(outcome).toMatchObject({ released: true, amount: cad('100.00') });
    expect(await consumed()).toBe(cad('350.00'));
  });

  it('NEVER releases more than the original claimed amount, however much the window holds', async () => {
    // The payer consumed 450 through P2P. A funding claim of 25 is released.
    // Only 25 may come back. Under the old window-bounded release an
    // over-large reversal request would have taken whatever the window held —
    // this is the assertion that the claim, not the window, is the bound.
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-small',
      claimKind: 'funding', amount: cad('25.00'), currency: 'CAD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-small');

    expect(await consumed()).toBe(cad('425.00'));
  });

  it('releases NOTHING when no claim exists, and records a reconciliation signal', async () => {
    // This is the transfer rail's state today: it holds no claims, so the
    // correct release for a returned transfer is zero. Guessing an amount
    // from the window is the defect. A mismatch row is written because a
    // return against an unknown reference is a signal, not a no-op.
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    const before = await mismatchCount();

    const outcome = await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-absent');

    expect(outcome).toEqual({ released: false, reason: 'no_claim' });
    expect(await consumed()).toBe(cad('450.00'));
    expect(await mismatchCount()).toBe(before + 1);
  });

  it('never frees another user budget', async () => {
    await admitVelocity(OTHER, cad('400.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-crossuser',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-crossuser');

    // The other user's budget is untouched; the claim's owner went negative
    // against their own (empty) window, which is representable and auditable.
    expect(await consumed(OTHER)).toBe(cad('400.00'));
  });

  it('never frees another currency budget', async () => {
    await admitVelocity(PAYER, cad('400.00'), 'CAD');
    await admitVelocity(PAYER, usd('400.00'), 'USD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-ccy',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });

    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-ccy');

    expect(await consumed(PAYER, 'CAD')).toBe(cad('300.00'));
    expect(await consumed(PAYER, 'USD')).toBe(usd('400.00'));
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
    expect(await consumed()).toBe(cad('300.00'));
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
    expect(await consumed()).toBe(cad('300.00'));
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

    // The current hourly window still holds the full 450: the compensating
    // row landed 40 days back, where the claim was made.
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
    expect(await consumed()).toBe(cad('300.00'));
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

    // 450 − (3 × 50). Not 450 − 450, which is what an unbounded release of
    // three returns against one window would have produced.
    expect(await consumed()).toBe(cad('300.00'));
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
   * the first compensating insert has already been written, which is exactly
   * the old implementation's failure mode.
   */
  function failOnNthVelocityInsert(tx: unknown, n: number) {
    let seen = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((...args: any[]) => {
      const text = String(args[0]?.[0] ?? '');
      if (text.includes('INSERT INTO velocity_checks')) {
        seen += 1;
        if (seen === n) throw new Error('simulated database failure mid-release');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (tx as any)(...args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
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
          executor: failOnNthVelocityInsert(tx, 2),
        });
      }),
    ).rejects.toThrow(/simulated database failure/);

    // Nothing moved: not the claim state, and not the first window that had
    // already been written when the second failed.
    expect((await findVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-fail'))!.state)
      .toBe('reserved');
    expect(await consumed()).toBe(cad('400.00'));
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

describe('the ceiling still binds after a release', () => {
  it('released budget is spendable but the ceiling is not raised', async () => {
    await admitVelocity(PAYER, cad('450.00'), 'CAD');
    await createVelocityClaim({
      userId: PAYER, provider: VELOCITY_CLAIM_PROVIDER, reference: 'claim-test-ceiling',
      claimKind: 'funding', amount: cad('100.00'), currency: 'CAD',
    });
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'claim-test-ceiling');

    // 350 consumed, 500 ceiling: 100 fits, a further 100 does not.
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).resolves.toBeUndefined();
    await expect(admitVelocity(PAYER, cad('100.00'), 'CAD')).rejects.toThrow(/Hourly limit/i);
    expect(await consumed()).toBeLessThanOrEqual(LIMITS.hourly_max_amount * 100);
  });
});
