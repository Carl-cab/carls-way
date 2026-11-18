/**
 * Static guard: every balance-moving route is accounted for under the
 * restricted beta profile.
 *
 * WHY A STATIC GUARD AND NOT MORE ROUTE TESTS. The cross-currency restriction
 * was added at `POST /api/transactions` and missed at
 * `PATCH /api/transactions/[id]`, where an existing request is accepted. A
 * cross-currency request created before the restriction could still be
 * accepted afterwards and move funds. Independent inspection found it; the
 * route tests did not, because a test only covers the route someone thought
 * to write it for.
 *
 * That is the same failure shape as the velocity work: a control copied from
 * path to path, with one path forgotten. `velocity-admission-callers.test.ts`
 * answered it with a static guard over callers, and this is its counterpart
 * for the beta profile — it fails when a NEW route starts moving money
 * without anyone deciding what the profile should do about it.
 *
 * WHAT IT ASSERTS. Every `app/api/**\/route.ts` that moves a balance, writes a
 * ledger entry or settles a transfer must either reference
 * `beta-restrictions`, or appear below with a written reason. The allowlist is
 * the point: it forces the decision to be recorded rather than defaulted.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const API_ROOT = path.join(process.cwd(), 'app/api');

/** Markers that a route moves money or records that money moved. */
const MONEY_MARKERS = [
  'balance_cad',
  'balance_usd',
  'createLedgerPair',
  'createCrossBorderLedgerPair',
  'createLedgerEntry',
  'settleSandboxTransfer',
  'confirmTransfer',
  'paySplitPortion',
  'applySettlementAtomically',
];

/**
 * Routes that move money and deliberately carry NO beta gate, each with the
 * reason it does not need one. A route added here without a reason is a route
 * nobody thought about.
 */
const ALLOWLIST: Record<string, string> = {
  'auth/register/route.ts':
    'The approved sandbox registration grant. It is itself gated on ' +
    'isSandboxEnvironment() and grants nothing in production, and the beta ' +
    'profile deliberately does not withhold it — the owner approved the ' +
    'CA$100/US$100 grant for the beta, so restricting it would remove the ' +
    'thing participants need in order to send anything at all.',

  'splits/[id]/pay/route.ts':
    'SINGLE-CURRENCY BY CONSTRUCTION, so the cross-currency restriction does ' +
    'not apply and adding one would be an unnecessary restriction. ' +
    'paySplitPortion() reads `participant.currency` — the split\'s currency, ' +
    'set from the creator — and uses that ONE currency for both the payer\'s ' +
    'debit and the creator\'s credit. No FX quote is requested and no ' +
    'conversion occurs. A payer whose country differs from the split\'s ' +
    'currency is simply debited in that currency and fails the balance guard ' +
    'if they do not hold it; nothing is converted. Funding and cash-out are ' +
    'not reachable here either.',

  'transfers/[id]/execute/route.ts':
    'Live rails only, and both flags are off. The route refuses unless the ' +
    'intent is execution_mode=live AND status=ready AND the factory returns ' +
    'a live provider; with PLAID_TRANSFER_LIVE and CA_EFT_LIVE unset no live ' +
    'intent can be created and the factory returns sandbox, so it refuses ' +
    'before claiming. It moves no balance itself in any case — settlement ' +
    'does, through the webhook path.',

  'webhooks/plaid/route.ts':
    'Settles LIVE intents only, via applySettlementAtomically. With both ' +
    'live flags off no live intent exists for it to settle, so there is no ' +
    'beta-reachable money movement here. Its authorization is provider ' +
    'signature verification, not the user session the profile applies to.',

  'webhooks/stripe/route.ts':
    'Same as the Plaid webhook: it settles LIVE intents only through the ' +
    'settlement engine, and with CA_EFT_LIVE off no live intent exists for ' +
    'it to settle. Authorized by Stripe signature verification rather than ' +
    'by the user session the beta profile applies to.',

  'admin/transfers/[id]/reconcile/route.ts':
    'Admin-only recovery path behind withAdminAuth plus a permission check. ' +
    'Not reachable by a beta participant, and it replays a provider ' +
    'authorization rather than originating money movement.',

  'admin/ledger/backfill-opening-balances/route.ts':
    'Retired. POST answers 410 Gone and writes nothing; GET is a read-only ' +
    'assessment. Admin-only regardless.',

  'dev/settlement-test/route.ts':
    'Development helper, not part of the beta surface. Listed so its ' +
    'presence is a recorded decision rather than an oversight — if it is ' +
    'ever reachable in a deployed environment it needs a gate.',

  'me/route.ts':
    'READ-ONLY. It exports GET only and SELECTs the balance columns as part ' +
    'of the signed-in user\'s profile; it issues no UPDATE and no INSERT. It ' +
    'matches the money markers because it reads those columns, which is the ' +
    'kind of false positive worth one allowlist entry rather than narrowing ' +
    'the markers until a real writer slips past.',

  'ledger/balance-check/route.ts':
    'READ-ONLY. It exports GET only and SELECTs balance_cad / balance_usd to ' +
    'compare a wallet against its ledger; it issues no UPDATE and no INSERT. ' +
    'It matches the money markers because it reads the balance columns, ' +
    'which is exactly the kind of false positive worth recording rather than ' +
    'narrowing the markers to miss a real writer later.',

  'migrate/route.ts':
    'Schema reconciler. It references paySplitPortion only in an operator ' +
    'error message, and moves no money.',
};

function routeFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, found);
    else if (entry === 'route.ts') found.push(full);
  }
  return found;
}

/**
 * Comments and ordinary quoted strings stripped, so prose cannot satisfy a
 * marker.
 *
 * TEMPLATE LITERALS ARE DELIBERATELY KEPT. Every query in this repository is
 * a postgres.js tagged template, so `UPDATE users SET balance_cad = ...`
 * lives inside backticks. An earlier version of this function stripped them
 * too, and the guard then detected almost nothing: a probe route doing
 * exactly that UPDATE, with no gate and no allowlist entry, PASSED. Measured.
 * The marker scan has to see the SQL or it is not scanning for money movement
 * at all.
 *
 * The cost is that a route merely mentioning a marker inside a template
 * string would be flagged. That is the right way round — a false positive is
 * one allowlist entry with a reason, a false negative is an ungated money
 * path.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

describe('every balance-moving API route is accounted for under the beta profile', () => {
  const files = routeFiles(API_ROOT);

  it('found a plausible number of API routes', () => {
    // Guards the scan. A broken walk would make every assertion below pass
    // against an empty list — a green test proving nothing.
    expect(files.length).toBeGreaterThan(40);
  });

  it('each one either references beta-restrictions or has a recorded reason', () => {
    const unaccounted: string[] = [];

    for (const file of files) {
      const rel = path.relative(API_ROOT, file);
      const raw = readFileSync(file, 'utf8');
      const body = code(raw);
      const movesMoney = MONEY_MARKERS.some((m) => body.includes(m));
      if (!movesMoney) continue;

      // The IMPORT is checked against the raw source, not the stripped body:
      // code() removes quoted strings, and the module specifier
      // '@/lib/beta-restrictions' is one. The first version of this guard
      // checked the stripped body and reported every gated route as ungated.
      const gated = raw.includes('beta-restrictions');
      const allowed = Object.prototype.hasOwnProperty.call(ALLOWLIST, rel);
      if (!gated && !allowed) unaccounted.push(rel);
    }

    expect(
      unaccounted,
      `${unaccounted.length} route(s) move money without referencing ` +
        `lib/beta-restrictions and without an entry in this file's ALLOWLIST: ` +
        `${unaccounted.join(', ')}. Either gate the route with ` +
        `assertCapabilityAllowed()/isCapabilityRestricted(), or add it to the ` +
        `allowlist WITH THE REASON it needs no gate. Do not add it with an ` +
        `empty reason — the allowlist exists to record a decision, not to ` +
        `silence this test.`,
    ).toEqual([]);
  });

  it('every allowlist entry names a real route and gives a substantive reason', () => {
    // An allowlist that drifts from the tree is worse than none: it would
    // keep excusing a route that has since been renamed, while the renamed
    // one goes unchecked.
    const existing = new Set(files.map((f) => path.relative(API_ROOT, f)));
    const stale = Object.keys(ALLOWLIST).filter((k) => !existing.has(k));
    expect(stale, `allowlist names route(s) that no longer exist: ${stale.join(', ')}`).toEqual([]);

    const thin = Object.entries(ALLOWLIST)
      .filter(([, reason]) => reason.trim().length < 80)
      .map(([k]) => k);
    expect(thin, `allowlist reason too short to be a decision: ${thin.join(', ')}`).toEqual([]);
  });

  it('the three capability-gated routes are gated', () => {
    // Named explicitly. The guard above proves nothing slipped through
    // unaccounted; this proves the three that MUST be gated still are, so
    // moving one into the allowlist would fail here.
    for (const rel of [
      'transfers/intent/route.ts',
      'transfers/[id]/confirm/route.ts',
      'transactions/route.ts',
      'transactions/[id]/route.ts',
    ]) {
      const raw = readFileSync(path.join(API_ROOT, rel), 'utf8');
      expect(raw, `${rel} must reference lib/beta-restrictions`).toContain('beta-restrictions');
    }
  });
});
