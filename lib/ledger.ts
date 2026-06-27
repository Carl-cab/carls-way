import { getSql } from '@/lib/db';

export interface LedgerEntry {
  id: number;
  user_id: number;
  transaction_id: number | null;
  transfer_intent_id: number | null;
  currency: string;
  account_type: string;
  entry_type: string;
  debit: number;
  credit: number;
  provider: string | null;
  provider_reference: string | null;
  description: string | null;
  created_at: string;
}

// Validates that a pair of entries (debit and credit) are properly formed.
// Both entries should reference the same transaction and have opposite signs.
export function validateLedgerPair(debitEntry: Omit<LedgerEntry, 'id' | 'created_at'>, creditEntry: Omit<LedgerEntry, 'id' | 'created_at'>): boolean {
  // Both should have the same transaction_id
  if (debitEntry.transaction_id !== creditEntry.transaction_id) {
    console.error('Ledger pair validation failed: transaction_id mismatch');
    return false;
  }

  // Debit entry must have debit > 0 and credit = 0
  if (debitEntry.debit <= 0 || debitEntry.credit !== 0) {
    console.error('Ledger pair validation failed: debit entry malformed', debitEntry);
    return false;
  }

  // Credit entry must have credit > 0 and debit = 0
  if (creditEntry.credit <= 0 || creditEntry.debit !== 0) {
    console.error('Ledger pair validation failed: credit entry malformed', creditEntry);
    return false;
  }

  // Amounts should match
  if (debitEntry.debit !== creditEntry.credit) {
    console.error('Ledger pair validation failed: amounts do not match', { debit: debitEntry.debit, credit: creditEntry.credit });
    return false;
  }

  return true;
}

// Create a single ledger entry.
export async function createLedgerEntry(
  userId: number,
  currency: string,
  accountType: string,
  entryType: string,
  debit: number,
  credit: number,
  options?: {
    transactionId?: number | null;
    transferIntentId?: number | null;
    provider?: string;
    providerReference?: string;
    description?: string;
  }
): Promise<number> {
  // Validation
  if (currency !== 'CAD' && currency !== 'USD') {
    throw new Error(`Invalid currency: ${currency}. Must be CAD or USD.`);
  }

  if (debit < 0 || credit < 0) {
    throw new Error('Debit and credit amounts must be non-negative.');
  }

  if (debit > 0 && credit > 0) {
    throw new Error('Debit and credit cannot both be positive on the same entry.');
  }

  if (debit === 0 && credit === 0) {
    throw new Error('Debit or credit must be greater than zero.');
  }

  const sql = getSql();
  const result = await sql`
    INSERT INTO ledger_entries (
      user_id, transaction_id, transfer_intent_id,
      currency, account_type, entry_type,
      debit, credit, provider, provider_reference, description
    ) VALUES (
      ${userId},
      ${options?.transactionId ?? null},
      ${options?.transferIntentId ?? null},
      ${currency},
      ${accountType},
      ${entryType},
      ${debit},
      ${credit},
      ${options?.provider ?? null},
      ${options?.providerReference ?? null},
      ${options?.description ?? null}
    )
    RETURNING id
  `;

  return result[0].id as number;
}

// Create a balanced pair of ledger entries (debit + credit) atomically.
// Both entries reference the same transaction and represent money flowing from one user to another.
export async function createLedgerPair(
  senderUserId: number,
  receiverUserId: number,
  currency: string,
  amount: number,
  transactionId: number,
  options?: {
    entryType?: string;
    senderDescription?: string;
    receiverDescription?: string;
    provider?: string;
  }
): Promise<{ debitEntryId: number; creditEntryId: number }> {
  if (senderUserId === receiverUserId) {
    throw new Error('Cannot create ledger pair where sender and receiver are the same user.');
  }

  if (amount <= 0) {
    throw new Error('Amount must be greater than zero.');
  }

  if (currency !== 'CAD' && currency !== 'USD') {
    throw new Error(`Invalid currency: ${currency}. Must be CAD or USD.`);
  }

  const sql = getSql();
  const entryType = options?.entryType ?? 'payment';

  // Insert both entries in a single batch for atomicity
  const results = await sql`
    WITH sender_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, provider, description
      ) VALUES (
        ${senderUserId}, ${transactionId}, ${currency}, 'wallet', ${entryType},
        ${amount}, 0, ${options?.provider ?? null}, ${options?.senderDescription ?? null}
      )
      RETURNING id
    ),
    receiver_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, provider, description
      ) VALUES (
        ${receiverUserId}, ${transactionId}, ${currency}, 'wallet', ${entryType},
        0, ${amount}, ${options?.provider ?? null}, ${options?.receiverDescription ?? null}
      )
      RETURNING id
    )
    SELECT
      (SELECT id FROM sender_entry) as sender_id,
      (SELECT id FROM receiver_entry) as receiver_id
  `;

  return {
    debitEntryId: results[0].sender_id as number,
    creditEntryId: results[0].receiver_id as number,
  };
}

