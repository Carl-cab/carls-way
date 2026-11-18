/**
 * Reconciliation recognises a split payment — WITHOUT accepting any entry type
 * on any payment.
 *
 * THE DEFECT (owner decision 1, 2026-11-18). `paySplitPortion()` writes ledger
 * entries with `entry_type='split_payment'`, but its `transactions` row is
 * `type='payment'`, `payment_rail='internal'`, `status='completed'` — squarely
 * inside reconciliation scope, where both per-payment invariants counted only
 * `payment_sent` / `payment_received`. So a split payment scored
 * `valid_sender_debit_count = 0` and `sender_debit_total = 0` against a real
 * 30.00 movement, and two of the seven checks FAILED permanently. The cron
 * answered HTTP 500 `passed:false` on any database where a split had been
 * paid. The ledger itself was always correct and balanced.
 *
 * THE FIX, AND WHY IT IS NOT AN ALLOW-LIST. The expectation is DERIVED from
 * the transaction's own classification — `split_id IS NOT NULL` — rather than
 * widened to a set of tolerated types. `entry_type IN ('payment_sent',
 * 'split_payment')` would have made the reports pass too, and would have
 * accepted a split-payment entry on an ordinary payment and an ordinary entry
 * on a split. That is weakening an invariant to manufacture a passing report,
 * which the owner explicitly forbade. There is still exactly one correct
 * answer per payment; the check now knows which.
 *
 * WHAT THIS FILE PINS. Both directions of the type rule, every strictness
 * property the owner required preserved, and the fact that cross-currency
 * payments are OUT of scope entirely. `reconciliation-sql-parity.test.ts`
 * separately requires `scripts/reconciliation-check.sql` to agree with the
 * implementation, so these cases cover both sources.
 *
 * Real PostgreSQL on a disposable database: the subject is a 150-line SQL
 * query over real joins, FILTER clauses and aggregates. A mock would compare
 * nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { resolveSslMode } from '../db';
import { reconcileInternalTransactions } from '../internal-reconciliation';

const DB = 'manna_recon_entry_type_test';
const baseUrl = process.env.DATABASE_URL!;

function urlFor(db: string) {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}
function connect(url: string) {
  return postgres(url, { ssl: resolveSslMode(url), max: 2, onnotice: () => {} });
}

let admin: ReturnType<typeof postgres>;
let db: ReturnType<typeof postgres>;

const PAYER = 7001;
const PAYEE = 7002;
const US_PAYEE = 7003;

/** The check names whose discrepancy counts this file reasons about. */
type Checks = Record<string, number>;

async function reconcile(): Promise<Checks> {
  const result = await reconcileInternalTransactions(db);
  return Object.fromEntries(
    result.checks.map((c) => [c.checkName, Number(c.discrepancyCount)]),
  );
}

/** Seed one ordinary P2P payment and one split payment, both correct. */
async function seedCorrectPayments() {
  await db`
    INSERT INTO transactions
      (id, sender_id, receiver_id, amount, currency, type, status,
       sender_currency, receiver_currency, sender_amount, receiver_amount,
       is_cross_border, payment_rail)
    VALUES (7101, ${PAYER}, ${PAYEE}, 25, 'CAD', 'pay', 'completed',
            'CAD', 'CAD', 25, 25, false, 'internal')
  `;
  await db`
    INSERT INTO ledger_entries (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
    VALUES (${PAYER}, 7101, 'CAD', 'wallet', 'payment_sent', 25, 0),
           (${PAYEE}, 7101, 'CAD', 'wallet', 'payment_received', 0, 25)
  `;

  await db`INSERT INTO splits (id, creator_id, total_amount, currency, status)
           VALUES (7200, ${PAYEE}, 30, 'CAD', 'settled')`;
  await db`
    INSERT INTO transactions
      (id, sender_id, receiver_id, amount, currency, type, status,
       sender_currency, receiver_currency, sender_amount, receiver_amount,
       is_cross_border, payment_rail, split_id)
    VALUES (7102, ${PAYER}, ${PAYEE}, 30, 'CAD', 'payment', 'completed',
            'CAD', 'CAD', 30, 30, false, 'internal', 7200)
  `;
  await db`
    INSERT INTO ledger_entries (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
    VALUES (${PAYER}, 7102, 'CAD', 'wallet', 'split_payment', 30, 0),
           (${PAYEE}, 7102, 'CAD', 'wallet', 'split_payment', 0, 30)
  `;

  // Wallets kept exactly equal to the ledger, so a wallet failure in any case
  // below is caused by that case and not by the seed.
  await db`UPDATE users SET balance_cad = -55 WHERE id = ${PAYER}`;
  await db`UPDATE users SET balance_cad =  55 WHERE id = ${PAYEE}`;
}

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = connect(adminUrl.toString());
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.unsafe(`CREATE DATABASE ${DB}`);
  db = connect(urlFor(DB));

  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  await db.unsafe(
    readFileSync(path.join(process.cwd(), 'lib/__tests__/helpers/test-schema.sql'), 'utf8'),
  );
}, 180000);

