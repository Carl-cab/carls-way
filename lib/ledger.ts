import type postgres from 'postgres';
import { getSql } from '@/lib/db';
import {
  type MinorUnits,
  isMoneyCurrency,
  type MoneyCurrency,
  parseDatabaseMoney,
  subtractMinorUnits,
  toNarrowDatabaseDecimal,
} from '@/lib/money';

/**
 * Something that can run a query: the connection pool, or a transaction handle
 * handed to `sql.begin(async (tx) => ...)`.
 *
 * `ISql` is the interface both `Sql` and `TransactionSql` extend — the query
 * surface without the pool-lifecycle methods (`END`, `CLOSE`, `listen`) that a
 * transaction handle deliberately lacks. Typing against it is what lets one
 * function body serve both callers without a cast.
 *
 * The ledger is described as a passive audit log of all financial movement. It
 * can only be that if its entries commit with the movement they record, which
 * means writing them on the caller's transaction rather than a fresh
 * connection.
 */
export type LedgerExecutor = postgres.ISql;

export interface LedgerEntry {
  id: number;
  user_id: number;
  transaction_id: number | null;
  transfer_intent_id: number | null;
  currency: string;
  account_type: string;
  entry_type: string;
  debit: string;
  credit: string;
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

  const debit = parseDatabaseMoney(debitEntry.debit, debitEntry.currency);
  const debitCredit = parseDatabaseMoney(debitEntry.credit, debitEntry.currency);
  const creditDebit = parseDatabaseMoney(creditEntry.debit, creditEntry.currency);
  const credit = parseDatabaseMoney(creditEntry.credit, creditEntry.currency);

  // Debit entry must have debit > 0 and credit = 0.
  if (debit <= 0 || debitCredit !== 0) {
    console.error('Ledger pair validation failed: debit entry malformed', debitEntry);
    return false;
  }

  // Credit entry must have credit > 0 and debit = 0
  if (credit <= 0 || creditDebit !== 0) {
    console.error('Ledger pair validation failed: credit entry malformed', creditEntry);
    return false;
  }

