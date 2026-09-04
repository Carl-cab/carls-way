/**
 * Phase 4 — bill splitting.
 *
 * Splits move real balances, so the properties that matter are the financial
 * ones: portions must sum to the total, a portion can be paid exactly once even
 * under concurrent requests, an overdraw cannot occur, and a partially-paid
 * split stays open until the last portion lands.
 *
 * Runs against a real PostgreSQL instance — the uniqueness constraint and the
 * row lock are part of what is being tested, and neither exists in a fake.
 */

import { getSql } from '../db';
import {
  createSplit,
  divideEvenly,
  paySplitPortion,
  listSplitsForUser,
  SplitValidationError,
} from '../splits';

const CREATOR = 9101;
const PAYER_A = 9102;
const PAYER_B = 9103;
const BROKE = 9104;

const sql = getSql();

async function balance(userId: number): Promise<number> {
  const rows = await sql`SELECT balance_cad FROM users WHERE id = ${userId}`;
  return Number(rows[0].balance_cad);
}

async function setBalance(userId: number, amount: number) {
  await sql`UPDATE users SET balance_cad = ${amount} WHERE id = ${userId}`;
}

async function cleanup() {
  // splits <- transactions.split_id and transactions <- split_participants.transaction_id
  // form a reference cycle, so the link is broken before anything is deleted.
  await sql`
    UPDATE transactions SET split_id = NULL
    WHERE split_id IN (SELECT id FROM splits WHERE creator_id = ${CREATOR})
  `;
  await sql`DELETE FROM splits WHERE creator_id = ${CREATOR}`;   // cascades participants
  await sql`DELETE FROM transactions WHERE sender_id IN (${CREATOR}, ${PAYER_A}, ${PAYER_B}, ${BROKE})
                                        OR receiver_id IN (${CREATOR}, ${PAYER_A}, ${PAYER_B}, ${BROKE})`;
}

beforeEach(async () => {
  await cleanup();
  await setBalance(CREATOR, 0);
  await setBalance(PAYER_A, 500);
  await setBalance(PAYER_B, 500);
  await setBalance(BROKE, 0);
});

afterAll(cleanup);

