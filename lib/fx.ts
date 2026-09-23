import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';

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

export interface FxRateOptions {
  /**
   * Owner of the audit trail entry. Pass the acting user's id from request
   * handlers; omit (or null) for system-initiated resolutions.
   */
  userId?: number | null;
}

type FxRateSource = 'cache' | 'live';

interface ResolvedFxRate {
  rate: number;
  /** 'wise' when the live API answered, 'fallback' when the hardcoded table did, 'identity' for same-currency. */
  provider: string;
  source: FxRateSource;
}

/**
 * Resolve an FX rate and write the audit trail for the resolution.
 *
 * C1.2: every rate that can end up inside a quote — cached, freshly fetched,
 * or hardcoded fallback — is recorded in audit_logs with its provider and
 * provenance. The fallback path gets its own loud event because applying a
 * hardcoded rate to real money is the highest-risk outcome here; without the
 * audit row it would be invisible.
 *
 * Audit writes are non-blocking (auditLog swallows its own errors), so a
 * failing audit trail can never break quoting.
 */
async function resolveFxRate(
  fromCurrency: string,
  toCurrency: string,
  opts?: FxRateOptions,
): Promise<ResolvedFxRate> {
  const userId = opts?.userId ?? null;

  if (fromCurrency === toCurrency) {
    const resolved: ResolvedFxRate = { rate: 1.0, provider: 'identity', source: 'live' };
    await auditLog(userId, 'fx_rate_resolved', {
      from_currency: fromCurrency,
      to_currency: toCurrency,
      rate: resolved.rate,
      provider: resolved.provider,
      source: resolved.source,
    });
    return resolved;
  }

  const sql = getSql();

  // Check DB cache first
  const cached = await sql`
    SELECT rate, provider, fetched_at FROM fx_rates
    WHERE from_currency = ${fromCurrency} AND to_currency = ${toCurrency}
  `;

  if (cached.length > 0) {
    const fetchedAt = new Date(cached[0].fetched_at as string);
    const age = Date.now() - fetchedAt.getTime();
    if (age < RATE_CACHE_TTL_MS) {
      const resolved: ResolvedFxRate = {
        rate: parseFloat(cached[0].rate as string),
        provider: (cached[0].provider as string) || 'wise',
        source: 'cache',
      };
      await auditLog(userId, 'fx_rate_resolved', {
        from_currency: fromCurrency,
        to_currency: toCurrency,
        rate: resolved.rate,
        provider: resolved.provider,
        source: resolved.source,
        cache_age_ms: age,
      });
      if (resolved.provider === 'fallback') {
        await auditLog(userId, 'fx_rate_fallback_used', {
          from_currency: fromCurrency,
          to_currency: toCurrency,
          rate: resolved.rate,
          source: resolved.source,
          note: 'Served rate originated from the hardcoded fallback table',
        });
      }
      return resolved;
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

  await auditLog(userId, 'fx_rate_resolved', {
    from_currency: fromCurrency,
    to_currency: toCurrency,
    rate,
    provider,
    source: 'live' as FxRateSource,
  });
  if (provider === 'fallback') {
    await auditLog(userId, 'fx_rate_fallback_used', {
      from_currency: fromCurrency,
      to_currency: toCurrency,
      rate,
      source: 'live',
      note: 'Wise unavailable; hardcoded fallback rate applied to a live quote',
    });
  }

  return { rate, provider, source: 'live' };
}

export async function getFxRate(
  fromCurrency: string,
  toCurrency: string,
  opts?: FxRateOptions,
): Promise<number> {
  return (await resolveFxRate(fromCurrency, toCurrency, opts)).rate;
}

export async function buildFxQuote(
  senderAmount: number,
  fromCurrency: string,
  toCurrency: string,
  opts?: FxRateOptions,
): Promise<FxQuote> {
  const userId = opts?.userId ?? null;
  const isCrossBorder = fromCurrency !== toCurrency;
  const { rate, provider } = await resolveFxRate(fromCurrency, toCurrency, opts);
  const feePercent = FX_FEES[`${fromCurrency}_${toCurrency}`] || 0;
  const feeAmount = isCrossBorder ? parseFloat((senderAmount * feePercent).toFixed(2)) : 0;
  const receiverAmount = parseFloat(((senderAmount - feeAmount) * rate).toFixed(2));

  // Settlement time: instant for all transfers
  const estimatedSettlement = new Date();

  const quote: FxQuote = {
    fromCurrency,
    toCurrency,
    rate,
    fee: feePercent,
    feeAmount,
    receiverAmount,
    senderAmount,
    isCrossBorder,
    estimatedSettlement,
    provider,
  };

  // C1.2: record the exact economics the user was shown, so any later dispute
  // about "what rate did I get" has a durable answer.
  await auditLog(userId, 'fx_quote_issued', {
    from_currency: fromCurrency,
    to_currency: toCurrency,
    sender_amount: senderAmount,
    rate,
    fee_percent: feePercent,
    fee_amount: feeAmount,
    receiver_amount: receiverAmount,
    provider,
    is_cross_border: isCrossBorder,
  });

  return quote;
}
