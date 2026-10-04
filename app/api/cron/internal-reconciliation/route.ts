import { NextRequest, NextResponse } from 'next/server';
import { authorizeCronRequest } from '@/lib/cron-auth';
import { getSql } from '@/lib/db';
import { reconcileInternalTransactions } from '@/lib/internal-reconciliation';
import { reconcileExternalSettlements } from '@/lib/external-settlement-reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Single daily cron for internal and external reconciliation. This route has
 * no money-moving side effects: it compares persisted evidence, then writes
 * durable operational audit records containing only aggregate check counts.
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

  try {
    const sql = getSql();
    const reconciliation = await sql.begin(async (tx) => {
      const internal = await reconcileInternalTransactions(tx);
      const external = await reconcileExternalSettlements(tx);
      await tx`
        INSERT INTO audit_logs (user_id, action, metadata)
        VALUES (
          NULL,
          ${internal.passed ? 'internal_reconciliation_passed' : 'internal_reconciliation_failed'},
          ${JSON.stringify({
            source: 'vercel_cron',
            passed: internal.passed,
            checks: internal.checks,
          })}
        )
      `;
      await tx`
        INSERT INTO audit_logs (user_id, action, metadata)
        VALUES (
          NULL,
          ${external.passed ? 'external_settlement_reconciliation_passed' : 'external_settlement_reconciliation_failed'},
          ${JSON.stringify({ source: 'vercel_cron', passed: external.passed, checks: external.checks })}
        )
      `;
      return { internal, external };
    });

    const response = {
      passed: reconciliation.internal.passed && reconciliation.external.passed,
      checks: reconciliation.internal.checks,
      external: reconciliation.external,
    };

    if (!response.passed) {
      console.error('Internal reconciliation discrepancy detected.', response);
      return NextResponse.json(response, { status: 500 });
    }

    console.info('Internal reconciliation passed.', response);
    return NextResponse.json(response, { status: 200 });
  } catch {
    // Error objects may include SQL, credentials or provider data. Never log them.
    console.error('Combined reconciliation cron failed.');
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 500 });
  }
}
