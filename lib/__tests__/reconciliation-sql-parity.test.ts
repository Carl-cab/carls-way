import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getSql, initializeSchema } from '@/lib/db';
import { reconcileInternalTransactions } from '@/lib/internal-reconciliation';

/**
 * `scripts/reconciliation-check.sql` is a SECOND source of the reconciliation
 * query. The application calls `reconcileInternalTransactions()`; the
 * backup-restore rehearsal runs the .sql file with psql, because the
 * application cannot reach a restore target.
 *
 * Two sources of one query is exactly the shape that has broken this
 * repository before — the two lockfiles, and the three schema sources that
 * each caused a production or CI incident when one was missed. So this test
 * runs both against the same database and requires identical output.
 *
 * It compares check names, observed counts, discrepancy counts and statuses,
 * because a copy can drift in any of those independently. A name-only
 * comparison would pass while a FILTER predicate differed, which is precisely
 * the drift worth catching: the file would still produce seven rows and still
 * look like a reconciliation.
 *
 * Runs against real PostgreSQL. Comparing two SQL implementations against a
 * mock would compare the mock to itself.
 */

const sql = getSql();

const SQL_FILE = path.join(process.cwd(), 'scripts/reconciliation-check.sql');

interface CheckRow {
  check_name: string;
  observed_count: number | string;
  discrepancy_count: number | string;
  status: string;
}

/** Run the .sql file exactly as the runbook tells an operator to run it. */
async function runSqlFile(): Promise<CheckRow[]> {
  const text = readFileSync(SQL_FILE, 'utf8');
  return (await sql.unsafe(text)) as unknown as CheckRow[];
}

function normalize(rows: CheckRow[]) {
  return rows
    .map((r) => ({
      checkName: r.check_name,
      observedCount: Number(r.observed_count),
      discrepancyCount: Number(r.discrepancy_count),
      status: r.status,
    }))
    .sort((a, b) => a.checkName.localeCompare(b.checkName));
}