  // Amounts should match
  if (debit !== credit) {
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
  debit: MinorUnits,
  credit: MinorUnits,
  options?: {
    transactionId?: number | null;
    transferIntentId?: number | null;
    provider?: string;
    providerReference?: string;
    description?: string;
    /**
     * Run the INSERT on a caller's transaction instead of a pooled
     * connection, so the entry commits — or rolls back — with whatever else
     * that transaction is doing.
     *
     * `createLedgerPair()` has always taken one; this function did not, which
     * meant any caller needing a single entry written atomically with a
     * balance change had to inline the SQL. Registration needs exactly that:
     * the account row and its opening-balance entry must both exist or
     * neither.
     *
     * Passing `tx` is also what keeps this off a second pool connection. The
     * pool is `max: 5`, and a caller holding one inside `sql.begin` that lets
     * this fall back to `getSql()` asks for a second while holding the first
     * — the deadlock shape CLAUDE.md documents for the velocity helpers.
     */
    executor?: LedgerExecutor;
  }
): Promise<number> {
  // Validation
  if (!isMoneyCurrency(currency)) {
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

  const sql = options?.executor ?? getSql();
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
      ${toNarrowDatabaseDecimal(debit)},
      ${toNarrowDatabaseDecimal(credit)},
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
  amount: MinorUnits,
  transactionId: number,
  options?: {
    /**
     * A shared operation label for both sides of the pair, such as
     * `split_payment`. Prefer directional labels for ordinary P2P transfers.
     */
    entryType?: string;
    /** Entry type applied to the sender's debit. */
    senderEntryType?: string;
    /** Entry type applied to the recipient's credit. */
    receiverEntryType?: string;
    senderDescription?: string;
    receiverDescription?: string;
    provider?: string;
    /**
     * Transaction to write inside, from `sql.begin(async (tx) => ...)`.
     *
     * Without this the entries go out on a separate connection, so they commit
     * independently of the balance change they describe — and a caller that
     * wants both to succeed or neither has no way to ask for it. Callers that
     * move money should always pass their transaction.
     */
    executor?: LedgerExecutor;
  }
): Promise<{ debitEntryId: number; creditEntryId: number }> {
  if (senderUserId === receiverUserId) {
    throw new Error('Cannot create ledger pair where sender and receiver are the same user.');
  }

  if (amount <= 0) {
    throw new Error('Amount must be greater than zero.');
  }

  if (!isMoneyCurrency(currency)) {
    throw new Error(`Invalid currency: ${currency}. Must be CAD or USD.`);
  }

  const sql = options?.executor ?? getSql();
  // A payment direction belongs to the individual ledger row, not the pair.
  // The original single `entryType` option applied `payment_sent` to both
  // entries, which made the recipient's credit appear to be an outgoing
  // payment in ledger history and reporting. A shared type remains supported
  // for operations whose accounting label is deliberately neutral (for
  // example, `split_payment`).
  const senderEntryType = options?.senderEntryType ?? options?.entryType ?? 'payment_sent';
  const receiverEntryType = options?.receiverEntryType ?? options?.entryType ?? 'payment_received';

  // One statement, so the pair can never be half-written. When `executor` is a
  // caller's transaction this also commits with the balance change it records.
  const results = await sql`
    WITH sender_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, provider, description
      ) VALUES (
        ${senderUserId}, ${transactionId}, ${currency}, 'wallet', ${senderEntryType},
        ${toNarrowDatabaseDecimal(amount)}, '0.00', ${options?.provider ?? null}, ${options?.senderDescription ?? null}
      )
      RETURNING id
    ),
    receiver_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, provider, description
      ) VALUES (
        ${receiverUserId}, ${transactionId}, ${currency}, 'wallet', ${receiverEntryType},
        '0.00', ${toNarrowDatabaseDecimal(amount)}, ${options?.provider ?? null}, ${options?.receiverDescription ?? null}
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
  senderAmount: MinorUnits,
  receiverUserId: number,
  receiverCurrency: string,
  receiverAmount: MinorUnits,
  transactionId: number,
  options?: {
    senderDescription?: string;
    receiverDescription?: string;
    provider?: string;
    /** Transaction to write inside. See createLedgerPair. */
    executor?: LedgerExecutor;
  }
): Promise<{ senderEntryId: number; receiverEntryId: number }> {
  if (senderUserId === receiverUserId) {
    throw new Error('Cannot create ledger pair where sender and receiver are the same user.');
  }

  if (senderAmount <= 0 || receiverAmount <= 0) {
    throw new Error('Both sender and receiver amounts must be greater than zero.');
  }

  if (!isMoneyCurrency(senderCurrency) || !isMoneyCurrency(receiverCurrency)) {
    throw new Error('Both currencies must be CAD or USD.');
  }

  const sql = options?.executor ?? getSql();

  // Insert both entries in a single statement for atomicity
  const results = await sql`
    WITH sender_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, description, provider
      ) VALUES (
        ${senderUserId}, ${transactionId}, ${senderCurrency}, 'wallet', 'payment_sent',
        ${toNarrowDatabaseDecimal(senderAmount)}, '0.00', ${options?.senderDescription ?? null}, ${options?.provider ?? null}
      )
      RETURNING id
    ),
    receiver_entry AS (
      INSERT INTO ledger_entries (
        user_id, transaction_id, currency, account_type, entry_type,
        debit, credit, description, provider
      ) VALUES (
        ${receiverUserId}, ${transactionId}, ${receiverCurrency}, 'wallet', 'payment_received',
        '0.00', ${toNarrowDatabaseDecimal(receiverAmount)}, ${options?.receiverDescription ?? null}, ${options?.provider ?? null}
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
export async function getLedgerBalance(userId: number, currency: string): Promise<MinorUnits> {
  if (!isMoneyCurrency(currency)) {
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

  const totalDebits = parseDatabaseMoney(String(result[0].total_debits), currency);
  const totalCredits = parseDatabaseMoney(String(result[0].total_credits), currency);

  // Balance = credits - debits (money in minus money out)
  return subtractMinorUnits(totalCredits, totalDebits);
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

/**
 * RETIRED. This function no longer writes to the ledger, and must not be made
 * to again (owner decision 3, 2026-11-18).
 *
 * WHAT IT DID AND WHY THAT WAS WRONG. It credited `u.balance_cad` — the
 * user's **current** balance — as an `opening_balance` entry for any user
 * lacking one. For a user who had transacted, that books their entire history
 * a second time. Measured on a real sandbox database:
 *
 *     before:  wallet 1370.00   ledger 1270.00   discrepancy   +100.00
 *     after:   wallet 1370.00   ledger 2640.00   discrepancy  -1270.00
 *
 * Twelve times worse, in the opposite direction, on a ledger documented as a
 * passive audit log of all financial movement.
 *
 * THE TRAP, which is the part worth remembering: it looked like it helped.
 * Aggregate `user_wallets_exactly_match_ledger` violations fell from 6 to 3,
 * because the three users with no activity WERE corrected properly. An
 * operator reading the count would have concluded the operation worked while
 * it was corrupting every active account it touched.
 *
 * It was reachable through `POST /api/admin/ledger/backfill-opening-balances`
 * — gated on `BACKFILL_SECRET` and `exceptions:manage`, i.e. designed to be
 * run by an operator — with no guard restricting it to users who have no
 * other entries.
 *
 * THROWS rather than returning a zero result. A silent no-op would let a
 * caller believe a repair had happened; a caller that cannot repair must find
 * out at the call site.
 *
 * The read-only replacement is `assessOpeningBalanceDiscrepancies()` below.
 * It reports and never writes. A repair needs its own authorization, its own
 * evidence of each account's ORIGINAL grant, and a plan — none of which this
 * function had.
 */
export async function backfillOpeningBalances(): Promise<never> {
  throw new Error(
    'backfillOpeningBalances() is retired: it credited each user\'s CURRENT ' +
      'balance as an opening entry, double-counting the history of every ' +
      'active account. Use assessOpeningBalanceDiscrepancies() for a ' +
      'read-only report. A repair requires separate owner authorization.',
  );
}

/** One (user, currency) pair in the opening-balance assessment. */
export interface OpeningBalanceAssessmentRow {
  userId: number;
  currency: MoneyCurrency;
  /** The wallet column, as stored. */
  walletBalance: string;
  /** Sum of credits minus debits across that user's wallet entries. */
  ledgerBalance: string;
  /** wallet − ledger. Zero means the account reconciles. */
  discrepancy: string;
  openingEntryCount: number;
  /** Total credited by existing opening entries, for spotting a wrong one. */
  openingEntryTotal: string;
  /**
   * Whether the account has any ledger entry that is NOT an opening balance.
   * This is the fact that made the old backfill dangerous, so it is reported
   * per account rather than inferred.
   */
  hasSubsequentActivity: boolean;
  /**
   * The original grant where it is INDEPENDENTLY EVIDENCED — read from the
   * `user_registered` audit row's `registration_grant` metadata, which
   * registration began writing under decision 2.
   *
   * `null` means no evidence exists, and that is the common case for
   * historical accounts. It explicitly does NOT mean "no grant" and must not
   * be read as one: assuming every historical user received 100.00 is exactly
   * the guess decision 3 forbids.
   */
  evidencedGrantMinorUnits: number | null;
  classification: OpeningBalanceClassification;
}

export type OpeningBalanceClassification =
  /** Wallet equals ledger. Nothing to do. */
  | 'reconciled'
  /** No opening entry, no other activity, and a discrepancy equal to the wallet. */
  | 'missing_opening_entry_no_activity'
  /** Discrepant AND has other activity — the case the old backfill corrupted. */
  | 'discrepant_with_activity'
  /** More than one opening entry for this currency. */
  | 'duplicate_opening_entries'
  /** Discrepant in a shape none of the above describes. */
  | 'requires_manual_investigation';

export interface OpeningBalanceAssessment {
  rows: OpeningBalanceAssessmentRow[];
  summary: Record<OpeningBalanceClassification, number>;
  /** Rows whose evidence is absent, so no repair amount can be derived. */
  withoutEvidencedGrant: number;
}

/**
 * READ-ONLY assessment of opening-balance state. Executes SELECTs only.
 *
 * This is a diagnostic, NOT a repair, and the distinction is deliberate and
 * load-bearing: the operation it replaces looked like a repair and was a
 * corruption. Nothing here writes, and nothing here proposes an amount for an
 * account whose original grant is not independently evidenced.
 */
export async function assessOpeningBalanceDiscrepancies(
  executor: LedgerExecutor = getSql(),
): Promise<OpeningBalanceAssessment> {
  const rows = await executor<
    {
      user_id: number;
      currency: string;
      wallet_balance: string;
      ledger_balance: string;
      discrepancy: string;
      opening_entry_count: string;
      opening_entry_total: string;
      has_subsequent_activity: boolean;
      evidenced_grant_minor_units: string | null;
    }[]
  >`
    WITH per_currency AS (
      SELECT u.id AS user_id, 'CAD' AS currency, u.balance_cad AS wallet_balance FROM users u
      UNION ALL
      SELECT u.id, 'USD', u.balance_usd FROM users u
    ),
    ledger AS (
      SELECT
        pc.user_id,
        pc.currency,
        pc.wallet_balance,
        COALESCE(SUM(le.credit - le.debit), 0)::numeric(14,2) AS ledger_balance,
        COUNT(le.id) FILTER (WHERE le.entry_type = 'opening_balance') AS opening_entry_count,
        COALESCE(SUM(le.credit) FILTER (WHERE le.entry_type = 'opening_balance'), 0)::numeric(14,2)
          AS opening_entry_total,
        COUNT(le.id) FILTER (WHERE le.entry_type <> 'opening_balance') > 0
          AS has_subsequent_activity
      FROM per_currency pc
      LEFT JOIN ledger_entries le
        ON le.user_id = pc.user_id
       AND le.currency = pc.currency
       AND le.account_type = 'wallet'
      GROUP BY pc.user_id, pc.currency, pc.wallet_balance
    ),
    evidence AS (
      -- The ONLY independent evidence of an original grant: the registration
      -- audit row. A readJsonbRecord()-style read is unnecessary here
      -- because this reads a key that only the corrected writer produces, and
      -- a legacy string-scalar row simply yields NULL — which is the correct
      -- answer for an account registered before the evidence existed.
      SELECT
        al.user_id,
        al.metadata #>> '{registration_grant,currency}' AS currency,
        (al.metadata #>> '{registration_grant,minor_units}') AS minor_units
      FROM audit_logs al
      WHERE al.action = 'user_registered'
        AND jsonb_typeof(al.metadata) = 'object'
    )
    SELECT
      l.user_id,
      l.currency,
      l.wallet_balance::text    AS wallet_balance,
      l.ledger_balance::text    AS ledger_balance,
      (l.wallet_balance - l.ledger_balance)::text AS discrepancy,
      l.opening_entry_count::text AS opening_entry_count,
      l.opening_entry_total::text AS opening_entry_total,
      l.has_subsequent_activity,
      e.minor_units             AS evidenced_grant_minor_units
    FROM ledger l
    LEFT JOIN evidence e ON e.user_id = l.user_id AND e.currency = l.currency
    ORDER BY l.user_id, l.currency
  `;

  const summary: Record<OpeningBalanceClassification, number> = {
    reconciled: 0,
    missing_opening_entry_no_activity: 0,
    discrepant_with_activity: 0,
    duplicate_opening_entries: 0,
    requires_manual_investigation: 0,
  };
  let withoutEvidencedGrant = 0;

  const assessed = rows.map((r): OpeningBalanceAssessmentRow => {
    const openingEntryCount = Number(r.opening_entry_count);
    const discrepancy = Number(r.discrepancy);

    let classification: OpeningBalanceClassification;
    if (openingEntryCount > 1) {
      // Checked FIRST: a duplicate is a defect even on an account that
      // happens to reconcile, and classifying by discrepancy alone would hide
      // it behind a zero.
      classification = 'duplicate_opening_entries';
    } else if (discrepancy === 0) {
      classification = 'reconciled';
    } else if (r.has_subsequent_activity) {
      classification = 'discrepant_with_activity';
    } else if (openingEntryCount === 0 && Number(r.ledger_balance) === 0) {
      classification = 'missing_opening_entry_no_activity';
    } else {
      classification = 'requires_manual_investigation';
    }
    summary[classification] += 1;

    const evidenced =
      r.evidenced_grant_minor_units === null ? null : Number(r.evidenced_grant_minor_units);
    if (classification !== 'reconciled' && evidenced === null) withoutEvidencedGrant += 1;

    return {
      userId: r.user_id,
      currency: r.currency as MoneyCurrency,
      walletBalance: r.wallet_balance,
      ledgerBalance: r.ledger_balance,
      discrepancy: r.discrepancy,
      openingEntryCount,
      openingEntryTotal: r.opening_entry_total,
      hasSubsequentActivity: r.has_subsequent_activity,
      evidencedGrantMinorUnits: evidenced,
      classification,
    };
  });

  return { rows: assessed, summary, withoutEvidencedGrant };
}
