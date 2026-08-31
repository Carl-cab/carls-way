import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, auditLog, sanitizeString } from '@/lib/auth';
import { getSql } from '@/lib/db';
import { createNotification } from '@/lib/notifications';
import {
  createSplit,
  divideEvenly,
  listSplitsForUser,
  SplitValidationError,
} from '@/lib/splits';

/** GET /api/splits — splits the caller created or participates in. */
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    return NextResponse.json(await listSplitsForUser(user.userId));
  } catch (err) {
    console.error('Splits GET error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/splits — create a bill split.
 *
 * Body: { totalAmount, description?, currency?, participants: [{ username, amount? }] }
 *
 * Omit every `amount` to divide evenly; remainder cents are distributed
 * deterministically so portions always sum exactly to the total. Participants
 * are resolved by username server-side — the caller never supplies user ids.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const totalAmount = parseFloat(body.totalAmount);
    const description = sanitizeString(body.description || '', 200) || null;
    const usernames: string[] = Array.isArray(body.participants)
      ? body.participants.map((p: { username?: string }) => String(p?.username ?? '').replace('@', ''))
      : [];

    if (!Number.isFinite(totalAmount) || totalAmount <= 0 || totalAmount > 10000) {
      return NextResponse.json(
        { error: 'Total amount must be between $0.01 and $10,000' },
        { status: 400 },
      );
    }
    if (usernames.length === 0 || usernames.some((u) => !u)) {
      return NextResponse.json({ error: 'At least one participant is required' }, { status: 400 });
    }

    const sql = getSql();

    // The creator's currency governs the split; Manna balances are per-currency.
    const meRows = await sql`SELECT country FROM users WHERE id = ${user.userId}`;
    const currency = meRows[0]?.country === 'US' ? 'USD' : 'CAD';

    const found = await sql`
      SELECT id, username FROM users WHERE username = ANY(${usernames})
    `;
    if (found.length !== usernames.length) {
      const missing = usernames.filter((u) => !found.some((f) => f.username === u));
      return NextResponse.json(
        { error: `Unknown participant(s): ${missing.join(', ')}` },
        { status: 404 },
      );
    }

    const explicit = Array.isArray(body.participants)
      ? body.participants.map((p: { amount?: number }) => p?.amount)
      : [];
    const useEven = explicit.every((a: unknown) => a === undefined || a === null);
    const portions = useEven
      ? divideEvenly(totalAmount, found.length)
      : explicit.map((a: unknown) => parseFloat(String(a)));

    const participants = found.map((f, i) => ({
      userId: f.id as number,
      amountOwed: portions[i],
    }));

    const { split, participants: rows } = await createSplit(
      user.userId,
      totalAmount,
      currency,
      description,
      participants,
    );

    await auditLog(user.userId, 'split_created', {
      split_id: split.id,
      total_amount: totalAmount,
      currency,
      participant_count: rows.length,
    });

    const label = new Intl.NumberFormat('en-CA', { style: 'currency', currency });
    await Promise.all(
      rows.map((p) =>
        createNotification({
          userId: p.user_id,
          type: 'split_request',
          title: 'You were added to a split',
          message: `@${user.username} split ${description || 'a bill'} with you. Your share is ${label.format(Number(p.amount_owed))}.`,
          relatedEntityType: 'split',
          relatedEntityId: split.id,
        }),
      ),
    );

    return NextResponse.json({ success: true, split, participants: rows }, { status: 201 });
  } catch (err) {
    if (err instanceof SplitValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('Splits POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
