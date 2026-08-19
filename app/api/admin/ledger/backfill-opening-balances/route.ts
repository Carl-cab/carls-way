import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAdminAuth, withAuditLog, requirePermission } from '@/lib/rbac';
import { getSql } from '@/lib/db';

// POST /api/admin/ledger/backfill-opening-balances
// Creates opening_balance ledger entries for users with seed balances but no ledger entries.
//
// Authorization (defence in depth, all required):
//   1. A valid admin session      (withAdminAuth)
//   2. The 'exceptions:manage' permission — SuperAdmin / OperationsAdmin only.
//      This is a privileged ledger mutation, so it is deliberately held to the
//      same bar as other operational remediation actions.
//   3. A matching x-backfill-secret header, retained as a second factor.
// Every invocation is recorded by withAuditLog.
//
// Idempotent: Safe to call multiple times (skips users who already have opening_balance entries)
// Does NOT modify user balances.
// Supports ?dryRun=true for preview without writing.
async function backfillHandler(req: NextRequest): Promise<NextResponse> {
  try {
    // Authorization beyond authentication: this endpoint writes to the ledger.
    requirePermission('exceptions:manage');

    // Retained as an additional factor on top of admin authorization.
    const secret = req.headers.get('x-backfill-secret');
    const expectedSecret = process.env.BACKFILL_SECRET;

    if (!expectedSecret) {
      return NextResponse.json({
        error: 'Backfill not enabled (BACKFILL_SECRET env var not set)',
      }, { status: 503 });
    }

    if (!secret || secret !== expectedSecret) {
      return NextResponse.json({ error: 'Invalid or missing x-backfill-secret header' }, { status: 403 });
    }

    // Check for dry-run mode
    const url = new URL(req.url);
    const dryRun = url.searchParams.get('dryRun') === 'true';

    const sql = getSql();

    if (dryRun) {
      // Preview mode: count what would be created without writing
      const cadPreview = await sql`
        SELECT COUNT(*) as count FROM users u
        WHERE u.balance_cad > 0
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries le
            WHERE le.user_id = u.id
              AND le.currency = 'CAD'
              AND le.entry_type = 'opening_balance'
          )
      `;

      const usdPreview = await sql`
        SELECT COUNT(*) as count FROM users u
        WHERE u.balance_usd > 0
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries le
            WHERE le.user_id = u.id
              AND le.currency = 'USD'
              AND le.entry_type = 'opening_balance'
          )
      `;

      const cadCount = parseInt(String(cadPreview[0]?.count || '0'));
      const usdCount = parseInt(String(usdPreview[0]?.count || '0'));

      return NextResponse.json({
        success: true,
        dryRun: true,
        message: 'Dry run: no entries created',
        preview: {
          cad_entries_to_create: cadCount,
          usd_entries_to_create: usdCount,
          total_entries_to_create: cadCount + usdCount,
        },
      });
    }

    // Execute backfill
    const cadResults = await sql`
      INSERT INTO ledger_entries (
        user_id, currency, account_type, entry_type,
        debit, credit, description
      )
      SELECT
        u.id,
        'CAD',
        'wallet',
        'opening_balance',
        0,
        u.balance_cad,
        'Opening seed balance'
      FROM users u
      WHERE u.balance_cad > 0
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries le
          WHERE le.user_id = u.id
            AND le.currency = 'CAD'
            AND le.entry_type = 'opening_balance'
        )
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `;

    const usdResults = await sql`
      INSERT INTO ledger_entries (
        user_id, currency, account_type, entry_type,
        debit, credit, description
      )
      SELECT
        u.id,
        'USD',
        'wallet',
        'opening_balance',
        0,
        u.balance_usd,
        'Opening seed balance'
      FROM users u
      WHERE u.balance_usd > 0
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries le
          WHERE le.user_id = u.id
            AND le.currency = 'USD'
            AND le.entry_type = 'opening_balance'
        )
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `;

    const cadCount = cadResults.length;
    const usdCount = usdResults.length;

    return NextResponse.json({
      success: true,
      dryRun: false,
      message: 'Opening balance backfill completed',
      created: {
        cad_entries: cadCount,
        usd_entries: usdCount,
        total_entries: cadCount + usdCount,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('Permission denied')) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error('Backfill error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET — reports whether the endpoint is enabled.
// Previously unauthenticated, which disclosed deployment configuration state to
// anonymous callers. Now held to the same admin authorization bar as POST.
async function statusHandler(): Promise<NextResponse> {
  try {
    requirePermission('exceptions:manage');
  } catch (err) {
    if (err instanceof Error && err.message.includes('Permission denied')) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  return NextResponse.json({
    status: process.env.BACKFILL_SECRET ? 'enabled' : 'disabled',
    message: 'POST with the x-backfill-secret header to backfill opening balances.',
  });
}

export const POST = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, backfillHandler, {
      action: 'backfill_opening_balances',
      resourceType: 'ledger_entry',
    }),
  );

export const GET = (req: NextRequest) =>
  withAdminAuth(req, (r) =>
    withAuditLog(r, statusHandler, {
      action: 'read_backfill_status',
      resourceType: 'ledger_entry',
    }),
  );
