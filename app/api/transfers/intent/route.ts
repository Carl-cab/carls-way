import { NextResponse } from 'next/server';
import { getSql } from '@/lib/db';
import { getAuthUser, checkVelocityLimit, auditLog } from '@/lib/auth';
import { getTransferProvider, regionFromCountry, resolveExecutionMode } from '@/lib/transfers/router';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { MoneyValidationError, isMoneyCurrency, parsePositiveMoney, toDatabaseDecimal } from '@/lib/money';
import { assertCapabilityAllowed, BetaRestrictionError } from '@/lib/beta-restrictions';

export async function POST(req: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // C1.1: blunt abusive automation of transfer intents without impeding a
    // person making several genuine transfers. Keyed on the user, not the IP,
    // so one abusive client cannot lock out everybody else.
    const rate = await checkRateLimit('money:send', `user:${user.userId}`);
    if (!rate.allowed) {
      await auditLog(user.userId, 'transfer_intent_rate_limited', {});
      return NextResponse.json(
        { error: 'Too many transfer attempts. Please try again later.' },
        { status: 429, headers: rateLimitHeaders(rate) },
      );
    }

    const sql = getSql();

    // Body parsed and the transfer type validated FIRST, ahead of every
    // database read, so the restricted-beta gate below can run before any
    // query. This order was corrected after the gate's own test caught it:
    // the gate originally sat after the user and bank-account lookups, which
    // made its comment false and meant a withheld capability still cost two
    // queries.
    const body = await req.json() as { type?: string; amount?: unknown; currency?: string };
    const { type, amount, currency } = body;

    if (!type || amount === undefined || amount === null || !currency) {
      return NextResponse.json({ error: 'Missing required fields: type, amount, currency' }, { status: 400 });
    }
    if (!['add_money', 'cash_out'].includes(type)) {
      return NextResponse.json({ error: 'type must be add_money or cash_out' }, { status: 400 });
    }

    // RESTRICTED BETA GATE — before any database read, so a withheld
    // capability creates no intent to clean up and leaves no trace a later
    // step could act on.
    //
    // 403, not 400: the request is well formed and the caller is
    // authenticated — they are simply not permitted this capability. A 400
    // would invite them to "fix" the request and retry.
    //
    // Deliberately unwrapped: nothing catches between here and the handler's
    // outer catch, which maps BetaRestrictionError explicitly. A catch that
    // swallowed it would turn a refusal into an admission.
    assertCapabilityAllowed(type === 'add_money' ? 'funding' : 'cash_out');

    // Load user record — need country for provider routing and KYC status
    const userRows = await sql`
      SELECT kyc_status, country FROM users WHERE id = ${user.userId}
    `;
    if (!userRows[0] || userRows[0].kyc_status !== 'verified') {
      return NextResponse.json({ error: 'KYC verification required before transfers' }, { status: 403 });
    }

    const userCountry = userRows[0].country as string;
    const region = regionFromCountry(userCountry);

    // Find the user's primary encrypted bank account
    const bankRows = await sql`
      SELECT id FROM bank_accounts
      WHERE user_id = ${user.userId}
        AND is_token_encrypted = true
        AND is_active = true
      ORDER BY is_primary DESC
      LIMIT 1
    `;
    if (bankRows.length === 0) {
      return NextResponse.json({ error: 'No linked bank account found. Please link a bank account first.' }, { status: 403 });
    }
    const bankAccountId = bankRows[0].id as number;

    if (typeof amount !== 'string' && typeof amount !== 'number') {
      return NextResponse.json({ error: 'amount must be a decimal string or number' }, { status: 400 });
    }
    if (!isMoneyCurrency(currency)) {
      return NextResponse.json({ error: 'currency must be CAD or USD' }, { status: 400 });
    }
    // The browser supplies a string. Parse it once, at the public boundary,
    // into canonical cents. No JS float is admitted to provider or velocity
    // logic below.
    const amountMinor = parsePositiveMoney(amount, currency);

    // Advisory velocity preview, NOT an admission. Creating an intent is a
    // draft: it moves no balance, so it consumes no budget and holds no
    // claim. Its purpose is to refuse an obviously over-limit intent early
    // rather than at the step that moves money. Because it is only a preview,
    // the TOCTOU that admitVelocity() closes does not apply — nothing is
    // granted on the strength of this answer.
    //
    // Known gap, deliberately left open by this change: the transfer rail has
    // no admission anywhere. This route previously said velocity was
    // "recorded only at confirm step" and no confirm or execute route has
    // ever called a velocity write, so a transfer consumes no budget at all.
    // Sandbox confirm does move the platform balance. Closing that belongs
    // with the rail work, not with this fix; it is recorded in CLAUDE.md
    // under the open gaps rather than quietly papered over here.
    const velocityResult = await checkVelocityLimit(user.userId, amountMinor, currency);
    if (!velocityResult.allowed) {
      await auditLog(user.userId, 'transfer_intent_blocked', {
        type, amount: toDatabaseDecimal(amountMinor), currency, reason: velocityResult.reason,
      });
      return NextResponse.json({ error: velocityResult.reason || 'Transfer limit exceeded' }, { status: 429 });
    }

    // Resolve execution mode from env flags (live only when explicitly enabled).
    // The chosen provider persists this mode on the intent row, so the rest of
    // the lifecycle (review/confirm) stays consistent even if flags change.
    const mode = resolveExecutionMode(region);
    const provider = getTransferProvider(region, mode);
    const result = await provider.createIntent(
      user.userId, bankAccountId, type as 'add_money' | 'cash_out', amountMinor, currency,
    );

    return NextResponse.json({ success: true, ...result }, { status: 201 });
  } catch (err) {
    // Mapped BEFORE MoneyValidationError and before the generic 500, so a
    // withheld capability can never be reported as the caller's malformed
    // input or as a server fault. Both would be misleading: the request was
    // fine and nothing broke.
    if (err instanceof BetaRestrictionError) {
      return NextResponse.json(
        { error: err.message, code: 'BETA_RESTRICTED', capability: err.capability },
        { status: 403 },
      );
    }
    if (err instanceof MoneyValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('Transfer intent error:', err);
    return NextResponse.json({ error: 'Failed to create transfer intent' }, { status: 500 });
  }
}
