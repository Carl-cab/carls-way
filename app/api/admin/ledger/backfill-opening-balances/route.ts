import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { assessOpeningBalanceDiscrepancies } from '@/lib/ledger';

/**
 * Opening-balance endpoint — READ-ONLY since owner decision 3, 2026-11-18.
 *
 * WHAT THIS ENDPOINT USED TO DO, AND WHY IT NO LONGER DOES. `POST` ran a
 * backfill that credited each user's **current** balance as an
 * `opening_balance` ledger entry. For a user who had transacted, that books
 * their entire history a second time. Measured on a real sandbox database:
 *
 *     before:  wallet 1370.00   ledger 1270.00   discrepancy   +100.00
 *     after:   wallet 1370.00   ledger 2640.00   discrepancy  -1270.00
 *
 * The trap was that it looked like it helped — aggregate
 * `user_wallets_exactly_match_ledger` violations fell from 6 to 3, because
 * the accounts with no activity were corrected properly. An operator reading
 * that count would have concluded the repair worked.
 *
 * `POST` now answers **410 Gone** and writes nothing. It is deliberately not
 * deleted: a removed route 404s, and a 404 reads like a deployment problem to
 * an operator following an old runbook, who would then go looking for another
 * way to run the repair. A 410 with an explanation ends that search.
 *
 * `GET` is the read-only replacement: `assessOpeningBalanceDiscrepancies()`
 * reports what is wrong and never writes. It is a DIAGNOSTIC, not a repair,
 * and the distinction is the whole point of this change — the thing it
 * replaces looked like a repair and was a corruption.
 *
 * A real repair needs its own authorization, evidence of each account's
 * ORIGINAL grant, and a plan. `BACKFILL_SECRET` stays documented and unused
 * here rather than being removed, because removing it from the deployment is
 * the owner's configuration decision and not this route's to force.
 */

const RETIREMENT_NOTICE = {
  error: 'This repair operation is retired and performs no writes.',
  reason:
    'It credited each user’s CURRENT balance as an opening-balance entry, ' +
    'double-counting the entire history of every account that had transacted. ' +
    'Measured: a +100.00 discrepancy became -1270.00.',
  readOnlyAlternative:
    'GET this same path for a read-only assessment of opening-balance state.',
  toRepair:
    'A repair requires separate owner authorization, evidence of each ' +
    'account’s original grant, and a remediation plan. See ' +
    'docs/runbooks/opening-balance-remediation.md.',
} as const;

async function retiredRepairHandler(): Promise<NextResponse> {
  // Permission is still required before the explanation is returned: the
  // notice describes an internal accounting defect and the remediation path,
  // which is not information for an arbitrary authenticated caller.
  try {
    requirePermission('exceptions:manage');
  } catch (err) {
    if (err instanceof Error && err.message.includes('Permission denied')) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  // 410 Gone, before reading any header and before touching the database.
  // There is no branch below this that could write, which is the property
  // this route now has to guarantee.
  return NextResponse.json(RETIREMENT_NOTICE, { status: 410 });
}

async function assessmentHandler(): Promise<NextResponse> {
  try {
    requirePermission('exceptions:manage');
  } catch (err) {
    if (err instanceof Error && err.message.includes('Permission denied')) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  try {
    const assessment = await assessOpeningBalanceDiscrepancies();

    return NextResponse.json({
      success: true,
      readOnly: true,
      message:
        'Read-only assessment. No ledger entry or balance was created, ' +
        'modified or deleted.',
      summary: assessment.summary,
      withoutEvidencedGrant: assessment.withoutEvidencedGrant,
      guidance:
        'A null evidencedGrantMinorUnits means no independent evidence of the ' +
        'original grant exists for that account — NOT that the grant was ' +
        'zero, and NOT that it was 100.00. Those accounts cannot be repaired ' +
        'from this data alone.',
      rows: assessment.rows,
    });
  } catch (err) {
    console.error('Opening balance assessment error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, retiredRepairHandler, {
      // Still audited. An attempt to run a retired repair operation is
      // exactly the kind of thing an operator should be able to see later.
      action: 'attempted_retired_backfill_opening_balances',
      resourceType: 'ledger_entry',
    }),
  );

export const GET = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, assessmentHandler, {
      action: 'read_opening_balance_assessment',
      resourceType: 'ledger_entry',
    }),
  );
