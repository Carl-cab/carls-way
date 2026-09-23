/**
 * C1.2: FX-rate audit logging.
 *
 * Every rate that can end up inside a quote must leave an audit trail with
 * its provider and provenance — especially the hardcoded fallback path,
 * which applies an invented rate to real money.
 *
 * Runs against real PostgreSQL. Assumes no WISE_API_KEY is configured, so
 * the live-fetch path deterministically falls back (the same condition as
 * every test/CI environment).
 */
import { getFxRate, buildFxQuote } from '../fx';
import { getSql, initializeSchema } from '../db';

const USER_ID = 9401;
const sql = getSql();

async function auditActions(): Promise<string[]> {
  const rows = await sql`
    SELECT action FROM audit_logs WHERE user_id = ${USER_ID} ORDER BY id
  `;
  return rows.map((r) => r.action as string);
}

async function latestMetadata(action: string): Promise<Record<string, unknown>> {
  const rows = await sql`
    SELECT metadata FROM audit_logs
    WHERE user_id = ${USER_ID} AND action = ${action}
    ORDER BY id DESC LIMIT 1
  `;
  const raw = rows[0].metadata as string | Record<string, unknown>;
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
}

beforeAll(async () => {
  await initializeSchema();
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
    VALUES (${USER_ID}, 'FX Audit Tester', 'fx_audit_tester', 'fxaudit@example.test', 'x', 'CA', 'verified')
    ON CONFLICT (id) DO UPDATE SET kyc_status = 'verified'
  `;
});

beforeEach(async () => {
  await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fx_rates WHERE from_currency = 'USD' AND to_currency = 'CAD'`;
});

afterAll(async () => {
  await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;
  await sql`DELETE FROM fx_rates WHERE from_currency = 'USD' AND to_currency = 'CAD'`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
});

describe('getFxRate audit trail', () => {
  it('audits a fresh fallback resolution loudly', async () => {
    const rate = await getFxRate('USD', 'CAD', { userId: USER_ID });

    // No Wise key in test env: deterministic fallback.
    expect(rate).toBe(1.365);

    const actions = await auditActions();
    expect(actions).toContain('fx_rate_resolved');
    expect(actions).toContain('fx_rate_fallback_used');

    const resolved = await latestMetadata('fx_rate_resolved');
    expect(resolved).toMatchObject({
      from_currency: 'USD',
      to_currency: 'CAD',
      rate: 1.365,
      provider: 'fallback',
      source: 'live',
    });

    const fallback = await latestMetadata('fx_rate_fallback_used');
    expect(fallback.rate).toBe(1.365);
    expect(typeof fallback.note).toBe('string');
  });

  it('audits cache hits with their provenance', async () => {
    await getFxRate('USD', 'CAD', { userId: USER_ID });
    await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;

    const rate = await getFxRate('USD', 'CAD', { userId: USER_ID });
    expect(rate).toBe(1.365);

    const resolved = await latestMetadata('fx_rate_resolved');
    expect(resolved).toMatchObject({ source: 'cache', provider: 'fallback' });
    // A cached fallback rate is still a fallback rate: it stays loud.
    expect(await auditActions()).toContain('fx_rate_fallback_used');
  });

  it('audits same-currency identity rates without a fallback warning', async () => {
    const rate = await getFxRate('CAD', 'CAD', { userId: USER_ID });
    expect(rate).toBe(1.0);

    const actions = await auditActions();
    expect(actions).toContain('fx_rate_resolved');
    expect(actions).not.toContain('fx_rate_fallback_used');

    const resolved = await latestMetadata('fx_rate_resolved');
    expect(resolved).toMatchObject({ rate: 1.0, provider: 'identity' });
  });
});

describe('buildFxQuote audit trail', () => {
  it('records the exact quote economics and the true rate provider', async () => {
    const quote = await buildFxQuote(100, 'USD', 'CAD', { userId: USER_ID });

    // The quote must not claim 'wise' when the rate came from the fallback table.
    expect(quote.provider).toBe('fallback');
    expect(quote.rate).toBe(1.365);
    expect(quote.feeAmount).toBe(0.5);
    expect(quote.receiverAmount).toBe(135.82);

    const actions = await auditActions();
    expect(actions).toContain('fx_quote_issued');

    const issued = await latestMetadata('fx_quote_issued');
    expect(issued).toMatchObject({
      from_currency: 'USD',
      to_currency: 'CAD',
      sender_amount: 100,
      rate: 1.365,
      fee_percent: 0.005,
      fee_amount: 0.5,
      receiver_amount: 135.82,
      provider: 'fallback',
      is_cross_border: true,
    });
  });
});
