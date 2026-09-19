import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser, auditLog } from '@/lib/auth';
import { getTransferProvider, toExecutionMode } from '@/lib/transfers/router';

/**
 * executeTransfer() is typed Promise<never> — every provider signals its
 * outcome by throwing. A tagged `__submitted` error means the provider
 * accepted the transfer and the intent is now `processing`; any other error
 * (a sandbox provider's "not supported", a declined authorization, a network
 * failure) is a genuine execution failure.
 */
interface SubmittedSignal {
  __submitted: true;
  plaid_transfer_id?: string;
  stripe_reference_id?: string;
}

function isSubmittedSignal(err: unknown): err is SubmittedSignal {
  return typeof err === 'object' && err !== null && (err as { __submitted?: unknown }).__submitted === true;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const intentId = parseInt(id);
    if (isNaN(intentId)) return NextResponse.json({ error: 'Invalid intent ID' }, { status: 400 });

    const sql = getSql();

    const rows = await sql`
      SELECT user_id, status, execution_mode, provider_region, provider_reference_id
      FROM transfer_intents
      WHERE id = ${intentId}
    `;
    if (!rows[0]) return NextResponse.json({ error: 'Transfer intent not found' }, { status: 404 });

    const intent = rows[0];
    if (intent.user_id !== user.userId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Idempotency guard: a double-submit must never create a second provider
    // transfer. Once the intent is processing with a provider reference on
    // file, the transfer was already submitted — return that state as-is.
    if (intent.status === 'processing' && intent.provider_reference_id) {
      return NextResponse.json({
        success: true,
        intent_id: intentId,
        status: 'processing',
        provider_reference_id: intent.provider_reference_id,
        message: 'Transfer already submitted to provider.',
      });
    }

    if (intent.status !== 'ready') {
      return NextResponse.json(
        { error: `Cannot execute intent in status: ${intent.status}. Must be 'ready'.` },
        { status: 409 },
      );
    }

    if (intent.execution_mode !== 'live') {
      return NextResponse.json(
        { error: 'Execute is only available for live transfers. This intent settles at confirm.' },
        { status: 400 },
      );
    }

    const region = intent.provider_region as 'US' | 'CA';
    const provider = getTransferProvider(region, toExecutionMode(intent.execution_mode as string));

    try {
      await provider.executeTransfer(intentId, user.userId);
      // Unreachable: executeTransfer() always throws (Promise<never>).
      return NextResponse.json({ error: 'Provider did not report an outcome' }, { status: 502 });
    } catch (err) {
      if (isSubmittedSignal(err)) {
        const providerReferenceId = err.plaid_transfer_id ?? err.stripe_reference_id ?? null;

        await sql`
          UPDATE transfer_intents
          SET status = 'processing',
              provider_reference_id = COALESCE(provider_reference_id, ${providerReferenceId}),
              updated_at = NOW()
          WHERE id = ${intentId}
        `;

        await auditLog(user.userId, 'transfer_executed', {
          intent_id: intentId,
          provider_reference_id: providerReferenceId,
        });

        return NextResponse.json({
          success: true,
          intent_id: intentId,
          status: 'processing',
          provider_reference_id: providerReferenceId,
        });
      }

      // A genuine provider failure — including a sandbox provider throwing by
      // design, which should never reach here once execution_mode is 'live',
      // but is not swallowed if it does.
      const message = err instanceof Error ? err.message : 'Provider execution failed';
      console.error('Transfer execute error:', err);
      return NextResponse.json({ error: `Transfer execution failed: ${message}` }, { status: 502 });
    }
  } catch (err) {
    console.error('Transfer execute error:', err);
    return NextResponse.json({ error: 'Failed to execute transfer' }, { status: 500 });
  }
}
