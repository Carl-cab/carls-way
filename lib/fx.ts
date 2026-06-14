import { getSql } from '@/lib/db';

const WISE_API_KEY = process.env.WISE_API_KEY || '';
const WISE_API_BASE = process.env.WISE_ENV === 'production'
  ? 'https://api.transferwise.com'
  : 'https://api.sandbox.transferwise.com';

// FX fee schedule (percentage)
const FX_FEES: Record<string, number> = {
  'USD_CAD': 0.005, // 0.5%
  'CAD_USD': 0.005, // 0.5%
};

// Cache TTL: 5 minutes
const RATE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface FxQuote {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  fee: number;
  feeAmount: number;
  receiverAmount: number;
  senderAmount: number;
  isCrossBorder: boolean;
  estimatedSettlement: Date;
  provider: string;
}

export async function getFxRate(fromCurrency: string, toCurrency: string): Promise<number> {
  if (fromCurrency === toCurrency) return 1.0;

  const sql = getSql();

  // Check DB cache first
  const cached = await sql`
    SELECT rate, fetched_at FROM fx_rates
    WHERE from_currency = ${fromCurrency} AND to_currency = ${toCurrency}
  `;

  if (cached.length > 0) {
    const fetchedAt = new Date(cached[0].fetched_at as string);
    const age = Date.now() - fetchedAt.getTime();
    if (age < RATE_CACHE_TTL_MS) {
      return parseFloat(cached[0].rate as string);
    }
  }

  // Fetch from Wise API
  let rate: number;
  let provider = 'wise';

  try {
    if (WISE_API_KEY) {
      const response = await fetch(
        `${WISE_API_BASE}/v1/rates?source=${fromCurrency}&target=${toCurrency}`,
        { headers: { Authorization: `Bearer ${WISE_API_KEY}` } }
      );
      if (response.ok) {
        const data = await response.json() as Array<{ rate: number }>;
        rate = data[0]?.rate;
      } else {
        throw new Error(`Wise API error: ${response.status}`);
      }
    } else {
      throw new Error('No Wise API key configured');
    }
  } catch (err) {
    console.warn('Wise API unavailable, using fallback rates:', err);
    // Fallback rates (updated periodically in production via cron)
    const fallbackRates: Record<string, number> = {
      'USD_CAD': 1.365,
      'CAD_USD': 0.7326,
    };
    rate = fallbackRates[`${fromCurrency}_${toCurrency}`] || 1.0;
    provider = 'fallback';
  }

  // Update cache
  await sql`
    INSERT INTO fx_rates (from_currency, to_currency, rate, provider, fetched_at)
    VALUES (${fromCurrency}, ${toCurrency}, ${rate}, ${provider}, NOW())
    ON CONFLICT (from_currency, to_currency)
    DO UPDATE SET rate = ${rate}, provider = ${provider}, fetched_at = NOW()
  `;

  return rate;
}

export async function buildFxQuote(
  senderAmount: number,
  fromCurrency: string,
  toCurrency: string
): Promise<FxQuote> {
  const isCrossBorder = fromCurrency !== toCurrency;
  const rate = await getFxRate(fromCurrency, toCurrency);
  const feePercent = FX_FEES[`${fromCurrency}_${toCurrency}`] || 0;
  const feeAmount = isCrossBorder ? parseFloat((senderAmount * feePercent).toFixed(2)) : 0;
  const receiverAmount = parseFloat(((senderAmount - feeAmount) * rate).toFixed(2));

  // Settlement time: domestic = instant, cross-border = 1-2 business days
  const estimatedSettlement = new Date();
  if (isCrossBorder) {
    estimatedSettlement.setDate(estimatedSettlement.getDate() + 2);
  }

  return {
    fromCurrency,
    toCurrency,
    rate,
    fee: feePercent,
    feeAmount,
    receiverAmount,
    senderAmount,
    isCrossBorder,
    estimatedSettlement,
    provider: 'wise',
  };
}
