import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest } from '@/lib/cron-auth';
import { getSql } from '@/lib/db';
import { reconcileInternalTransactions } from '@/lib/internal-reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Daily internal ledger reconciliation. This route has no money-moving side
 * effects: it compares database-side NUMERIC values, then writes a compact
 * operational audit record containing only aggregate check counts.
 *
 * A non-2xx response is intentional when a discrepancy or infrastructure
 * failure occurs. It makes the exception visible in Vercel Cron logs without
 * ever attempting an automatic financial correction.
 */
export async function GET(request: NextRequest) {
  const authorization = authorizeCronRequest(request.headers.get('authorization'));
  if (authorization === 'misconfigured') {
    console.error('Internal reconciliation cron refused: CRON_SECRET is not configured.');
    return NextResponse.json({ error: 'Cron job configuration unavailable' }, { status: 503 });
  }

  if (authorization !== 'authorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const scheduledBy = request.headers.get('x-vercel-cron-schedule');

  try {
    const sql = getSql();
    const reconciliation = await sql.begin(async (tx) => {
      const result = await reconcileInternalTransactions(tx);
      await tx`
        INSERT INTO audit_logs (user_id, action, metadata)
        VALUES (
          NULL,
          ${result.passed ? 'internal_reconciliation_passed' : 'internal_reconciliation_failed'},
          ${JSON.stringify({
            source: 'vercel_cron',
            schedule: scheduledBy,
            passed: result.passed,
            checks: result.checks,
          })}
        )
      `;
      return result;
    });

    const response = {
      passed: reconciliation.passed,
      checks: reconciliation.checks,
    };

    if (!reconciliation.passed) {
      console.error('Internal reconciliation discrepancy detected.', response);
      return NextResponse.json(response, { status: 500 });
    }

    console.info('Internal reconciliation passed.', response);
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('Internal reconciliation cron failed.', error);
    return NextResponse.json({ error: 'Internal reconciliation failed' }, { status: 500 });
  }
}
