import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import { assertCapabilityAllowed, BetaRestrictionError } from '@/lib/beta-restrictions';
import { getTransferProvider, toExecutionMode } from '@/lib/transfers/router';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const intentId = parseInt(id);
    if (isNaN(intentId)) return NextResponse.json({ error: 'Invalid intent ID' }, { status: 400 });

    const sql = getSql();

    // Verify intent ownership and current status
    const intentRows = await sql`
      SELECT provider_region, execution_mode, status, type FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${user.userId}
    `;
    if (!intentRows[0]) return NextResponse.json({ error: 'Transfer intent not found' }, { status: 404 });
    if (intentRows[0].status !== 'draft') {
      return NextResponse.json({ error: `Cannot confirm intent in status: ${intentRows[0].status}` }, { status: 409 });
    }

    // DEFENCE IN DEPTH, and not redundant with the gate on the intent route.
    // Confirm is where the money actually moves: `confirmTransfer()` settles
    // the platform balance and writes a ledger entry. An intent created
    // BEFORE the restriction took effect — or created while the profile was
    // unrestricted and confirmed after it changed — would otherwise still
    // settle. The gate belongs next to the movement, which is the lesson
    // `money:split-pay` taught: a control that lives only where an object is
    // created is missed by every path that acts on it later.
    assertCapabilityAllowed(
      (intentRows[0].type as string) === 'add_money' ? 'funding' : 'cash_out',
    );

    const region = intentRows[0].provider_region as 'US' | 'CA';
    const provider = getTransferProvider(region, toExecutionMode(intentRows[0].execution_mode as string));
    const result = await provider.confirmTransfer(intentId, user.userId);

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof BetaRestrictionError) {
      return NextResponse.json(
        { error: err.message, code: 'BETA_RESTRICTED', capability: err.capability },
        { status: 403 },
      );
    }
    if (err instanceof Error && err.message === 'INSUFFICIENT_BALANCE') {
      return NextResponse.json({ error: 'Insufficient balance to cash out this amount.' }, { status: 400 });
    }
    console.error('Transfer confirm error:', err);
    return NextResponse.json({ error: 'Failed to confirm transfer' }, { status: 500 });
  }
}
