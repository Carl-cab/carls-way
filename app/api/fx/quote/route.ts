import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { buildFxQuote } from '@/lib/fx';
import { MoneyValidationError, isMoneyCurrency, parsePositiveMoney } from '@/lib/money';

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
    const cents = parsePositiveMoney(amount, source);
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