afterAll(async () => {
  if (db) await db.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.end();
}, 60000);

beforeEach(async () => {
  // A disposable database of this file's own, so a full wipe is safe here in a
  // way it would never be on the shared one.
  //
  // EVERY user is removed, including the ones the CI fixture seeds, and that
  // is necessary rather than tidy: the fixture seeds accounts holding 500.00
  // with no ledger entries at all, so `user_wallets_exactly_match_ledger`
  // could never report zero and the assertions below would be measuring the
  // fixture instead of the payment under test.
  //
  // Deleted in foreign-key order. `bank_accounts` is the one that bites — it
  // references `users` and the fixture seeds it, so a bare `DELETE FROM users`
  // fails on `bank_accounts_user_id_fkey`.
  for (const table of [
    'ledger_entries',
    'velocity_claims',
    'velocity_checks',
    'transfer_intents',
    // `transactions` before `splits`: transactions.split_id references
    // splits(id), so the reverse order fails on transactions_split_id_fkey.
    'transactions',
    'split_participants',
    'splits',
    'bank_accounts',
    'notifications',
    'password_reset_tokens',
    'friends',
    'audit_logs',
  ]) {
    await db.unsafe(`DELETE FROM ${table}`);
  }
  await db`DELETE FROM users`;
  await db`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd, kyc_status)
    VALUES (${PAYER}, 'Payer', 'payer7001', 'p7001@example.test', 'h', 'CA', 0, 0, 'verified'),
           (${PAYEE}, 'Payee', 'payee7002', 'p7002@example.test', 'h', 'CA', 0, 0, 'verified'),
           (${US_PAYEE}, 'US Payee', 'uspayee7003', 'u7003@example.test', 'h', 'US', 0, 0, 'verified')
  `;
});

describe('an ordinary P2P payment reconciles', () => {
  it('reports no discrepancy on any of the seven checks', async () => {
    await seedCorrectPayments();
    await db`DELETE FROM ledger_entries WHERE transaction_id = 7102`;
    await db`DELETE FROM transactions WHERE id = 7102`;
    await db`UPDATE users SET balance_cad = -25 WHERE id = ${PAYER}`;
    await db`UPDATE users SET balance_cad =  25 WHERE id = ${PAYEE}`;

    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(0);
    expect(c.internal_payment_amounts_match_ledger).toBe(0);
    expect(c.payment_ledger_pair_cardinality).toBe(0);
    expect(c.user_wallets_exactly_match_ledger).toBe(0);
  });
});

describe('a request-accept payment reconciles', () => {
  it('type=payment with the ordinary entry types is accepted', async () => {
    // Request-accept writes `type='payment'` — the same type a split writes —
    // which is why the classification cannot be taken from `type` alone. It is
    // the absence of `split_id` that makes this an ordinary payment.
    await db`
      INSERT INTO transactions
        (id, sender_id, receiver_id, amount, currency, type, status,
         sender_currency, receiver_currency, sender_amount, receiver_amount,
         is_cross_border, payment_rail)
      VALUES (7104, ${PAYER}, ${PAYEE}, 15, 'CAD', 'payment', 'completed',
              'CAD', 'CAD', 15, 15, false, 'internal')
    `;
    await db`
      INSERT INTO ledger_entries (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
      VALUES (${PAYER}, 7104, 'CAD', 'wallet', 'payment_sent', 15, 0),
             (${PAYEE}, 7104, 'CAD', 'wallet', 'payment_received', 0, 15)
    `;
    await db`UPDATE users SET balance_cad = -15 WHERE id = ${PAYER}`;
    await db`UPDATE users SET balance_cad =  15 WHERE id = ${PAYEE}`;

    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(0);
    expect(c.internal_payment_amounts_match_ledger).toBe(0);
    expect(c.user_wallets_exactly_match_ledger).toBe(0);
  });
});

