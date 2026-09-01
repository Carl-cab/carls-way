import postgres from 'postgres';

let _sql: ReturnType<typeof postgres> | null = null;

/**
 * Resolve the TLS mode for a connection string.
 *
 * TLS is required by default. It is relaxed only when the connection string
 * explicitly asks with the standard libpq parameter `?sslmode=disable`, which is
 * how a local or CI PostgreSQL instance without certificates is addressed.
 * Absent, empty, malformed, or unrecognised values all resolve to 'require', so
 * a typo cannot silently drop encryption.
 *
 * Exported for testing: this is a security-relevant default and is asserted in
 * lib/__tests__/security-database.test.ts.
 */
export function resolveSslMode(connectionString: string): 'require' | false {
  try {
    const sslMode = new URL(connectionString).searchParams.get('sslmode');
    return sslMode === 'disable' ? false : 'require';
  } catch {
    return 'require';
  }
}

export function getSql() {
  if (!_sql) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    // Parse URL manually so special characters in the password don't break URL parsing
    const url = new URL(dbUrl);

    const ssl = resolveSslMode(dbUrl);

    _sql = postgres({
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.replace(/^\//, ''),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl,
      max: 5,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false, // Required for Supabase transaction/session pooler
    });
  }
  return _sql;
}

export async function initializeSchema() {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 100.00,
      balance_cad REAL NOT NULL DEFAULT 0,
      balance_usd REAL NOT NULL DEFAULT 0,
      province TEXT,
      country TEXT NOT NULL DEFAULT 'CA',
      avatar_color TEXT NOT NULL DEFAULT '#CC0000',
      kyc_status TEXT NOT NULL DEFAULT 'pending',
      kyc_provider TEXT,
      kyc_session_id TEXT,
      kyc_verified_at TIMESTAMPTZ,
      kyc_rejection_reason TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      friend_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      plaid_item_id TEXT,
      plaid_access_token_enc TEXT,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(plaid_item_id, account_mask)
    )
  `;
  await sql`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      related_entity_type TEXT,
      related_entity_id INTEGER,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
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
      -- Plaid returns an authorization before the transfer is created, and that
      -- authorization id doubles as the provider's idempotency identifier
      -- (plaid SDK 42.x: TransferCreateRequest.idempotency_key is deprecated in
      -- its favour). Persisting it BEFORE calling transferCreate is what makes a
      -- provider-success / database-failure window recoverable.
      provider_authorization_id TEXT,
      failure_reason TEXT,
      consent_confirmed_at TIMESTAMPTZ,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      transaction_id INTEGER REFERENCES transactions(id),
      transfer_intent_id INTEGER REFERENCES transfer_intents(id),
      currency TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'wallet',
      entry_type TEXT NOT NULL,
      debit NUMERIC(12,2) NOT NULL DEFAULT 0,
      credit NUMERIC(12,2) NOT NULL DEFAULT 0,
      provider TEXT,
      provider_reference TEXT,
      provider_event_id TEXT,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(transfer_intent_id, provider_event_id, entry_type)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS provider_webhook_events (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      related_provider_reference TEXT,
      raw_payload JSONB,
      processing_status TEXT NOT NULL DEFAULT 'received',
      processing_error TEXT,
      processed_at TIMESTAMPTZ,
      balance_processed_at TIMESTAMPTZ,
      balance_processing_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(provider, provider_event_id)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS splits (
      id SERIAL PRIMARY KEY,
      creator_id INTEGER NOT NULL REFERENCES users(id),
      total_amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
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
    )
  `;
  // Rolling per-user transaction volume, read by checkVelocityLimit() and
  // written by recordVelocity() / reverseVelocity() in lib/auth.ts.
  await sql`
    CREATE TABLE IF NOT EXISTS velocity_checks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      window_type TEXT NOT NULL,
      window_start TIMESTAMPTZ NOT NULL,
      transaction_count INTEGER NOT NULL DEFAULT 0,
      total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'CAD',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Partial uniqueness: exactly one accumulating row per window, while the
  // compensating rows reverseVelocity() appends (transaction_count < 0) stay
  // append-only. recordVelocity()'s upsert targets this index explicitly.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS velocity_checks_window_key
      ON velocity_checks (user_id, window_type, window_start, currency)
      WHERE transaction_count >= 0
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_velocity_checks_lookup
      ON velocity_checks (user_id, window_type, currency, window_start)
  `;
}

export default getSql;