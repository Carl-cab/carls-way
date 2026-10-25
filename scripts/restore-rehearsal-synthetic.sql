-- Synthetic dataset for the Phase 0 restore rehearsal.
--
-- ## What this is for
--
-- `docs/runbooks/backup-restore-rehearsal.md` describes dumping a production
-- backup and restoring it into an isolated target, then proving the restore is
-- usable: schema present, data coherent, financial invariants intact. Every
-- command in it was written without ever being run end to end, because running
-- it needs a production backup and an owner-provisioned target.
--
-- This file supplies a *synthetic* source database instead, so the procedure
-- itself can be executed and the verification steps proven to work — including
-- proven to FAIL when the data is wrong, which is the part that actually
-- matters. A verification step that cannot detect a bad restore is decoration.
--
-- **This is not a production rehearsal and must never be reported as one.** It
-- contains no customer data, exercises no production credential, and touches
-- no production host. It validates the runbook's commands; it does not validate
-- any particular backup.
--
-- ## Why the numbers are what they are
--
-- The dataset is deliberately the smallest one that satisfies the invariants
-- *non-trivially*. An empty database passes every check in
-- `scripts/reconciliation-check.sql` vacuously, which would make a green run
-- meaningless. So there is a real internal payment with both ledger legs, and
-- opening balances, so that:
--
--   * each user's wallet column equals the sum of that user's own ledger
--     entries in that currency  (user_wallets_exactly_match_ledger)
--   * per-currency debits equal credits on completed internal payments
--     (internal_payment_debits_match_credits)
--   * each payment has exactly two wallet entries, one valid debit and one
--     valid credit, whose amounts equal the payment's own amounts
--     (the per-payment checks, which aggregates cannot imply)
--
-- Alice opens with 100 CAD, Bob with 100 CAD. Alice pays Bob 25 CAD. Final
-- wallets: Alice 75, Bob 125 — and 100-25 = 75, 100+25 = 125 in the ledger.
-- USD is left at zero with no USD entries, so 0 = 0 holds rather than being
-- skipped.

-- ## One divergence this rehearsal uncovered, handled here deliberately
--
-- `users.balance` is the legacy pre-dual-currency column. The three schema
-- sources disagree about it:
--
--   scripts/verify-migrate.sql:106     REQUIRES it present
--   lib/db.ts:82 (initializeSchema)    CREATES it, NUMERIC(14,2) DEFAULT 100
--   lib/__tests__/helpers/test-schema.sql   does NOT create it
--
-- `lib/__tests__/schema-source-parity.test.ts` compares the migrate route
-- against `initializeSchema()` only, so nothing flags the fixture direction.
--
-- The omission may well be protective rather than a bug — `CLAUDE.md` forbids
-- new code touching `users.balance`, and a fixture without the column makes
-- any such read fail loudly in CI with 42703. So this file does NOT change the
-- fixture. It adds the column to the rehearsal's own source database, because
-- the point of a restore rehearsal is to exercise a *production-shaped*
-- database, and production has the column.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(14,2) NOT NULL DEFAULT 100.00;

INSERT INTO users (id, name, username, email, password_hash, country, balance, balance_cad, balance_usd)
VALUES
  (99001, 'Rehearsal Alice', 'rehearsal_alice', 'alice@rehearsal.invalid', 'not-a-real-hash', 'CA', 0, 75.00, 0.00),
  (99002, 'Rehearsal Bob',   'rehearsal_bob',   'bob@rehearsal.invalid',   'not-a-real-hash', 'CA', 0, 125.00, 0.00);

-- Opening balances. `backfillOpeningBalances()` creates these in the real
-- application; the reconciliation query treats them as ordinary wallet entries,
-- so a user whose balance came from a seed with no matching entry would fail
-- user_wallets_exactly_match_ledger. Including them is what makes that check
-- meaningful here rather than accidentally satisfied.
INSERT INTO ledger_entries (user_id, account_type, entry_type, currency, debit, credit, transaction_id, description)
VALUES
  (99001, 'wallet', 'opening_balance', 'CAD', 0, 100.00, NULL, 'synthetic opening balance'),
  (99002, 'wallet', 'opening_balance', 'CAD', 0, 100.00, NULL, 'synthetic opening balance');

-- One completed internal payment, Alice -> Bob, 25 CAD.
INSERT INTO transactions
  (id, sender_id, receiver_id, type, status, payment_rail, amount, currency,
   sender_amount, receiver_amount, sender_currency, receiver_currency, note)
VALUES
  (99101, 99001, 99002, 'pay', 'completed', 'internal', 25.00, 'CAD',
   25.00, 25.00, 'CAD', 'CAD', 'synthetic internal payment');

-- Both legs. The per-payment checks require exactly two wallet entries for the
-- payment: one debit on the sender with entry_type 'payment_sent' and credit 0,
-- one credit on the receiver with entry_type 'payment_received' and debit 0.
INSERT INTO ledger_entries (user_id, account_type, entry_type, currency, debit, credit, transaction_id, description)
VALUES
  (99001, 'wallet', 'payment_sent',     'CAD', 25.00, 0, 99101, 'synthetic payment leg'),
  (99002, 'wallet', 'payment_received', 'CAD', 0, 25.00, 99101, 'synthetic payment leg');

-- An audit row, so audit-log preservation across the dump/restore is observable
-- rather than asserted over an empty table.
INSERT INTO audit_logs (user_id, action, metadata)
VALUES (99001, 'synthetic_rehearsal_event', '{"note":"synthetic"}'::jsonb);

COMMIT;
