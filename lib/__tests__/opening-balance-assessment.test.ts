/**
 * The unsafe opening-balance backfill is retired, and its replacement reports
 * without writing.
 *
 * THE DEFECT (owner decision 3, 2026-11-18). `backfillOpeningBalances()`
 * credited `u.balance_cad` — the user's CURRENT balance — as an
 * `opening_balance` entry for any user lacking one. For an account with
 * activity that books its whole history a second time. Measured on a real
 * sandbox database:
 *
 *     before:  wallet 1370.00   ledger 1270.00   discrepancy   +100.00
 *     after:   wallet 1370.00   ledger 2640.00   discrepancy  -1270.00
 *
 * AND IT LOOKED LIKE IT HELPED: aggregate violations fell 6 → 3, because the
 * accounts with no activity were corrected properly. That is the property
 * this file pins hardest — a repair that improves the headline number while
 * corrupting the accounts it touches is worse than no repair.
 *
 * WHAT IS PINNED:
 *   - the mutation path throws rather than silently doing nothing;
 *   - the assessment writes NOTHING, asserted by comparing a full ledger
 *     snapshot before and after rather than by trusting the implementation;
 *   - each classification the owner asked for, on a purpose-built account;
 *   - that an account with no evidence of its original grant is reported as
 *     unknown and NOT assumed to be 100.00.
 *
 * Real PostgreSQL on a disposable database: the subject is a read-only
 * aggregate over joins, and "it wrote nothing" is only meaningful against a
 * real one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { resolveSslMode } from '../db';
import {
  assessOpeningBalanceDiscrepancies,
  backfillOpeningBalances,
} from '../ledger';

const DB = 'manna_opening_balance_assessment_test';
const baseUrl = process.env.DATABASE_URL!;

function urlFor(db: string) {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

let admin: ReturnType<typeof postgres>;
let db: ReturnType<typeof postgres>;

async function dropScratchDatabase() {
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${DB}' AND pid <> pg_backend_pid()`,
  );
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
}

/** A full snapshot of the ledger, used to prove the assessment wrote nothing. */
async function ledgerSnapshot() {
  const rows = await db<{ snapshot: string }[]>`
    SELECT COALESCE(
      string_agg(
        id || ':' || user_id || ':' || currency || ':' || entry_type || ':' || debit || ':' || credit,
        '|' ORDER BY id
      ), ''
    ) AS snapshot
    FROM ledger_entries
  `;
  return rows[0].snapshot;
}

function row(a: Awaited<ReturnType<typeof assessOpeningBalanceDiscrepancies>>, userId: number, currency: string) {
  return a.rows.find((r) => r.userId === userId && r.currency === currency)!;
}

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = postgres(adminUrl.toString(), {
    ssl: resolveSslMode(adminUrl.toString()),
    max: 1,
    onnotice: () => {},
  });
  await dropScratchDatabase();
  await admin.unsafe(`CREATE DATABASE ${DB}`);

  const url = urlFor(DB);
  db = postgres(url, { ssl: resolveSslMode(url), max: 3, onnotice: () => {} });

  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  await db.unsafe(
    readFileSync(path.join(process.cwd(), 'lib/__tests__/helpers/test-schema.sql'), 'utf8'),
  );
}, 180000);

afterAll(async () => {
  if (db) await db.end();
  await dropScratchDatabase();
  await admin.end();
}, 60000);

