import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getSql, initializeSchema } from '@/lib/db';
import { createSplit, paySplitPortion } from '@/lib/splits';
import { createLedgerPair } from '@/lib/ledger';

/**
 * The ledger must record every movement of money, and must not record one that
 * did not happen.
 *
 * Both halves matter, and both used to fail in different directions: splits
 * moved money and wrote nothing, while the peer-to-peer path wrote its entries
 * on a separate connection inside a try/catch that logged and continued — so a
 * ledger failure left balances changed with no record, and nothing surfaced.
 *
 * These run against real PostgreSQL. A mocked driver cannot show whether two
 * writes share a transaction, which is the entire question here.
 */

const sql = getSql();

let payer: number;
let creator: number;

async function makeUser(balanceCad: number): Promise<number> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country, balance_cad, balance_usd)
    VALUES ('Ledger Probe', ${'ledg_' + suffix}, ${'ledg_' + suffix + '@example.com'},
            'x', 'CA', ${balanceCad}, 0)
    RETURNING id
  `;
  return rows[0].id;
}

async function walletOf(userId: number): Promise<number> {
  const rows = await sql<{ balance_cad: number }[]>`
    SELECT balance_cad FROM users WHERE id = ${userId}
  `;
  return rows[0].balance_cad;
}

/** Net ledger movement for a user: credits minus debits. */
async function ledgerNet(userId: number): Promise<number> {
  const rows = await sql<{ net: number }[]>`
    SELECT COALESCE(SUM(credit) - SUM(debit), 0)::numeric AS net
    FROM ledger_entries WHERE user_id = ${userId} AND currency = 'CAD'
  `;
  return Number(rows[0].net);
}

async function ledgerRowsFor(transactionId: number) {
  return sql<{ user_id: number; debit: number; credit: number; entry_type: string }[]>`
    SELECT user_id, debit, credit, entry_type FROM ledger_entries
    WHERE transaction_id = ${transactionId} ORDER BY debit DESC
  `;
}

beforeAll(async () => {
  await initializeSchema();
});

beforeEach(async () => {
  payer = await makeUser(500);
  creator = await makeUser(0);
});

afterAll(async () => {
  await sql`DELETE FROM ledger_entries WHERE user_id IN
            (SELECT id FROM users WHERE username LIKE 'ledg_%')`;
  await sql`DELETE FROM split_participants WHERE user_id IN
            (SELECT id FROM users WHERE username LIKE 'ledg_%')`;
  await sql`DELETE FROM transactions WHERE sender_id IN
            (SELECT id FROM users WHERE username LIKE 'ledg_%')`;
  await sql`DELETE FROM splits WHERE creator_id IN
            (SELECT id FROM users WHERE username LIKE 'ledg_%')`;
  await sql`DELETE FROM users WHERE username LIKE 'ledg_%'`;
});

describe('split payments write to the ledger', () => {
  it('records a balanced debit and credit for a paid portion', async () => {
    const { split } = await createSplit(creator, 40, 'CAD', 'Dinner', [
      { userId: payer, amountOwed: 40 },
    ]);
    const result = await paySplitPortion(split.id, payer);

    const entries = await ledgerRowsFor(result.transactionId);
    // Before this change there were zero entries, despite the docstring.
    expect(entries).toHaveLength(2);

    const [debit, credit] = entries;
    expect(debit.user_id).toBe(payer);
    expect(Number(debit.debit)).toBe(40);
    expect(Number(debit.credit)).toBe(0);

    expect(credit.user_id).toBe(creator);
    expect(Number(credit.credit)).toBe(40);
    expect(Number(credit.debit)).toBe(0);
  });

  it('keeps the ledger in step with the wallets it describes', async () => {
    const { split } = await createSplit(creator, 25, 'CAD', 'Taxi', [
      { userId: payer, amountOwed: 25 },
    ]);
    await paySplitPortion(split.id, payer);

    expect(await walletOf(payer)).toBe(475);
    expect(await walletOf(creator)).toBe(25);

    // The ledger's net movement must equal the wallet's actual movement.
    expect(await ledgerNet(payer)).toBe(-25);
    expect(await ledgerNet(creator)).toBe(25);
  });

  it('conserves money across the ledger for a multi-party split', async () => {
    const second = await makeUser(500);
    const { split } = await createSplit(creator, 30, 'CAD', 'Groceries', [
      { userId: payer, amountOwed: 10 },
      { userId: second, amountOwed: 20 },
    ]);

    await paySplitPortion(split.id, payer);
    await paySplitPortion(split.id, second);

    const net = (await ledgerNet(payer)) + (await ledgerNet(second)) + (await ledgerNet(creator));
    expect(net).toBe(0); // double entry: nothing created, nothing destroyed

    expect(await ledgerNet(creator)).toBe(30);
    expect(await walletOf(creator)).toBe(30);
  });

  it('writes nothing to the ledger when the payment is refused', async () => {
    const broke = await makeUser(5);
    const { split } = await createSplit(creator, 100, 'CAD', 'Concert', [
      { userId: broke, amountOwed: 100 },
    ]);

    await expect(paySplitPortion(split.id, broke)).rejects.toThrow();

    expect(await walletOf(broke)).toBe(5);
    expect(await ledgerNet(broke)).toBe(0);
    expect(await ledgerNet(creator)).toBe(0);
  });

  it('records one pair only, even when the portion is paid twice', async () => {
    const { split } = await createSplit(creator, 15, 'CAD', 'Coffee', [
      { userId: payer, amountOwed: 15 },
    ]);
    await paySplitPortion(split.id, payer);
    await expect(paySplitPortion(split.id, payer)).rejects.toThrow();

    expect(await ledgerNet(payer)).toBe(-15);
    expect(await walletOf(payer)).toBe(485);
  });
});

describe('ledger writes share the caller transaction', () => {
  it('rolls the money back when the ledger write fails', async () => {
    const before = await walletOf(payer);

    // A ledger failure inside the transaction must take the balance change with
    // it. Previously the write lived outside, in a catch that logged and
    // continued, so the debit below would have survived on its own.
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE users SET balance_cad = balance_cad - 50 WHERE id = ${payer}`;
        await createLedgerPair(payer, creator, 'CAD', 50, 999999999, {
          executor: tx, // transaction_id does not exist -> FK violation
        });
      }),
    ).rejects.toThrow();

    expect(await walletOf(payer)).toBe(before);
    expect(await ledgerNet(payer)).toBe(0);
  });

  it('commits ledger and balance together or not at all', async () => {
    const txRows = await sql<{ id: number }[]>`
      INSERT INTO transactions (sender_id, receiver_id, amount, currency, type, status)
      VALUES (${payer}, ${creator}, 60, 'CAD', 'payment', 'completed') RETURNING id
    `;

    await sql.begin(async (tx) => {
      await tx`UPDATE users SET balance_cad = balance_cad - 60 WHERE id = ${payer}`;
      await tx`UPDATE users SET balance_cad = balance_cad + 60 WHERE id = ${creator}`;
      await createLedgerPair(payer, creator, 'CAD', 60, txRows[0].id, { executor: tx });
    });

    expect(await walletOf(payer)).toBe(440);
    expect(await ledgerNet(payer)).toBe(-60);
    expect(await ledgerNet(creator)).toBe(60);
  });

  it('still works on the pool when no transaction is supplied', async () => {
    const txRows = await sql<{ id: number }[]>`
      INSERT INTO transactions (sender_id, receiver_id, amount, currency, type, status)
      VALUES (${payer}, ${creator}, 5, 'CAD', 'payment', 'completed') RETURNING id
    `;
    const pair = await createLedgerPair(payer, creator, 'CAD', 5, txRows[0].id);
    expect(pair.debitEntryId).toBeGreaterThan(0);
    expect(pair.creditEntryId).toBeGreaterThan(0);
  });
});

describe('peer-to-peer ledger failures are not swallowed', () => {
  it('no longer carries a catch that logs and continues', async () => {
    const source = await (await import('node:fs/promises')).readFile(
      'app/api/transactions/route.ts',
      'utf8',
    );

    expect(source).not.toContain('non-blocking');
    expect(source).not.toMatch(/catch \(ledgerErr\)/);
    // And the writes must be handed the transaction, not left on the pool.
    expect(source).toContain('executor: tx');
  });

  it('keeps splits writing their pair on the payment transaction', async () => {
    const source = await (await import('node:fs/promises')).readFile('lib/splits.ts', 'utf8');
    expect(source).toContain('createLedgerPair');
    expect(source).toContain('executor: tx');
  });
});
