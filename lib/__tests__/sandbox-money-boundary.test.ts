import { getSql, initializeSchema } from '../db';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  return { ...actual, auditLog: async () => {} };
});

const { SandboxUSProvider } = await import('../providers/SandboxUSProvider');
const { SandboxCAProvider } = await import('../providers/SandboxCAProvider');
const { SandboxUSProvider: LegacyUSProvider } = await import('../transfers/sandbox-us');
const { SandboxCAProvider: LegacyCAProvider } = await import('../transfers/sandbox-ca');
const sql = getSql();
const fixtures = [
  { userId: 9501, currency: 'USD', country: 'US', provider: new SandboxUSProvider(), legacy: new LegacyUSProvider() },
  { userId: 9502, currency: 'CAD', country: 'CA', provider: new SandboxCAProvider(), legacy: new LegacyCAProvider() },
] as const;

beforeAll(async () => {
  await initializeSchema();
  for (const { userId, currency, country } of fixtures) {
    await sql`
      INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
      VALUES (${userId}, 'Sandbox Boundary', ${`boundary_${userId}`}, ${`boundary_${userId}@example.test`},
              'x', ${country}, 'verified')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO bank_accounts (id, user_id, institution_name, account_name, account_mask,
                                 currency, country, is_token_encrypted, is_verified)
      VALUES (${userId}, ${userId}, 'Sandbox Test Bank', 'Checking', '0001',
              ${currency}, ${country}, true, true)
      ON CONFLICT (id) DO NOTHING
    `;
  }
});

beforeEach(async () => {
  for (const { userId } of fixtures) {
    await sql`DELETE FROM ledger_entries WHERE user_id = ${userId}`;
    await sql`DELETE FROM transfer_intents WHERE user_id = ${userId}`;
    await sql`UPDATE users SET balance_usd = '0.00', balance_cad = '0.00' WHERE id = ${userId}`;
  }
});

afterAll(async () => {
  for (const { userId } of fixtures) {
    await sql`DELETE FROM ledger_entries WHERE user_id = ${userId}`;
    await sql`DELETE FROM transfer_intents WHERE user_id = ${userId}`;
    await sql`DELETE FROM bank_accounts WHERE id = ${userId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
  }
});

for (const { userId, currency, provider, legacy } of fixtures) {
  describe(`${currency} sandbox money boundary`, () => {
    it('persists one cent and $100.10 exactly, settles credits/debits without fractional ledger values', async () => {
      for (const [minor, decimal, expectedBalance] of [[1, '0.01', 0.01], [10010, '100.10', 100.11]] as const) {
        const created = await provider.createIntent(userId, userId, 'add_money', minor, currency);
        const stored = await sql`SELECT amount::text AS amount FROM transfer_intents WHERE id = ${created.intent_id}`;
        expect(stored[0].amount).toBe(decimal);
        const review = await provider.reviewTransfer(created.intent_id, userId);
        expect(review.review.consent_language).toContain(`${currency} ${decimal}`);
        expect(review.review.amount).toBe(minor / 100); // Public display only.
        const result = await provider.confirmTransfer(created.intent_id, userId);
        expect(result.status).toBe('settled');
        expect(result.new_balance).toBe(expectedBalance);
        const ledger = await sql`
          SELECT debit::text AS debit, credit::text AS credit, description
          FROM ledger_entries WHERE transfer_intent_id = ${created.intent_id}
        `;
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ debit: '0.00', credit: decimal });
        expect(ledger[0].description).toContain(decimal);
      }

      for (const [minor, decimal, expectedBalance] of [[1, '0.01', 100.1], [10010, '100.10', 0]] as const) {
        const created = await provider.createIntent(userId, userId, 'cash_out', minor, currency);
        const result = await provider.confirmTransfer(created.intent_id, userId);
        expect(result.new_balance).toBe(expectedBalance);
        const ledger = await sql`
          SELECT debit::text AS debit, credit::text AS credit
          FROM ledger_entries WHERE transfer_intent_id = ${created.intent_id}
        `;
        expect(ledger[0]).toMatchObject({ debit: decimal, credit: '0.00' });
      }
      const balances = await sql`
        SELECT balance_usd::text AS usd, balance_cad::text AS cad FROM users WHERE id = ${userId}
      `;
      expect(balances[0][currency === 'USD' ? 'usd' : 'cad']).toBe('0.00');
      expect(balances[0][currency === 'USD' ? 'cad' : 'usd']).toBe('0.00');
    });

    it('rejects invalid minor units, currency and overdraw before moving any balance', async () => {
      for (const impl of [provider, legacy]) {
        await expect(impl.createIntent(userId, userId, 'add_money', 0, currency)).rejects.toThrow();
        await expect(impl.createIntent(userId, userId, 'add_money', 1.5, currency)).rejects.toThrow();
        await expect(impl.createIntent(userId, userId, 'add_money', 1, currency === 'USD' ? 'CAD' : 'USD')).rejects.toThrow();
      }
      const created = await provider.createIntent(userId, userId, 'cash_out', 1, currency);
      await expect(provider.confirmTransfer(created.intent_id, userId)).rejects.toThrow('INSUFFICIENT_BALANCE');
      const balances = await sql`
        SELECT balance_usd::text AS usd, balance_cad::text AS cad FROM users WHERE id = ${userId}
      `;
      expect(balances[0].usd).toBe('0.00');
      expect(balances[0].cad).toBe('0.00');
    });

    it('keeps the legacy sandbox adapter at the same exact-money boundary without settling', async () => {
      const created = await legacy.createIntent(userId, userId, 'add_money', 10010, currency);
      const review = await legacy.reviewTransfer(created.intent_id, userId);
      expect(review.review.amount).toBe(100.1);
      expect(review.review.consent_language).toContain(`${currency} 100.10`);
      const stored = await sql`SELECT amount::text AS amount FROM transfer_intents WHERE id = ${created.intent_id}`;
      expect(stored[0].amount).toBe('100.10');
      expect((await legacy.confirmTransfer(created.intent_id, userId)).status).toBe('ready');
      const ledger = await sql`SELECT id FROM ledger_entries WHERE transfer_intent_id = ${created.intent_id}`;
      expect(ledger).toHaveLength(0);
    });
  });
}
