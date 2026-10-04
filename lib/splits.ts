import { getSql } from '@/lib/db';
import { createLedgerPair } from '@/lib/ledger';
import {
  type MinorUnits,
  addMinorUnits,
  divideMinorUnitsEvenly,
  isMoneyCurrency,
  minorUnitsToMajorNumber,
  parsePositiveMoney,
  toNarrowDatabaseDecimal,
} from '@/lib/money';

/**
 * Bill splitting.
 *
 * A split is a payment request fanned out to several people. Each participant's
 * portion is tracked independently, so "partially paid" is a real state rather
 * than something inferred from a running total.
 *
 * Money movement reuses the existing atomic P2P path: paying a portion debits
 * the payer and credits the split creator inside one database transaction, and
 * writes the same ledger pair any other payment writes — on that same
 * transaction, so the record cannot survive a rolled-back payment or go missing
 * from a committed one. Splits add bookkeeping on top of that path; they do not
 * introduce a second way to move money.
 */

export type SplitStatus = 'open' | 'settled' | 'cancelled';
export type ParticipantStatus = 'pending' | 'paid';

export interface SplitParticipantInput {
  userId: number;
  amountOwed: MinorUnits;
}

export interface SplitRecord {
  id: number;
  creator_id: number;
  total_amount: string;
  currency: string;
  description: string | null;
  status: SplitStatus;
  created_at: string;
}

export interface SplitParticipantRecord {
  id: number;
  split_id: number;
  user_id: number;
  amount_owed: string;
  status: ParticipantStatus;
  transaction_id: number | null;
  paid_at: string | null;
}

export class SplitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitValidationError';
  }
}

/**
 * Create a split and its participant rows in one transaction.
 *
 * The creator is never a participant — they are owed, not owing. Portions must
 * sum to the total within a cent, so a split can never be created that silently
 * under- or over-collects.
 */
export async function createSplit(
  creatorId: number,
  totalAmount: MinorUnits,
  currency: string,
  description: string | null,
  participants: SplitParticipantInput[],
): Promise<{ split: SplitRecord; participants: SplitParticipantRecord[] }> {
  if (!Number.isSafeInteger(totalAmount) || totalAmount <= 0) {
    throw new SplitValidationError('Total amount must be greater than zero.');
  }
  if (!isMoneyCurrency(currency)) throw new SplitValidationError('Currency must be CAD or USD.');
  if (participants.length === 0) {
    throw new SplitValidationError('A split needs at least one participant.');
  }
  if (participants.some((p) => p.userId === creatorId)) {
    throw new SplitValidationError('The split creator cannot also be a participant.');
  }

  const uniqueIds = new Set(participants.map((p) => p.userId));
  if (uniqueIds.size !== participants.length) {
    throw new SplitValidationError('A participant may only appear once in a split.');
  }

  if (participants.some((p) => !Number.isSafeInteger(p.amountOwed) || p.amountOwed <= 0)) {
    throw new SplitValidationError('Every portion must be greater than zero.');
  }

  const portionSum = participants.reduce((acc, p) => addMinorUnits(acc, p.amountOwed), 0 as MinorUnits);
  if (portionSum !== totalAmount) {
    throw new SplitValidationError(
      `Portions total ${toNarrowDatabaseDecimal(portionSum)} but the split total is ${toNarrowDatabaseDecimal(totalAmount)}.`,
    );
  }

  const sql = getSql();

  return (await sql.begin(async (tx) => {
    const splitRows = await tx`
      INSERT INTO splits (creator_id, total_amount, currency, description, status)
      VALUES (${creatorId}, ${toNarrowDatabaseDecimal(totalAmount)}, ${currency}, ${description}, 'open')
      RETURNING *
    `;
    const split = splitRows[0] as unknown as SplitRecord;

    const inserted: SplitParticipantRecord[] = [];
    for (const p of participants) {
      const rows = await tx`
        INSERT INTO split_participants (split_id, user_id, amount_owed, status)
        VALUES (${split.id}, ${p.userId}, ${toNarrowDatabaseDecimal(p.amountOwed)}, 'pending')
        RETURNING *
      `;
      inserted.push(rows[0] as unknown as SplitParticipantRecord);
    }

    return { split, participants: inserted };
  })) as unknown as { split: SplitRecord; participants: SplitParticipantRecord[] };
}

