import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser } from '@/lib/auth';
import {
  getTransferProvider,
  toExecutionMode,
  type ExecutionMode,
  type UserRegion,
} from '@/lib/providers/TransferProviderFactory';
import type { TransferProvider } from '@/lib/providers/TransferProvider';
import { logRedactedError } from '@/lib/plaid-error';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';

/**
 * Submit a confirmed live transfer to its provider.
 *
 * The live lifecycle is create → review → confirm (`ready`) → execute
 * (`processing`) → webhook → settled. Sandbox transfers settle inside confirm
 * and must never reach a payment rail from here.
 *
 * Two gates sit in front of the provider call:
 *
 *   1. The intent itself must be `execution_mode = 'live'` and `status = 'ready'`.
 *   2. `getTransferProvider` re-reads the live flags. With `PLAID_TRANSFER_LIVE`
 *      and `CA_EFT_LIVE` off it returns the sandbox provider, and this route
 *      refuses before `executeTransfer`. Nothing real moves while the flags
 *      are off, even if a row was stored as live.
 *
 * The status claim is a single conditional update inside `SELECT … FOR UPDATE`.
 * Concurrent submits serialise on the row; only the one that still sees `ready`
 * proceeds, so two requests cannot both call the provider.
 */
interface SubmittedSignal extends Error {
  __submitted?: boolean;
  status?: string;
  plaid_transfer_id?: string;
  stripe_reference_id?: string;
}

type ClaimResult =
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'not_live'; mode: string }
  | { kind: 'wrong_status'; status: string }
  | { kind: 'live_disabled' }
  | { kind: 'claimed'; provider: TransferProvider };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const intentId = parseInt(id, 10);
    if (isNaN(intentId)) return NextResponse.json({ error: 'Invalid intent ID' }, { status: 400 });

    // Every other money path carries a limit; this one reaches a payment rail
    // and had none. Keyed on the user id rather than the client IP: the call is
    // always authenticated, so the account is the right subject, and an IP key
    // would both lump a shared network together and reset on a new one.
    //
    // The FOR UPDATE claim below already prevents one intent being submitted
    // twice. This is the orthogonal bound the claim does not provide — how many
    // separate intents a single account can push at a rail in one window.
    const limit = await checkRateLimit('money:transfer-execute', String(user.userId));
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'Too many transfer submissions. Please try again later. No funds were moved.' },
        { status: 429, headers: rateLimitHeaders(limit) },
      );
    }

    const sql = getSql();

    const claim = await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, user_id, status, execution_mode, provider_region
        FROM transfer_intents
        WHERE id = ${intentId}
        FOR UPDATE
      `;
      if (!rows[0]) return { kind: 'missing' } satisfies ClaimResult;

      const row = rows[0] as {
        user_id: number;
        status: string;
        execution_mode: string;
        provider_region: string;
      };

      if (Number(row.user_id) !== user.userId) {
        return { kind: 'forbidden' } satisfies ClaimResult;
      }

      // Sandbox rows settle on confirm. Executing them would be a second
      // movement, and the sandbox providers throw on executeTransfer by design.
      if (row.execution_mode !== 'live') {
        return { kind: 'not_live', mode: row.execution_mode } satisfies ClaimResult;
      }

      if (row.status !== 'ready') {
        return { kind: 'wrong_status', status: row.status } satisfies ClaimResult;
      }

      const region = (row.provider_region === 'US' ? 'US' : 'CA') as UserRegion;
      const mode: ExecutionMode = toExecutionMode(row.execution_mode);
      const provider = getTransferProvider(region, mode);

      // Flags off: the factory falls back to sandbox. Refuse without claiming
      // the row and without calling executeTransfer, so a disabled rail cannot
      // strand the intent in `submitting` or touch a provider.
      if (provider.executionMode !== 'live') {
        return { kind: 'live_disabled' } satisfies ClaimResult;
      }

      const updated = await tx`
        UPDATE transfer_intents
        SET status = 'submitting', updated_at = NOW()
        WHERE id = ${intentId}
          AND user_id = ${user.userId}
          AND status = 'ready'
          AND execution_mode = 'live'
        RETURNING id
      `;
      if (!updated[0]) {
        // Defensive: the three conditions were just verified under this row's
        // FOR UPDATE lock, so nothing should slip between. Report the status
        // actually read rather than the literal 'ready', which produced
        // "Cannot execute a transfer in status 'ready'. It must be ready." —
        // a self-contradiction in front of whoever is debugging a live
        // transfer.
        return { kind: 'wrong_status', status: row.status } satisfies ClaimResult;
      }

      return { kind: 'claimed', provider } satisfies ClaimResult;
    });

    if (claim.kind === 'missing') {
      return NextResponse.json({ error: 'Transfer intent not found' }, { status: 404 });
    }
    if (claim.kind === 'forbidden') {
      return NextResponse.json({ error: 'You do not have access to this transfer' }, { status: 403 });
    }
    if (claim.kind === 'not_live') {
      return NextResponse.json(
        {
          error: `Only live transfers can be executed. This transfer is in ${claim.mode} mode.`,
        },
        { status: 409 },
      );
    }
    if (claim.kind === 'live_disabled') {
      return NextResponse.json(
        { error: 'Live transfers are not enabled. No funds were moved.' },
        { status: 409 },
      );
    }
    if (claim.kind === 'wrong_status') {
      return NextResponse.json(
        { error: `Cannot execute a transfer in status '${claim.status}'. It must be ready.` },
        { status: 409 },
      );
    }

    try {
      await claim.provider.executeTransfer(intentId, user.userId);
    } catch (err) {
      const submitted = err as SubmittedSignal;
      if (!submitted.__submitted) throw err;

      // Providers signal a successful submit by throwing, after they have
      // recorded `processing` themselves. If a provider reported success while
      // the row is still `submitting` (the claim this route took), finish that
      // transition here. The WHERE clause does not overwrite a later status.
      await sql`
        UPDATE transfer_intents
        SET status = 'processing', updated_at = NOW()
        WHERE id = ${intentId} AND status = 'submitting'
      `;

      return NextResponse.json({
        success: true,
        intent_id: intentId,
        status: submitted.status ?? 'processing',
        provider_reference_id:
          submitted.plaid_transfer_id ?? submitted.stripe_reference_id ?? null,
      });
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'processing', updated_at = NOW()
      WHERE id = ${intentId} AND status = 'submitting'
    `;

    return NextResponse.json({
      success: true,
      intent_id: intentId,
      status: 'processing',
    });
  } catch (err) {
    logRedactedError('Transfer execute error:', err);
    return NextResponse.json({ error: 'Failed to execute transfer' }, { status: 500 });
  }
}