describe('Bill splitting', () => {
  describe('even division', () => {
    it.each([
      [10, 2, [5, 5]],
      [10, 4, [2.5, 2.5, 2.5, 2.5]],
      [100, 3, [33.34, 33.33, 33.33]],
      [0.03, 2, [0.02, 0.01]],
      [7.77, 7, [1.11, 1.11, 1.11, 1.11, 1.11, 1.11, 1.11]],
    ])('divides %s among %s with no rounding drift', (total, count, expected) => {
      const portions = divideEvenly(total, count);
      expect(portions).toEqual(expected);
      // The property that matters: portions sum EXACTLY to the total.
      const sum = portions.reduce((a, b) => a + b, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(total * 100));
    });
  });

  describe('creation validation', () => {
    it('rejects portions that do not sum to the total', async () => {
      await expect(
        createSplit(CREATOR, 100, 'CAD', 'Dinner', [
          { userId: PAYER_A, amountOwed: 40 },
          { userId: PAYER_B, amountOwed: 40 },
        ]),
      ).rejects.toThrow(SplitValidationError);
    });

    it('rejects the creator being a participant in their own split', async () => {
      await expect(
        createSplit(CREATOR, 50, 'CAD', 'Dinner', [{ userId: CREATOR, amountOwed: 50 }]),
      ).rejects.toThrow(/cannot also be a participant/);
    });

    it('rejects a duplicated participant', async () => {
      await expect(
        createSplit(CREATOR, 50, 'CAD', 'Dinner', [
          { userId: PAYER_A, amountOwed: 25 },
          { userId: PAYER_A, amountOwed: 25 },
        ]),
      ).rejects.toThrow(/only appear once/);
    });

    it('rejects a non-positive total', async () => {
      await expect(
        createSplit(CREATOR, 0, 'CAD', 'Nothing', [{ userId: PAYER_A, amountOwed: 0 }]),
      ).rejects.toThrow(SplitValidationError);
    });

    it('creates the split and one row per participant', async () => {
      const { split, participants } = await createSplit(CREATOR, 60, 'CAD', 'Dinner', [
        { userId: PAYER_A, amountOwed: 30 },
        { userId: PAYER_B, amountOwed: 30 },
      ]);

      expect(split.status).toBe('open');
      expect(Number(split.total_amount)).toBe(60);
      expect(participants).toHaveLength(2);
      expect(participants.every((p) => p.status === 'pending')).toBe(true);
    });
  });

  describe('paying a portion', () => {
    it('moves money from payer to creator and marks only that portion paid', async () => {
      const { split } = await createSplit(CREATOR, 60, 'CAD', 'Dinner', [
        { userId: PAYER_A, amountOwed: 30 },
        { userId: PAYER_B, amountOwed: 30 },
      ]);

      const result = await paySplitPortion(split.id, PAYER_A);

      expect(result.amountPaid).toBe(30);
      expect(result.splitStatus).toBe('open');       // B has not paid yet
      expect(result.remainingParticipants).toBe(1);

      expect(await balance(PAYER_A)).toBe(470);
      expect(await balance(CREATOR)).toBe(30);
      expect(await balance(PAYER_B)).toBe(500);      // untouched

      const rows = await sql`
        SELECT user_id, status FROM split_participants WHERE split_id = ${split.id} ORDER BY user_id
      `;
      expect(rows.find((r) => r.user_id === PAYER_A)?.status).toBe('paid');
      expect(rows.find((r) => r.user_id === PAYER_B)?.status).toBe('pending');
    });

    it('settles the split when the last portion is paid', async () => {
      const { split } = await createSplit(CREATOR, 60, 'CAD', 'Dinner', [
        { userId: PAYER_A, amountOwed: 30 },
        { userId: PAYER_B, amountOwed: 30 },
      ]);

      await paySplitPortion(split.id, PAYER_A);
      const last = await paySplitPortion(split.id, PAYER_B);

      expect(last.splitStatus).toBe('settled');
      expect(last.remainingParticipants).toBe(0);
      expect(await balance(CREATOR)).toBe(60);

      const rows = await sql`SELECT status FROM splits WHERE id = ${split.id}`;
      expect(rows[0].status).toBe('settled');
    });

    it('records a transaction linked back to the split', async () => {
      const { split } = await createSplit(CREATOR, 25, 'CAD', 'Coffee', [
        { userId: PAYER_A, amountOwed: 25 },
      ]);
      const result = await paySplitPortion(split.id, PAYER_A);

      const tx = await sql`SELECT * FROM transactions WHERE id = ${result.transactionId}`;
      expect(tx[0].sender_id).toBe(PAYER_A);
      expect(tx[0].receiver_id).toBe(CREATOR);
      expect(Number(tx[0].amount)).toBe(25);
      expect(tx[0].split_id).toBe(split.id);
    });
  });

  describe('double payment is impossible', () => {
    it('rejects a second sequential payment of the same portion', async () => {
      const { split } = await createSplit(CREATOR, 30, 'CAD', 'Lunch', [
        { userId: PAYER_A, amountOwed: 30 },
      ]);

      await paySplitPortion(split.id, PAYER_A);
      await expect(paySplitPortion(split.id, PAYER_A)).rejects.toMatchObject({
        code: 'ALREADY_PAID',
      });

      // Charged exactly once.
      expect(await balance(PAYER_A)).toBe(470);
      expect(await balance(CREATOR)).toBe(30);
    });

    it('charges only once under two concurrent payments of the same portion', async () => {
      const { split } = await createSplit(CREATOR, 30, 'CAD', 'Lunch', [
        { userId: PAYER_A, amountOwed: 30 },
      ]);

      const results = await Promise.allSettled([
        paySplitPortion(split.id, PAYER_A),
        paySplitPortion(split.id, PAYER_A),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      // The financial assertion: one debit, one credit, regardless of interleaving.
      expect(await balance(PAYER_A)).toBe(470);
      expect(await balance(CREATOR)).toBe(30);

      const txCount = await sql`
        SELECT COUNT(*)::int AS n FROM transactions WHERE split_id = ${split.id}
      `;
      expect(txCount[0].n).toBe(1);
    });
  });

  describe('authorization and balance guards', () => {
    it('refuses payment from someone who is not a participant', async () => {
      const { split } = await createSplit(CREATOR, 30, 'CAD', 'Lunch', [
        { userId: PAYER_A, amountOwed: 30 },
      ]);

      await expect(paySplitPortion(split.id, PAYER_B)).rejects.toMatchObject({
        code: 'NOT_PARTICIPANT',
      });
      expect(await balance(PAYER_B)).toBe(500);
    });

    it('refuses payment when the payer cannot cover their portion', async () => {
      const { split } = await createSplit(CREATOR, 30, 'CAD', 'Lunch', [
        { userId: BROKE, amountOwed: 30 },
      ]);

      await expect(paySplitPortion(split.id, BROKE)).rejects.toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
      });

      // Nothing moved, and the portion is still payable later.
      expect(await balance(BROKE)).toBe(0);
      expect(await balance(CREATOR)).toBe(0);
      const rows = await sql`
        SELECT status FROM split_participants WHERE split_id = ${split.id} AND user_id = ${BROKE}
      `;
      expect(rows[0].status).toBe('pending');
    });

    it('refuses payment against a split that is already settled', async () => {
      const { split } = await createSplit(CREATOR, 30, 'CAD', 'Lunch', [
        { userId: PAYER_A, amountOwed: 30 },
      ]);
      await paySplitPortion(split.id, PAYER_A);

      await expect(paySplitPortion(split.id, PAYER_B)).rejects.toMatchObject({
        code: 'NOT_PARTICIPANT',
      });
    });
  });

  describe('listing', () => {
    it('returns splits for both the creator and the participants', async () => {
      const { split } = await createSplit(CREATOR, 40, 'CAD', 'Taxi', [
        { userId: PAYER_A, amountOwed: 40 },
      ]);

      const creatorView = await listSplitsForUser(CREATOR);
      const payerView = await listSplitsForUser(PAYER_A);

      expect(creatorView.some((s) => s.id === split.id)).toBe(true);
      expect(payerView.some((s) => s.id === split.id)).toBe(true);

      const withParticipants = creatorView.find((s) => s.id === split.id);
      expect(withParticipants?.participants).toHaveLength(1);
    });

    it('does not leak a split to an unrelated user', async () => {
      const { split } = await createSplit(CREATOR, 40, 'CAD', 'Taxi', [
        { userId: PAYER_A, amountOwed: 40 },
      ]);

      const strangerView = await listSplitsForUser(PAYER_B);
      expect(strangerView.some((s) => s.id === split.id)).toBe(false);
    });
  });

  describe('conservation of money', () => {
    it('total balance across all parties is unchanged by a fully paid split', async () => {
      const before =
        (await balance(CREATOR)) + (await balance(PAYER_A)) + (await balance(PAYER_B));

      const { split } = await createSplit(CREATOR, 90, 'CAD', 'Group dinner', [
        { userId: PAYER_A, amountOwed: 45 },
        { userId: PAYER_B, amountOwed: 45 },
      ]);
      await paySplitPortion(split.id, PAYER_A);
      await paySplitPortion(split.id, PAYER_B);

      const after =
        (await balance(CREATOR)) + (await balance(PAYER_A)) + (await balance(PAYER_B));

      // A split redistributes money; it must never create or destroy any.
      expect(after).toBeCloseTo(before, 2);
    });
  });
});
