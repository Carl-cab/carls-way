/**
 * Every FX rate and quote has an audit trail. Accounting inputs are integer
 * cents and exact decimal strings; numbers below are asserted only at the UI
 * display boundary.
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
  it('audits a fresh fallback resolution loudly with the exact rate', async () => {
    const rate = await getFxRate('USD', 'CAD', { userId: USER_ID });

    expect(rate).toBe('1.365');
    expect(await auditActions()).toEqual(expect.arrayContaining(['fx_rate_resolved', 'fx_rate_fallback_used']));

    expect(await latestMetadata('fx_rate_resolved')).toMatchObject({
      from_currency: 'USD', to_currency: 'CAD', rate: '1.365', provider: 'fallback', source: 'live',
    });
    expect((await latestMetadata('fx_rate_fallback_used')).rate).toBe('1.365');
  });

  it('audits cache hits with their provenance', async () => {
    await getFxRate('USD', 'CAD', { userId: USER_ID });
    await sql`DELETE FROM audit_logs WHERE user_id = ${USER_ID}`;

    // NUMERIC(18,8) cache reads preserve its declared scale; both forms denote
    // the same exact decimal rate and neither crosses a JS floating boundary.
    expect(await getFxRate('USD', 'CAD', { userId: USER_ID })).toBe('1.36500000');
    expect(await latestMetadata('fx_rate_resolved')).toMatchObject({ source: 'cache', provider: 'fallback' });
    expect(await auditActions()).toContain('fx_rate_fallback_used');
  });

  it('audits same-currency identity rates without a fallback warning', async () => {
    expect(await getFxRate('CAD', 'CAD', { userId: USER_ID })).toBe('1.00000000');
    expect(await auditActions()).toContain('fx_rate_resolved');
    expect(await auditActions()).not.toContain('fx_rate_fallback_used');
    expect(await latestMetadata('fx_rate_resolved')).toMatchObject({ rate: '1.00000000', provider: 'identity' });
  });
});

describe('buildFxQuote audit trail', () => {
  it('records exact quote economics with no major-unit conversion in the input path', async () => {
    const quote = await buildFxQuote(10_000, 'USD', 'CAD', { userId: USER_ID });

    expect(quote.provider).toBe('fallback');
    expect(quote.rateDecimal).toBe('1.365');
    expect(quote.senderMinorUnits).toBe(10_000);
    expect(quote.feeMinorUnits).toBe(50);
    expect(quote.receiverMinorUnits).toBe(13_582);
    expect(quote.feeAmount).toBe(0.5);
    expect(quote.receiverAmount).toBe(135.82);

    expect(await auditActions()).toContain('fx_quote_issued');
    expect(await latestMetadata('fx_quote_issued')).toMatchObject({
      from_currency: 'USD',
      to_currency: 'CAD',
      sender_amount: '100.00',
      rate: '1.365',
      fee_percent: 0.005,
      fee_amount: '0.50',
      receiver_amount: '135.82',
      provider: 'fallback',
      is_cross_border: true,
    });
  });
});
