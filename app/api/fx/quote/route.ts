import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { buildFxQuote } from '@/lib/fx';
import { MoneyValidationError, isMoneyCurrency, parsePositiveMoney } from '@/lib/money';
import { isCapabilityRestricted, restrictionMessage } from '@/lib/beta-restrictions';

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { amount, fromCurrency, toCurrency } = await req.json();
    if (!amount || !fromCurrency || !toCurrency) {
      return NextResponse.json({ error: 'amount, fromCurrency, toCurrency required' }, { status: 400 });
    }

    const source = String(fromCurrency).toUpperCase();
    const target = String(toCurrency).toUpperCase();
    if (!isMoneyCurrency(source) || !isMoneyCurrency(target)) {
      return NextResponse.json({ error: 'Currency must be CAD or USD' }, { status: 400 });
    }
    // ALL INPUT VALIDATION RUNS FIRST, including the amount. parsePositiveMoney
    // contacts nobody, so there is no containment reason to gate ahead of it,
    // and running it first is what keeps the refusal from doubling as an input
    // validator: a malformed amount on a cross-currency request answers 400,
    // not 403. An earlier revision put the gate above this line, so
    // {"amount":"abc","fromCurrency":"CAD","toCurrency":"USD"} reported a beta
    // restriction for what is simply a bad request -- telling the caller to
    // wait for the beta to end instead of to fix the call.
    const cents = parsePositiveMoney(amount, source);

    // Containment gate, BEFORE buildFxQuote(), which is what calls Wise.
    // Scoped to the CROSS-CURRENCY case on purpose: a same-currency quote
    // short-circuits to the identity rate inside buildFxQuote() and contacts
    // no external provider, so refusing it would withhold something that is
    // neither external nor cross-currency.
    if (source !== target && isCapabilityRestricted('external_fx')) {
      return NextResponse.json(
        {
          error: restrictionMessage('external_fx'),
          code: 'BETA_RESTRICTED',
          capability: 'external_fx',
        },
        { status: 403 },
      );
    }

    const quote = await buildFxQuote(cents, source, target, { userId: user.userId });
    // Keep canonical cents and exact rate strings internal. The existing client
    // contract receives display-only values and cannot feed them back into the
    // settlement path.
    return NextResponse.json({
      fromCurrency: quote.fromCurrency,
      toCurrency: quote.toCurrency,
      rate: quote.rate,
      fee: quote.fee,
      feeAmount: quote.feeAmount,
      receiverAmount: quote.receiverAmount,
      senderAmount: quote.senderAmount,
      isCrossBorder: quote.isCrossBorder,
      estimatedSettlement: quote.estimatedSettlement,
      provider: quote.provider,
    });
  } catch (err) {
    if (err instanceof MoneyValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    console.error('FX quote error:', err);
    return NextResponse.json({ error: 'Failed to get FX quote' }, { status: 500 });
  }
}
