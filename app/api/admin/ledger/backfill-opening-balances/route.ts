import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { backfillOpeningBalances } from '@/lib/ledger';

// POST /api/admin/ledger/backfill-opening-balances
// Creates opening_balance ledger entries for users with seed balances but no ledger entries.
// Protection: Requires auth + BACKFILL_SECRET env var (temporary, for setup only)
// Idempotent: Safe to call multiple times (skips users who already have opening_balance entries)
// Does NOT modify user balances.
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
      }, { status: 503 });
    }

    if (!secret || secret !== expectedSecret) {
      return NextResponse.json({ error: 'Invalid or missing x-backfill-secret header' }, { status: 403 });
    }

    // Run backfill
    const result = await backfillOpeningBalances();

    return NextResponse.json({
      success: true,
      message: 'Opening balance backfill completed',
      created: {
        cad_entries: result.cadCount,
        usd_entries: result.usdCount,
        total_entries: result.cadCount + result.usdCount,
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
    usage: 'curl -X POST https://carloscab74.vercel.app/api/admin/ledger/backfill-opening-balances -H "x-backfill-secret: YOUR_SECRET"',
  });
}
