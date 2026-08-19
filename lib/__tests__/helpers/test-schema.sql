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

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
INSERT INTO admin_sessions (id, admin_user_id, expires_at)
VALUES
  ('sess_123', 1, NOW() + INTERVAL '1 day'),
  ('sess_xyz', 42, NOW() + INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

SELECT setval(
  pg_get_serial_sequence('admin_users', 'id'),
  GREATEST((SELECT MAX(id) FROM admin_users), 1)
);
