import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { buildFxQuote } from '@/lib/fx';

export async function POST(req: NextRequest) {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { amount, fromCurrency, toCurrency } = await req.json();
    if (!amount || !fromCurrency || !toCurrency) {
      return NextResponse.json({ error: 'amount, fromCurrency, toCurrency required' }, { status: 400 });
    }

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    const quote = await buildFxQuote(numAmount, fromCurrency.toUpperCase(), toCurrency.toUpperCase());
    return NextResponse.json(quote);
  } catch (err) {
    console.error('FX quote error:', err);
    return NextResponse.json({ error: 'Failed to get FX quote' }, { status: 500 });
  }
}
