-- Minimal admin schema for integration tests.
-- Mirrors the admin tables created by app/api/migrate/route.ts so the audit
-- tests exercise the real repository SQL against a real PostgreSQL server
-- rather than a hand-written fake.

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMPTZ,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Mirrors the production DDL exactly: token_hash is NOT NULL there, and there
-- are no ip_address/user_agent columns. Keeping these aligned means session code
-- cannot pass here and fail in production.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  changes JSONB,
  correlation_id VARCHAR(255),
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT REFERENCES admin_sessions(id),
  role TEXT,
  request_duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_user_id ON admin_audit_logs(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON admin_audit_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON admin_audit_logs(action);

-- Admin users referenced by the audit tests. admin_audit_logs.admin_user_id is
-- a real foreign key, so every id the tests attribute a log to must exist.
-- The concurrency test uses ids 1..10; other tests use 42 and 99.
INSERT INTO admin_users (id, email, name, password_hash, role)
SELECT i, format('test-admin-%s@example.test', i), format('Test Admin %s', i),
       'not-a-real-hash', 'OperationsAdmin'
FROM generate_series(1, 10) AS i
ON CONFLICT (id) DO NOTHING;

INSERT INTO admin_users (id, email, name, password_hash, role)
VALUES
  (42, 'test-admin-42@example.test', 'Test Admin FortyTwo', 'not-a-real-hash', 'OperationsAdmin'),
  (99, 'test-admin-99@example.test', 'Test Admin NinetyNine', 'not-a-real-hash', 'FinancialInvestigator')
ON CONFLICT (id) DO NOTHING;

-- admin_audit_logs.session_id is a real foreign key to admin_sessions.
INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
VALUES
  ('sess_123', 1, 'not-a-real-hash', NOW() + INTERVAL '1 day'),
  ('sess_xyz', 42, 'not-a-real-hash', NOW() + INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('admin_users', 'id'),
  GREATEST((SELECT MAX(id) FROM admin_users), 1)
);


-- ── Phase 3: transfer execution safety ──────────────────────────────────────
-- Mirrors lib/db.ts / app/api/migrate/route.ts for the columns these tests use.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  balance_cad REAL NOT NULL DEFAULT 0,
  balance_usd REAL NOT NULL DEFAULT 0,
  country TEXT NOT NULL DEFAULT 'CA',
  kyc_status TEXT NOT NULL DEFAULT 'pending',
  stripe_customer_id TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plaid_item_id TEXT,
  plaid_access_token_enc TEXT,
  plaid_account_id TEXT,
  stripe_payment_method_id TEXT,
  institution_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'depository',
  account_mask TEXT,
  currency TEXT NOT NULL DEFAULT 'CAD',
  country TEXT NOT NULL DEFAULT 'CA',
  is_primary BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_token_encrypted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_intents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bank_account_id INTEGER REFERENCES bank_accounts(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  provider_region TEXT NOT NULL DEFAULT 'CA',
  provider_name TEXT NOT NULL DEFAULT 'sandbox_ca',
  execution_mode TEXT NOT NULL DEFAULT 'sandbox',
  provider_reference_id TEXT,
  provider_authorization_id TEXT,
  failure_reason TEXT,
  consent_confirmed_at TIMESTAMPTZ,
  idempotency_key TEXT,
  correlation_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_idempotency_key
  ON transfer_intents(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_provider_reference
  ON transfer_intents(provider_reference_id) WHERE provider_reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_provider_authorization
  ON transfer_intents(provider_authorization_id) WHERE provider_authorization_id IS NOT NULL;

INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
VALUES (9001, 'Transfer Test User', 'transfertest9001', 'transfer9001@example.test',
        'not-a-real-hash', 'US', 'verified')
ON CONFLICT (id) DO NOTHING;

INSERT INTO bank_accounts (id, user_id, institution_name, account_name,
                           plaid_account_id, is_token_encrypted, is_verified)
VALUES (9001, 9001, 'Test Bank', 'Checking', 'plaid_acct_9001', true, true)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT MAX(id) FROM users), 1));
SELECT setval(pg_get_serial_sequence('bank_accounts','id'), GREATEST((SELECT MAX(id) FROM bank_accounts), 1));


-- ── Phase 4: splits, contacts, Interac fields ───────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT NOT NULL DEFAULT '#CC0000';
ALTER TABLE users ADD COLUMN IF NOT EXISTS interac_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_deposit_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS friends (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  friend_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  note TEXT,
  type TEXT NOT NULL DEFAULT 'payment',
  status TEXT NOT NULL DEFAULT 'completed',
  privacy TEXT NOT NULL DEFAULT 'public',
  sender_currency TEXT,
  receiver_currency TEXT,
  sender_amount REAL,
  receiver_amount REAL,
  is_cross_border BOOLEAN DEFAULT false,
  payment_rail TEXT,
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS splits (
  id SERIAL PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  total_amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS split_participants (
  id SERIAL PRIMARY KEY,
  split_id INTEGER NOT NULL REFERENCES splits(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_owed NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  transaction_id INTEGER REFERENCES transactions(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(split_id, user_id)
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS split_id INTEGER REFERENCES splits(id);

-- Split test actors: one creator, three participants.
INSERT INTO users (id, name, username, email, password_hash, country, kyc_status, balance_cad)
VALUES
  (9101, 'Split Creator', 'splitcreator', 'creator@example.test', 'x', 'CA', 'verified', 0),
  (9102, 'Split Payer A', 'splitpayera', 'payera@example.test', 'x', 'CA', 'verified', 500),
  (9103, 'Split Payer B', 'splitpayerb', 'payerb@example.test', 'x', 'CA', 'verified', 500),
  (9104, 'Broke Payer',  'brokepayer',  'broke@example.test',  'x', 'CA', 'verified', 0)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('users','id'), GREATEST((SELECT MAX(id) FROM users), 1));