/** Even division that distributes remainder cents deterministically. */
export function divideEvenly(totalAmount: MinorUnits, count: number): MinorUnits[] {
  try {
    return divideMinorUnitsEvenly(totalAmount, count);
  } catch (err) {
    throw new SplitValidationError(err instanceof Error ? err.message : 'Participant count must be positive.');
  }
}

export class SplitPaymentError extends Error {
  readonly code: 'NOT_PARTICIPANT' | 'ALREADY_PAID' | 'SPLIT_CLOSED' | 'INSUFFICIENT_BALANCE';
  constructor(code: SplitPaymentError['code'], message: string) {
    super(message);
    this.name = 'SplitPaymentError';
    this.code = code;
  }
}

/**
 * Pay one participant's portion of a split.
 *
 * Everything below happens in a single transaction:
 *   1. lock the participant row (FOR UPDATE) — concurrent double-pay attempts
 *      serialise here and the loser sees `paid`;
 *   2. guard the payer's balance in the debit itself, so a race cannot overdraw;
 *   3. credit the split creator;
 *   4. record the transaction and mark the portion paid;
 *   5. close the split if it was the last outstanding portion.
 *
 * The row lock plus the `status = 'pending'` guard on the UPDATE means a portion
 * can only ever be paid once, even under simultaneous requests.
 */
