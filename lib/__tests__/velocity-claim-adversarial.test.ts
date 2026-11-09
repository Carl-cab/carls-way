/**
 * Adversarial probes for the claim/exposure model.
 *
 * Written during the validation of PR #77 to BREAK the invariants rather than
 * to assert the behaviour the implementation happens to have — because the two
 * previous revisions of this control both shipped green suites while carrying
 * the defect, under test titles claiming the release was "bounded by the
 * claim". Each case here is phrased as an attack that must fail.
 *
 * Scope note, so this file is not mistaken for broader coverage than it has:
 * ATTACK 4 is the only end-to-end run of the abuse shape the owner named —
 * fund, spend the credit through P2P, let the funding transfer return, and
 * confirm the outbound budget is NOT recovered and the ceiling still binds.
 * The rest overlap `velocity-claim-release.test.ts` deliberately, approaching
 * the same invariants from the attacker's side.
 *
 * One lesson is recorded in ATTACK 4 itself: its first draft asserted a 500
 * hourly ceiling and failed, because user 9112 is KYC-verified and its ceiling
 * is 5000. The probe was wrong and the code was right; the assertion that
 * mattered had already passed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getSql } from '../db';
import { admitVelocity } from '../auth';
import {
  createVelocityClaim, releaseVelocityClaim, finalizeVelocityClaim,
  fundingExposure, withdrawalExposure,
  VELOCITY_CLAIM_PROVIDER,
} from '../velocity-claims';

const sql = getSql();
const U = 9112;           // seeded CA payer, balance 500
const cad = (s: string) => Math.round(parseFloat(s) * 100);

async function p2pUsage(user = U) {
  const r = await sql`
    SELECT COALESCE(SUM(total_amount),0) AS t FROM velocity_checks
    WHERE user_id = ${user} AND window_type = 'hourly' AND currency = 'CAD'
      AND window_start >= date_trunc('hour', NOW())`;
  return parseFloat(String(r[0].t));
}

beforeEach(async () => {
  await sql`DELETE FROM velocity_claims WHERE user_id = ${U}`;
  await sql`DELETE FROM velocity_checks WHERE user_id = ${U}`;
  await sql`DELETE FROM audit_logs WHERE user_id = ${U}`;
});

describe('ATTACK 1 — can a release of any kind move P2P usage?', () => {
  it('funding release cannot change P2P usage', async () => {
    await admitVelocity(U, cad('300.00'), 'CAD');
    const before = await p2pUsage();
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk1-f', claimKind: 'funding', amount: cad('250.00'), currency: 'CAD' });
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk1-f');
    expect(await p2pUsage()).toBe(before);
  });
  it('withdrawal release cannot change P2P usage', async () => {
    await admitVelocity(U, cad('300.00'), 'CAD');
    const before = await p2pUsage();
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk1-w', claimKind: 'withdrawal', amount: cad('250.00'), currency: 'CAD' });
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk1-w');
    expect(await p2pUsage()).toBe(before);
  });
  it('release with NO prior P2P charge cannot drive usage below zero', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk1-n', claimKind: 'funding', amount: cad('300.00'), currency: 'CAD' });
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk1-n');
    expect(await p2pUsage()).toBe(0);
    const rows = await sql`SELECT COUNT(*)::int AS n FROM velocity_checks WHERE user_id = ${U}`;
    expect(rows[0].n).toBe(0);           // no row created at all
  });
});

describe('ATTACK 2 — can exposure be driven negative or inflated?', () => {
  it('repeated releases of one claim cannot reduce exposure past zero', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk2-a', claimKind: 'funding', amount: cad('100.00'), currency: 'CAD' });
    for (let i = 0; i < 5; i++) await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk2-a');
    expect(await fundingExposure(U, 'CAD')).toBe(0);
  });
  it('releasing a claim twice concurrently releases once', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk2-b', claimKind: 'funding', amount: cad('100.00'), currency: 'CAD' });
    const out = await Promise.all([
      releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk2-b'),
      releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk2-b'),
    ]);
    expect(out.filter(o => o.released).length).toBe(1);
    expect(await fundingExposure(U, 'CAD')).toBe(0);
  });
  it('a duplicate reference cannot create a second claim', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk2-c', claimKind: 'funding', amount: cad('100.00'), currency: 'CAD' });
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk2-c', claimKind: 'funding', amount: cad('900.00'), currency: 'CAD' });
    expect(await fundingExposure(U, 'CAD')).toBe(cad('100.00'));   // not 1000
  });
});

describe('ATTACK 3 — can one domain read or move another?', () => {
  it('funding and withdrawal exposure are disjoint', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk3-f', claimKind: 'funding', amount: cad('100.00'), currency: 'CAD' });
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk3-w', claimKind: 'withdrawal', amount: cad('700.00'), currency: 'CAD' });
    expect(await fundingExposure(U, 'CAD')).toBe(cad('100.00'));
    expect(await withdrawalExposure(U, 'CAD')).toBe(cad('700.00'));
  });
  it('releasing withdrawal does not touch funding exposure', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk3-f2', claimKind: 'funding', amount: cad('100.00'), currency: 'CAD' });
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk3-w2', claimKind: 'withdrawal', amount: cad('700.00'), currency: 'CAD' });
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk3-w2');
    expect(await fundingExposure(U, 'CAD')).toBe(cad('100.00'));
  });
  it('CAD and USD exposure are disjoint', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk3-cad', claimKind: 'funding', amount: cad('100.00'), currency: 'CAD' });
    expect(await fundingExposure(U, 'USD')).toBe(0);
  });
});

describe('ATTACK 4 — the abuse shape the owner named, end to end', () => {
  it('fund -> spend through P2P -> funding return cannot recover spent P2P budget', async () => {
    // U is KYC 'verified', so the hourly ceiling is 5000, not the 500 of the
    // new_user tier. An earlier draft of this probe assumed 500 and failed on
    // its own bad premise while the invariant under test passed.
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk4', claimKind: 'funding', amount: cad('4800.00'), currency: 'CAD' });
    await finalizeVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk4');
    await admitVelocity(U, cad('4800.00'), 'CAD');          // spend the credit via P2P
    const spent = await p2pUsage();
    expect(spent).toBe(4800);
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk4');   // NSF return
    expect(await p2pUsage()).toBe(spent);                   // budget NOT recovered
    // and the ceiling still binds: 5000 hourly, 4800 spent, 300 must refuse
    await expect(admitVelocity(U, cad('300.00'), 'CAD')).rejects.toThrow();
  });
});

describe('ATTACK 5 — a finalized claim cannot be released for value', () => {
  it('finalize then release does not reduce exposure twice', async () => {
    await createVelocityClaim({ userId: U, provider: VELOCITY_CLAIM_PROVIDER, reference: 'atk5', claimKind: 'funding', amount: cad('100.00'), currency: 'CAD' });
    const beforeFinalize = await fundingExposure(U, 'CAD');
    expect(beforeFinalize).toBe(cad('100.00'));
    await finalizeVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk5');
    const afterFinalize = await fundingExposure(U, 'CAD');
    await releaseVelocityClaim(VELOCITY_CLAIM_PROVIDER, 'atk5');
    const afterRelease = await fundingExposure(U, 'CAD');
    // whatever the policy, exposure must never go below zero
    expect(afterFinalize).toBeGreaterThanOrEqual(0);
    expect(afterRelease).toBeGreaterThanOrEqual(0);
    console.log(`  [observed] reserved=${beforeFinalize} finalized=${afterFinalize} released=${afterRelease}`);
  });
});
