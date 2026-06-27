import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { getSql } from '@/lib/db';

// POST /api/admin/ledger/backfill-opening-balances
// Creates opening_balance ledger entries for users with seed balances but no ledger entries.
// Protection: Requires auth + BACKFILL_SECRET env var (temporary, for setup only)
// Idempotent: Safe to call multiple times (skips users who already have opening_balance entries)
// Does NOT modify user balances.
// Supports ?dryRun=true for preview without writing.
export async function POST(req: Request) {
  try {
    // Require authentication
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Require BACKFILL_SECRET (temporary protection until admin roles exist)
    const secret = req.headers.get('x-backfill-secret');
    const expectedSecret = process.env.BACKFILL_SECRET;

    if (!expectedSecret) {
      return NextResponse.json({
        error: 'Backfill not enabled (BACKFILL_SECRET env var not set)',
        info: 'Set BACKFILL_SECRET env var in Vercel to enable this endpoint',
      }, { status: 500 });
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
    console.error('Backfill error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET — returns status and instructions
export async function GET() {
  const secretIsSet = !!process.env.BACKFILL_SECRET;

  return NextResponse.json({
    status: secretIsSet ? 'enabled' : 'disabled',
    message: secretIsSet
      ? 'POST to this endpoint with x-backfill-secret header to backfill opening balances'
      : 'Set BACKFILL_SECRET env var in Vercel to enable',
    usage: {
      dry_run: 'curl -X POST "https://carloscab74.vercel.app/api/admin/ledger/backfill-opening-balances?dryRun=true" -H "x-backfill-secret: YOUR_SECRET"',
      execute: 'curl -X POST https://carloscab74.vercel.app/api/admin/ledger/backfill-opening-balances -H "x-backfill-secret: YOUR_SECRET"',
    },
  });
}