// Create cross-border ledger entries atomically (different currencies, different amounts).
// Sender debit in sender currency, receiver credit in receiver currency.
// Both entries are created in a single transaction to prevent partial/incomplete ledger state.
export async function createCrossBorderLedgerPair(
  senderUserId: number,
  senderCurrency: string,
  senderAmount: number,
  receiverUserId: number,
  receiverCurrency: string,
  receiverAmount: number,
  transactionId: number,
  options?: {
    senderDescription?: string;
    receiverDescription?: string;
    provider?: string;
  }
): Promise<{ senderEntryId: number; receiverEntryId: number }> {
  if (senderUserId === receiverUserId) {
    throw new Error('Cannot create ledger pair where sender and receiver are the same user.');
  }

  if (senderAmount <= 0 || receiverAmount <= 0) {
    throw new Error('Both sender and receiver amounts must be greater than zero.');
  }

  if ((senderCurrency !== 'CAD' && senderCurrency !== 'USD') ||
      (receiverCurrency !== 'CAD' && receiverCurrency !== 'USD')) {
    throw new Error('Both currencies must be CAD or USD.');
  }

  const sql = getSql();

  // Insert both entries in a single transaction for atomicity
  const results = await sql`
    WITH sender_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, description, provider
      ) VALUES (
        ${senderUserId}, ${transactionId}, ${senderCurrency}, 'wallet', 'payment_sent',
        ${senderAmount}, 0, ${options?.senderDescription ?? null}, ${options?.provider ?? null}
      )
      RETURNING id
    ),
    receiver_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, description, provider
      ) VALUES (
        ${receiverUserId}, ${transactionId}, ${receiverCurrency}, 'wallet', 'payment_received',
        0, ${receiverAmount}, ${options?.receiverDescription ?? null}, ${options?.provider ?? null}
      )
      RETURNING id
    )
    SELECT
      (SELECT id FROM sender_entry) as sender_id,
      (SELECT id FROM receiver_entry) as receiver_id
  `;

  return {
    senderEntryId: results[0].sender_id as number,
    receiverEntryId: results[0].receiver_id as number,
  };
}

// Get the computed ledger balance for a user in a specific currency.
// This sums all debits and credits across all ledger entries for the user.
export async function getLedgerBalance(userId: number, currency: string): Promise<number> {
  if (currency !== 'CAD' && currency !== 'USD') {
    throw new Error(`Invalid currency: ${currency}. Must be CAD or USD.`);
  }

  const sql = getSql();
  const result = await sql`
    SELECT
      COALESCE(SUM(debit), 0) as total_debits,
      COALESCE(SUM(credit), 0) as total_credits
    FROM ledger_entries
    WHERE user_id = ${userId} AND currency = ${currency}
  `;

  const totalDebits = parseFloat(String(result[0].total_debits));
  const totalCredits = parseFloat(String(result[0].total_credits));

  // Balance = credits - debits (money in minus money out)
  return totalCredits - totalDebits;
}

// Get all ledger entries for a user.
export async function getUserLedgerEntries(userId: number, limit: number = 100): Promise<LedgerEntry[]> {
  const sql = getSql();
  const entries = await sql`
    SELECT * FROM ledger_entries
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return entries as unknown as LedgerEntry[];
}

// Backfill opening balance ledger entries for users with seed balances but no ledger entries.
// Safe idempotent operation: checks if opening_balance entry exists before creating.
// Does NOT modify user balances. Called during migration or via admin API.
// Returns count of entries created.
export async function backfillOpeningBalances(): Promise<{ cadCount: number; usdCount: number }> {
  const sql = getSql();

  // Find users with non-zero balance_cad but no opening_balance entry
  const cadResults = await sql`
    INSERT INTO ledger_entries (
      user_id, currency, account_type, entry_type,
      debit, credit, description
    )
    SELECT
      u.id,
      'CAD',
      'wallet',
      'opening_balance',
      0,
      u.balance_cad,
      'Opening seed balance'
    FROM users u
    WHERE u.balance_cad > 0
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries le
        WHERE le.user_id = u.id
          AND le.currency = 'CAD'
          AND le.entry_type = 'opening_balance'
      )
    ON CONFLICT DO NOTHING
    RETURNING user_id
  `;

  // Find users with non-zero balance_usd but no opening_balance entry
  const usdResults = await sql`
    INSERT INTO ledger_entries (
      user_id, currency, account_type, entry_type,
      debit, credit, description
    )
    SELECT
      u.id,
      'USD',
      'wallet',
      'opening_balance',
      0,
      u.balance_usd,
      'Opening seed balance'
    FROM users u
    WHERE u.balance_usd > 0
      AND NOT EXISTS (
        SELECT 1 FROM ledger_entries le
        WHERE le.user_id = u.id
          AND le.currency = 'USD'
          AND le.entry_type = 'opening_balance'
      )
    ON CONFLICT DO NOTHING
    RETURNING user_id
  `;

  return {
    cadCount: cadResults.length,
    usdCount: usdResults.length,
  };
}