beforeEach(async () => {
  for (const table of [
    'ledger_entries',
    'velocity_claims',
    'velocity_checks',
    'transfer_intents',
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

  // Five accounts, each built to land in exactly one classification.
  await db`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd, kyc_status)
    VALUES
      (8001, 'Reconciled',  'u8001', 'u8001@ob.test', 'h', 'CA', 100, 0, 'pending'),
      (8002, 'Missing',     'u8002', 'u8002@ob.test', 'h', 'CA', 100, 0, 'pending'),
      (8003, 'Active',      'u8003', 'u8003@ob.test', 'h', 'CA', 137, 0, 'pending'),
      (8004, 'Duplicate',   'u8004', 'u8004@ob.test', 'h', 'CA', 100, 0, 'pending'),
      (8005, 'Evidenced',   'u8005', 'u8005@ob.test', 'h', 'CA', 100, 0, 'pending')
  `;

  // 8001 — correctly booked, wallet equals ledger.
  await db`
    INSERT INTO ledger_entries (user_id, currency, account_type, entry_type, debit, credit)
    VALUES (8001, 'CAD', 'wallet', 'opening_balance', 0, 100)
  `;

  // 8002 — no entries at all: a seed balance that was never booked.

  // 8003 — the dangerous one: a missing opening entry AND real activity.
  // Wallet 137.00, ledger 37.00 from a payment received. The old backfill
  // would have credited 137.00 here, taking the ledger to 174.00.
  await db`
    INSERT INTO ledger_entries (user_id, currency, account_type, entry_type, debit, credit)
    VALUES (8003, 'CAD', 'wallet', 'payment_received', 0, 37)
  `;

  // 8004 — two opening entries, and they happen to sum to the wallet, so a
  // discrepancy-only classifier would call this clean.
  await db`
    INSERT INTO ledger_entries (user_id, currency, account_type, entry_type, debit, credit)
    VALUES (8004, 'CAD', 'wallet', 'opening_balance', 0, 50),
           (8004, 'CAD', 'wallet', 'opening_balance', 0, 50)
  `;

  // 8005 — unbooked, but its registration audit row evidences the grant.
  await db`
    INSERT INTO audit_logs (user_id, action, metadata)
    VALUES (8005, 'user_registered', ${db.json({
      email: 'u8005@ob.test',
      country: 'CA',
      environment: 'sandbox',
      registration_grant: { minor_units: 10000, currency: 'CAD' },
    })})
  `;
});

describe('the mutation path is retired', () => {
  it('backfillOpeningBalances() throws instead of writing', async () => {
    const before = await ledgerSnapshot();

    await expect(backfillOpeningBalances()).rejects.toThrow(/retired/i);

    // It must throw AND write nothing. A function that threw after its first
    // INSERT would satisfy the first half of that and none of the point.
    expect(await ledgerSnapshot()).toBe(before);
  });

  it('the thrown message points at the read-only replacement', async () => {
    // A caller who hits this needs to know what to do next, not merely that
    // they cannot proceed.
    await expect(backfillOpeningBalances()).rejects.toThrow(
      /assessOpeningBalanceDiscrepancies/,
    );
  });
});

describe('the assessment is read-only', () => {
  it('leaves the ledger byte-for-byte identical', async () => {
    const before = await ledgerSnapshot();
    await assessOpeningBalanceDiscrepancies(db);
    expect(await ledgerSnapshot()).toBe(before);
  });

  it('leaves every wallet balance unchanged', async () => {
    const before = await db`SELECT id, balance_cad, balance_usd FROM users ORDER BY id`;
    await assessOpeningBalanceDiscrepancies(db);
    const after = await db`SELECT id, balance_cad, balance_usd FROM users ORDER BY id`;
    expect(after).toEqual(before);
  });
});

describe('it identifies each case the owner asked for', () => {
  it('reports an account whose wallet already matches its ledger', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    expect(row(a, 8001, 'CAD').classification).toBe('reconciled');
    expect(row(a, 8001, 'CAD').openingEntryCount).toBe(1);
  });

  it('reports a missing opening entry on an account with no activity', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    const r = row(a, 8002, 'CAD');
    expect(r.classification).toBe('missing_opening_entry_no_activity');
    expect(r.discrepancy).toBe('100.00');
    expect(r.hasSubsequentActivity).toBe(false);
  });

  it('SEPARATES an account with subsequent activity — the one the backfill corrupted', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    const r = row(a, 8003, 'CAD');
    expect(r.classification).toBe('discrepant_with_activity');
    expect(r.hasSubsequentActivity).toBe(true);
    // 137.00 wallet − 37.00 ledger. The old backfill would have credited the
    // full 137.00 here; the discrepancy it should ever have addressed is 100.
    expect(r.discrepancy).toBe('100.00');
    expect(r.ledgerBalance).toBe('37.00');
  });

  it('reports duplicate opening entries even when the totals happen to balance', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    const r = row(a, 8004, 'CAD');
    // Discrepancy is zero here. Classifying on the discrepancy alone would
    // call this reconciled and hide a real defect, which is why duplicates
    // are checked first.
    expect(r.discrepancy).toBe('0.00');
    expect(r.classification).toBe('duplicate_opening_entries');
    expect(r.openingEntryCount).toBe(2);
  });
});

describe('it never assumes an unevidenced grant was 100.00', () => {
  it('reports the evidenced amount where the registration audit row has it', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    expect(row(a, 8005, 'CAD').evidencedGrantMinorUnits).toBe(10000);
  });

  it('reports null — not 100.00 — where no evidence exists', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    // 8002 is discrepant by exactly 100.00, which is precisely the case where
    // guessing is tempting and forbidden.
    expect(row(a, 8002, 'CAD').evidencedGrantMinorUnits).toBeNull();
    expect(row(a, 8003, 'CAD').evidencedGrantMinorUnits).toBeNull();
  });

  it('counts the unevidenced discrepant accounts so a repair cannot silently cover them', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    // 8002, 8003 and 8004 are not reconciled and have no evidence.
    expect(a.withoutEvidencedGrant).toBe(3);
  });

  it('summarises every row exactly once', async () => {
    const a = await assessOpeningBalanceDiscrepancies(db);
    const total = Object.values(a.summary).reduce((s, n) => s + n, 0);
    expect(total).toBe(a.rows.length);
    // Five users × two currencies.
    expect(a.rows.length).toBe(10);
  });
});