describe('scripts/reconciliation-check.sql matches the application implementation', () => {
  beforeAll(async () => {
    await initializeSchema();
  });

  it('is read-only: no statement mutates data or schema', () => {
    const text = readFileSync(SQL_FILE, 'utf8');
    // Strip comment lines before scanning, so the file's own prose about what
    // it does not do cannot trip the check.
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    for (const forbidden of [
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'CREATE',
      'DROP',
      'ALTER',
      'GRANT',
      'REVOKE',
    ]) {
      expect(code.toUpperCase()).not.toContain(forbidden);
    }
  });

  it('produces the same checks, counts and statuses as reconcileInternalTransactions()', async () => {
    const fromFile = normalize(await runSqlFile());
    const fromApp = (await reconcileInternalTransactions(sql)).checks
      .map((c) => ({
        checkName: c.checkName,
        observedCount: c.observedCount,
        discrepancyCount: c.discrepancyCount,
        status: c.status,
      }))
      .sort((a, b) => a.checkName.localeCompare(b.checkName));

    expect(fromFile).toEqual(fromApp);
  });

  it('still agrees once real payments and ledger entries exist', async () => {
    // Whatever state the database is in, both implementations must read it
    // identically. An empty database agrees trivially — every count is zero —
    // so the comparison only means something with rows present.
    const [payer] = await sql`
      INSERT INTO users (name, username, email, password_hash, country, balance_cad, balance_usd)
      VALUES ('Parity Payer', ${`parity_payer_${Date.now()}`}, ${`pp_${Date.now()}@x.test`},
              'h', 'CA', -40, 0)
      RETURNING id
    `;
    const [payee] = await sql`
      INSERT INTO users (name, username, email, password_hash, country, balance_cad, balance_usd)
      VALUES ('Parity Payee', ${`parity_payee_${Date.now()}`}, ${`pq_${Date.now()}@x.test`},
              'h', 'CA', 40, 0)
      RETURNING id
    `;
    const [txn] = await sql`
      INSERT INTO transactions
        (sender_id, receiver_id, amount, currency, type, status, privacy, payment_rail)
      VALUES (${payer.id}, ${payee.id}, 40, 'CAD', 'payment', 'completed', 'private', 'internal')
      RETURNING id
    `;
    await sql`
      INSERT INTO ledger_entries
        (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
      VALUES
        (${payer.id}, ${txn.id}, 'CAD', 'wallet', 'payment_sent', 40, 0),
        (${payee.id}, ${txn.id}, 'CAD', 'wallet', 'payment_received', 0, 40)
    `;

    const fromFile = normalize(await runSqlFile());
    const fromApp = (await reconcileInternalTransactions(sql)).checks
      .map((c) => ({
        checkName: c.checkName,
        observedCount: c.observedCount,
        discrepancyCount: c.discrepancyCount,
        status: c.status,
      }))
      .sort((a, b) => a.checkName.localeCompare(b.checkName));

    expect(fromFile).toEqual(fromApp);

    // And the payment we just inserted is actually in scope, so this test
    // would notice if the file's WHERE clause stopped matching it.
    const inScope = fromFile.find(
      (c) => c.checkName === 'completed_internal_payments_in_scope',
    );
    expect(inScope?.observedCount).toBeGreaterThan(0);

    await sql`DELETE FROM ledger_entries WHERE transaction_id = ${txn.id}`;
    await sql`DELETE FROM transactions WHERE id = ${txn.id}`;
    await sql`DELETE FROM users WHERE id IN (${payer.id}, ${payee.id})`;
  });

  it('diverges visibly if the file is edited, so drift cannot pass silently', async () => {
    // Guards the guard. If the comparison were name-only, or if normalize()
    // dropped the fields that matter, a changed predicate would still pass.
    const text = readFileSync(SQL_FILE, 'utf8');
    const tampered = text.replace(
      'WHERE wallet_ledger_entry_count <> 2',
      'WHERE wallet_ledger_entry_count <> 99',
    );
    expect(tampered).not.toBe(text);

    const [payer] = await sql`
      INSERT INTO users (name, username, email, password_hash, country, balance_cad, balance_usd)
      VALUES ('Drift Payer', ${`drift_payer_${Date.now()}`}, ${`dp_${Date.now()}@x.test`},
              'h', 'CA', -10, 0)
      RETURNING id
    `;
    const [payee] = await sql`
      INSERT INTO users (name, username, email, password_hash, country, balance_cad, balance_usd)
      VALUES ('Drift Payee', ${`drift_payee_${Date.now()}`}, ${`dq_${Date.now()}@x.test`},
              'h', 'CA', 10, 0)
      RETURNING id
    `;
    const [txn] = await sql`
      INSERT INTO transactions
        (sender_id, receiver_id, amount, currency, type, status, privacy, payment_rail)
      VALUES (${payer.id}, ${payee.id}, 10, 'CAD', 'payment', 'completed', 'private', 'internal')
      RETURNING id
    `;
    await sql`
      INSERT INTO ledger_entries
        (user_id, transaction_id, currency, account_type, entry_type, debit, credit)
      VALUES
        (${payer.id}, ${txn.id}, 'CAD', 'wallet', 'payment_sent', 10, 0),
        (${payee.id}, ${txn.id}, 'CAD', 'wallet', 'payment_received', 0, 10)
    `;

    const tamperedRows = normalize((await sql.unsafe(tampered)) as unknown as CheckRow[]);
    const appRows = (await reconcileInternalTransactions(sql)).checks
      .map((c) => ({
        checkName: c.checkName,
        observedCount: c.observedCount,
        discrepancyCount: c.discrepancyCount,
        status: c.status,
      }))
      .sort((a, b) => a.checkName.localeCompare(b.checkName));

    expect(tamperedRows).not.toEqual(appRows);

    await sql`DELETE FROM ledger_entries WHERE transaction_id = ${txn.id}`;
    await sql`DELETE FROM transactions WHERE id = ${txn.id}`;
    await sql`DELETE FROM users WHERE id IN (${payer.id}, ${payee.id})`;
  });
});