describe('a split payment reconciles — the defect this fixes', () => {
  it('split_payment entries on a split transaction report no discrepancy', async () => {
    await seedCorrectPayments();
    const c = await reconcile();

    // These two were 1 and 1 before the fix, permanently.
    expect(c.payer_recipient_direction_currency_and_type).toBe(0);
    expect(c.internal_payment_amounts_match_ledger).toBe(0);
    expect(c.payment_ledger_pair_cardinality).toBe(0);
    expect(c.internal_ledger_currency_debits_equal_credits).toBe(0);
    expect(c.user_wallets_exactly_match_ledger).toBe(0);
    expect(c.completed_internal_payments_in_scope).toBe(0);
  });

  it('counts both payments in scope, so the split is examined and not skipped', async () => {
    // The lazy fix for a failing check is to narrow its scope. Asserting the
    // scope counter makes that visible: a split excluded rather than validated
    // would also show zero discrepancies.
    await seedCorrectPayments();
    const result = await reconcileInternalTransactions(db);
    const scope = result.checks.find(
      (x) => x.checkName === 'completed_internal_payments_in_scope',
    );
    expect(Number(scope!.observedCount)).toBe(2);
  });
});

describe('the expected type is derived, not an allow-list', () => {
  it('FAILS when a split transaction carries ordinary entry types', async () => {
    await seedCorrectPayments();
    await db`UPDATE ledger_entries SET entry_type = 'payment_sent'
             WHERE transaction_id = 7102 AND debit > 0`;
    await db`UPDATE ledger_entries SET entry_type = 'payment_received'
             WHERE transaction_id = 7102 AND credit > 0`;

    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(1);
    expect(c.internal_payment_amounts_match_ledger).toBe(1);
  });

  it('FAILS when an ordinary payment carries split entry types', async () => {
    // The direction an allow-list would have let through. Both cases must fail
    // or the fix is a widening rather than a correction.
    await seedCorrectPayments();
    await db`UPDATE ledger_entries SET entry_type = 'split_payment' WHERE transaction_id = 7101`;

    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(1);
    expect(c.internal_payment_amounts_match_ledger).toBe(1);
  });
});

describe('strictness the owner required is preserved', () => {
  it('FAILS on a missing receiver credit', async () => {
    await seedCorrectPayments();
    await db`DELETE FROM ledger_entries WHERE transaction_id = 7101 AND credit > 0`;
    const c = await reconcile();
    expect(c.payment_ledger_pair_cardinality).toBe(1);
    expect(c.payer_recipient_direction_currency_and_type).toBe(1);
    expect(c.internal_payment_amounts_match_ledger).toBe(1);
  });

  it('FAILS on a duplicated sender debit', async () => {
    await seedCorrectPayments();
    await db`
      INSERT INTO ledger_entries (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
      VALUES (${PAYER}, 7101, 'CAD', 'wallet', 'payment_sent', 25, 0)
    `;
    const c = await reconcile();
    expect(c.payment_ledger_pair_cardinality).toBe(1);
    expect(c.payer_recipient_direction_currency_and_type).toBe(1);
  });

  it('FAILS when the direction is reversed', async () => {
    await seedCorrectPayments();
    await db`UPDATE ledger_entries SET debit = 0, credit = 25
             WHERE transaction_id = 7101 AND user_id = ${PAYER}`;
    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(1);
  });

  it('FAILS on a wrong amount', async () => {
    await seedCorrectPayments();
    await db`UPDATE ledger_entries SET debit = 20
             WHERE transaction_id = 7101 AND user_id = ${PAYER}`;
    const c = await reconcile();
    expect(c.internal_payment_amounts_match_ledger).toBe(1);
  });

  it('FAILS on a wrong currency', async () => {
    await seedCorrectPayments();
    await db`UPDATE ledger_entries SET currency = 'USD'
             WHERE transaction_id = 7101 AND user_id = ${PAYEE}`;
    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(1);
  });

  it('FAILS on an entry belonging to a third party', async () => {
    await seedCorrectPayments();
    await db`UPDATE ledger_entries SET user_id = ${US_PAYEE}
             WHERE transaction_id = 7101 AND credit > 0`;
    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(1);
  });

  it('FAILS on ledger entries attached to a non-completed transaction', async () => {
    await seedCorrectPayments();
    await db`UPDATE transactions SET status = 'pending' WHERE id = 7101`;
    const c = await reconcile();
    // TWO, not one: unlike the per-payment checks this one counts LEDGER
    // ENTRIES rather than transactions, and the payment has a debit and a
    // credit. Asserted as 2 because the first draft of this case expected 1
    // and the implementation was right — the check is named
    // "..._entries_on_..." for a reason.
    expect(c.internal_ledger_entries_on_noncompleted_records).toBe(2);
  });

  it('FAILS on wallet-to-ledger inequality', async () => {
    await seedCorrectPayments();
    await db`UPDATE users SET balance_cad = balance_cad + 1 WHERE id = ${PAYER}`;
    const c = await reconcile();
    expect(c.user_wallets_exactly_match_ledger).toBe(1);
  });
});