export async function paySplitPortion(
  splitId: number,
  payerId: number,
): Promise<{
  transactionId: number;
  amountPaid: number;
  splitStatus: SplitStatus;
  remainingParticipants: number;
}> {
  const sql = getSql();

  return (await sql.begin(async (tx) => {
    const participantRows = await tx`
      SELECT sp.id, sp.amount_owed, sp.status, s.creator_id, s.currency, s.status AS split_status,
             s.description
      FROM split_participants sp
      JOIN splits s ON s.id = sp.split_id
      WHERE sp.split_id = ${splitId} AND sp.user_id = ${payerId}
      FOR UPDATE OF sp
    `;

    if (!participantRows[0]) {
      throw new SplitPaymentError('NOT_PARTICIPANT', 'You are not a participant in this split.');
    }

    const participant = participantRows[0] as {
      id: number;
      amount_owed: string;
      status: ParticipantStatus;
      creator_id: number;
      currency: string;
      split_status: SplitStatus;
      description: string | null;
    };

    if (participant.status === 'paid') {
      throw new SplitPaymentError('ALREADY_PAID', 'Your portion of this split is already paid.');
    }
    if (participant.split_status !== 'open') {
      throw new SplitPaymentError('SPLIT_CLOSED', `This split is ${participant.split_status}.`);
    }

    const amount = parsePositiveMoney(participant.amount_owed, participant.currency);
    const amountDecimal = toNarrowDatabaseDecimal(amount);
    const isUsd = participant.currency === 'USD';

    // Balance guard lives in the UPDATE itself: two simultaneous debits cannot
    // both pass a separate check-then-write.
    const debited = isUsd
      ? await tx`UPDATE users SET balance_usd = balance_usd - ${amountDecimal}
                 WHERE id = ${payerId} AND balance_usd >= ${amountDecimal} RETURNING id`
      : await tx`UPDATE users SET balance_cad = balance_cad - ${amountDecimal}
                 WHERE id = ${payerId} AND balance_cad >= ${amountDecimal} RETURNING id`;

    if (debited.length === 0) {
      throw new SplitPaymentError('INSUFFICIENT_BALANCE', 'Insufficient balance to pay this portion.');
    }

    if (isUsd) {
      await tx`UPDATE users SET balance_usd = balance_usd + ${amountDecimal} WHERE id = ${participant.creator_id}`;
    } else {
      await tx`UPDATE users SET balance_cad = balance_cad + ${amountDecimal} WHERE id = ${participant.creator_id}`;
    }

    const txRows = await tx`
      INSERT INTO transactions (
        sender_id, receiver_id, amount, currency, note, type, status, privacy,
        sender_currency, receiver_currency, sender_amount, receiver_amount,
        is_cross_border, payment_rail, split_id
      ) VALUES (
        ${payerId}, ${participant.creator_id}, ${amountDecimal}, ${participant.currency},
        ${participant.description ? `Split: ${participant.description}` : 'Split payment'},
        'payment', 'completed', 'private',
        ${participant.currency}, ${participant.currency}, ${amountDecimal}, ${amountDecimal},
        false, 'internal', ${splitId}
      )
      RETURNING id
    `;
    const transactionId = txRows[0].id as number;

    // Ledger pair, on this same transaction.
    //
    // This file's own docstring claimed splits "write the same ledger pair any
    // other payment writes". They did not: the money moved above and nothing
    // was ever recorded, so the ledger — documented as a passive audit log of
    // ALL financial movement — was silently blank for an entire money-moving
    // feature. The false comment is most of why it went unnoticed.
    await createLedgerPair(
      payerId,
      participant.creator_id,
      participant.currency,
      amount,
      transactionId,
      {
        executor: tx,
        entryType: 'split_payment',
        senderDescription: participant.description
          ? `Paid split portion: ${participant.description}`
          : 'Paid split portion',
        receiverDescription: participant.description
          ? `Split portion received: ${participant.description}`
          : 'Split portion received',
      },
    );

    // `status = 'pending'` in the WHERE clause is the second guard against a
    // double payment: if another transaction won the race, this updates nothing.
    const marked = await tx`
      UPDATE split_participants
      SET status = 'paid', paid_at = NOW(), transaction_id = ${transactionId}
      WHERE id = ${participant.id} AND status = 'pending'
      RETURNING id
    `;
    if (marked.length === 0) {
      throw new SplitPaymentError('ALREADY_PAID', 'Your portion of this split is already paid.');
    }

    const remaining = await tx`
      SELECT COUNT(*)::int AS n FROM split_participants
      WHERE split_id = ${splitId} AND status = 'pending'
    `;
    const remainingParticipants = remaining[0].n as number;

    let splitStatus: SplitStatus = 'open';
    if (remainingParticipants === 0) {
      await tx`UPDATE splits SET status = 'settled', updated_at = NOW() WHERE id = ${splitId}`;
      splitStatus = 'settled';
    }

    return { transactionId, amountPaid: minorUnitsToMajorNumber(amount), splitStatus, remainingParticipants };
  })) as unknown as {
    transactionId: number;
    amountPaid: number;
    splitStatus: SplitStatus;
    remainingParticipants: number;
  };
}

export interface SplitWithParticipants extends SplitRecord {
  participants: (SplitParticipantRecord & { username: string; name: string })[];
}

/** Splits the user created or participates in, with participant detail. */
export async function listSplitsForUser(userId: number): Promise<SplitWithParticipants[]> {
  const sql = getSql();

  const splits = await sql`
    SELECT DISTINCT s.*
    FROM splits s
    LEFT JOIN split_participants sp ON sp.split_id = s.id
    WHERE s.creator_id = ${userId} OR sp.user_id = ${userId}
    ORDER BY s.created_at DESC
    LIMIT 100
  `;

  if (splits.length === 0) return [];

  const ids = splits.map((s) => s.id as number);
  const participants = await sql`
    SELECT sp.*, u.username, u.name
    FROM split_participants sp
    JOIN users u ON u.id = sp.user_id
    WHERE sp.split_id = ANY(${ids})
  `;

  return splits.map((s) => ({
    ...(s as unknown as SplitRecord),
    participants: participants.filter(
      (p) => p.split_id === s.id,
    ) as unknown as SplitWithParticipants['participants'],
  }));
}