describe('cross-currency payments are OUT of scope, and that is a gap not a pass', () => {
  it('a cross-border payment is excluded from every per-payment check', async () => {
    await seedCorrectPayments();
    await db`
      INSERT INTO transactions
        (id, sender_id, receiver_id, amount, currency, type, status,
         sender_currency, receiver_currency, sender_amount, receiver_amount,
         is_cross_border, payment_rail, fx_rate)
      VALUES (7103, ${PAYER}, ${US_PAYEE}, 10, 'CAD', 'pay', 'completed',
              'CAD', 'USD', 10, 7.29, true, 'wire', 0.7326)
    `;
    await db`
      INSERT INTO ledger_entries (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
      VALUES (${PAYER}, 7103, 'CAD', 'wallet', 'payment_sent', 10, 0),
             (${US_PAYEE}, 7103, 'USD', 'wallet', 'payment_received', 0, 7.29)
    `;
    await db`UPDATE users SET balance_cad = -65 WHERE id = ${PAYER}`;
    await db`UPDATE users SET balance_usd = 7.29 WHERE id = ${US_PAYEE}`;

    const result = await reconcileInternalTransactions(db);
    const scope = result.checks.find(
      (x) => x.checkName === 'completed_internal_payments_in_scope',
    );

    // STILL 2. The cross-border payment carries `payment_rail='wire'`, and the
    // scope is `payment_rail='internal'`, so no per-payment invariant looks at
    // it at all. This is asserted so the exclusion is a recorded fact rather
    // than something a future reader infers from a passing report.
    expect(Number(scope!.observedCount)).toBe(2);

    const c = await reconcile();
    expect(c.payer_recipient_direction_currency_and_type).toBe(0);
    expect(c.internal_payment_amounts_match_ledger).toBe(0);
  });

  it('a cross-border payment cannot balance by currency, which is why it needs clearing entries', async () => {
    // The accounting fact behind the gap, asserted rather than described.
    //
    // A cross-border payment debits CAD from the payer and credits USD to the
    // receiver. Within each currency the entry is unmatched: CAD has a debit
    // and no credit, USD a credit and no debit. Double entry cannot hold per
    // currency without an FX clearing account absorbing both legs:
    //
    //   CAD: debit payer wallet 10.00,     credit FX clearing (CAD) 10.00
    //   USD: debit FX clearing (USD) 7.29, credit receiver wallet 7.29
    //
    // The clearing account's residual across the two currencies is the FX
    // position plus spread (`fx_fee`). Adding those entries is a separate
    // financial change requiring its own authorization — decision 1 explicitly
    // asked for it to be identified and documented, not made.
    await db`
      INSERT INTO transactions
        (id, sender_id, receiver_id, amount, currency, type, status,
         sender_currency, receiver_currency, sender_amount, receiver_amount,
         is_cross_border, payment_rail, fx_rate)
      VALUES (7105, ${PAYER}, ${US_PAYEE}, 10, 'CAD', 'pay', 'completed',
              'CAD', 'USD', 10, 7.29, true, 'internal', 0.7326)
    `;
    await db`
      INSERT INTO ledger_entries (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
      VALUES (${PAYER}, 7105, 'CAD', 'wallet', 'payment_sent', 10, 0),
             (${US_PAYEE}, 7105, 'USD', 'wallet', 'payment_received', 0, 7.29)
    `;
    await db`UPDATE users SET balance_cad = -10 WHERE id = ${PAYER}`;
    await db`UPDATE users SET balance_usd = 7.29 WHERE id = ${US_PAYEE}`;

    // Forced into scope by setting payment_rail='internal', purely to show
    // what the checks would say. Both currencies fail to balance.
    const c = await reconcile();
    expect(c.internal_ledger_currency_debits_equal_credits).toBe(2);
  });
});
