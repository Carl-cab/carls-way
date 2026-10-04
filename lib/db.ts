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
      types: {
        // Money columns are NUMERIC, and postgres.js returns NUMERIC as a
        // *string* by default. Without this parser every balance arriving from
        // the database would be a string, and `balance + amount` would silently
        // concatenate instead of add: "100.50" + 5 === "100.505". The rest of
        // the codebase — arithmetic, comparisons, toFixed, JSON response shapes
        // — is written against numbers, so the driver hands back numbers.
        //
        // Safe for money: NUMERIC(14,2) tops out at 999999999999.99, and a JS
        // double represents every cent value exactly up to 2^53 cents (~$90
        // trillion). The conversion is exact across the entire column domain.
        //
        // This does not make float arithmetic safe in the application — it is
        // the *storage* that had to stop being float. Values still round-trip
        // through NUMERIC on every write, so the database remains the authority
        // on cent exactness.
        numeric: {
          to: 1700,
          from: [1700],
          serialize: (x: number | string) => x.toString(),
          parse: (x: string) => parseFloat(x),
        },
      },
    });
  }
  return _sql;
}

/**
 * Build the schema on `executor`, defaulting to the process-wide pool.
 *
 * The parameter exists so a test can assert what this function produces on a
 * genuinely empty database rather than on the shared one, which the fixture
 * has already populated — the same `executor` convention lib/ledger.ts uses.
 * It takes the pool type rather than ISql because the body opens its own
 * transaction, which a TransactionSql cannot nest.
 */
export async function initializeSchema(executor: ReturnType<typeof getSql> = getSql()) {
  const db = executor;

  // PostgreSQL's CREATE TABLE IF NOT EXISTS is not race-safe when multiple
  // workers attempt the first catalog write at the same instant. Keep every
  // DDL statement on one transaction-scoped advisory lock so test workers and
  // independent cold starts initialize the shared schema deterministically.
  await db.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(1760304512)`;
    await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      balance NUMERIC(14,2) NOT NULL DEFAULT 100.00,
      balance_cad NUMERIC(14,2) NOT NULL DEFAULT 0,
      balance_usd NUMERIC(14,2) NOT NULL DEFAULT 0,
      province TEXT,
      country TEXT NOT NULL DEFAULT 'CA',
      avatar_color TEXT NOT NULL DEFAULT '#CC0000',
      kyc_status TEXT NOT NULL DEFAULT 'pending',
      kyc_provider TEXT,
      kyc_session_id TEXT,
      kyc_verified_at TIMESTAMPTZ,
      kyc_rejection_reason TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      -- Bumped to invalidate every JWT already issued for this account.
      token_version INTEGER NOT NULL DEFAULT 0,
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
      amount NUMERIC(14,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      note TEXT,
      type TEXT NOT NULL DEFAULT 'payment',
      status TEXT NOT NULL DEFAULT 'completed',
      -- Private by default: a payment should not be published to the feed
      -- because its sender never found a setting they had no reason to look for.
      privacy TEXT NOT NULL DEFAULT 'private',
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
  // Password reset tokens. This lived only in app/api/migrate/route.ts, so a
  // deployment that came up through initializeSchema() — which is every cold
  // start and every test database — had no table at all, and password reset
  // failed with a 500 on the first query. CLAUDE.md requires both sources to
  // carry every table for exactly this reason.
  await sql`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS transfer_intents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      bank_account_id INTEGER REFERENCES bank_accounts(id),
      type TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
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
  // C1.3: stuck-transfer recovery flags. One open flag per intent (partial
  // unique index), so concurrent sweeps cannot double-flag. Flagging never
  // mutates the intent row itself.
  await sql`
    CREATE TABLE IF NOT EXISTS transfer_recovery_flags (
      id SERIAL PRIMARY KEY,
      transfer_intent_id INTEGER NOT NULL REFERENCES transfer_intents(id),
      status TEXT NOT NULL,
      recovery_action TEXT NOT NULL,
      reason TEXT NOT NULL,
      flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_open_recovery_flag
      ON transfer_recovery_flags (transfer_intent_id) WHERE resolved_at IS NULL
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
  // C1.4: webhook dead-letter queue. Retry tracking on the event row; the
  // dead-letter table preserves the payload of events that exhausted retries.
  await sql`
    ALTER TABLE provider_webhook_events
      ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0
  `;
  await sql`
    ALTER TABLE provider_webhook_events
      ADD COLUMN IF NOT EXISTS dead_letter_at TIMESTAMPTZ
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS webhook_dead_letters (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      raw_payload JSONB,
      failure_count INTEGER NOT NULL,
      last_error TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      requeued_at TIMESTAMPTZ,
      UNIQUE(provider, provider_event_id)
    )
  `;
  // ── Correlation ids (Milestone 2) ────────────────────────────────────────
  // One id threaded through a financial event's whole lifecycle, so an
  // operator can trace an intent to its webhooks to its ledger rows.
  //
  // These lived only in app/api/migrate/route.ts, the mirror image of the
  // C1.4 drift: a fresh environment comes up through initializeSchema() and
  // got none of them, while four admin services filter on the column —
  // AdminTransferService, AdminProviderEventService, AdminWebhookService and
  // AdminSettlementService all issue `WHERE correlation_id = ...`.
  //
  // transactions.correlation_id was in NO schema source at all, while
  // AdminSettlementService queries it against `transactions`, so
  // GET /api/admin/settlements/trace?correlation_id=... and
  // GET /api/admin/settlements?correlation_id=... raise 42703 on every
  // database including production. Declared here and in the migrate route.
  //
  // ADD COLUMN IF NOT EXISTS, not a column in the CREATE TABLE above: an
  // existing database already has the table, so only an ALTER reaches it.
  await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)`;
  await sql`ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)`;
  await sql`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)`;
  // ── Columns and tables that existed only in the migrate route ────────────
  // Enumerated by extracting every `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
  // and `CREATE TABLE IF NOT EXISTS` from app/api/migrate/route.ts and
  // checking each against a database this function had just built: 21 columns
  // and 6 tables were absent. correlation_id above was the fourth instance of
  // this drift found by hand; this closes the rest of the class at once.
  //
  // The reachable consequences on a fresh deployment, where initializeSchema()
  // is the only thing that runs:
  //   - POST /api/transactions inserts sender_amount, receiver_amount,
  //     is_cross_border and payment_rail, and /api/feed selects them, so a
  //     send and the feed both raise 42703.
  //   - lib/internal-reconciliation.ts reads sender_amount.
  //   - The entire admin RBAC surface has no tables, so no admin can log in.
  // A migrated database (production) already has all of it; this only ever
  // mattered for an environment that never ran /api/migrate.
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sender_currency TEXT NOT NULL DEFAULT 'CAD'`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receiver_currency TEXT NOT NULL DEFAULT 'CAD'`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(12,6) NOT NULL DEFAULT 1.0`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fx_fee NUMERIC(10,2) NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sender_amount NUMERIC(14,2)`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receiver_amount NUMERIC(14,2)`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_cross_border BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_rail TEXT NOT NULL DEFAULT 'internal'`;
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS estimated_settlement TIMESTAMPTZ`;
  // External provider reference for a P2P transaction (e.g. an Interac ref).
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_ref TEXT`;
  // transactions.split_id is declared after the splits table below, since it
  // references it.
  // Interac registration/auto-deposit preferences. The Interac provider itself
  // is flag-gated and inert; these columns only carry user settings.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS interac_email TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_deposit_enabled BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`;
  await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS relink_required BOOLEAN NOT NULL DEFAULT false`;
  await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
  await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS plaid_account_id TEXT`;
  await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT`;
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
  // Deferred from the column block above: this references splits(id).
  await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS split_id INTEGER REFERENCES splits(id)`;
  // ── Admin RBAC (Milestone 4/5) ───────────────────────────────────────────
  // Six tables that lived only in app/api/migrate/route.ts, so no admin could
  // authenticate on an environment built by this function alone. Pure DDL —
  // the roles and permissions themselves are seeded elsewhere, not here.
  // Admin identity is deliberately separate from `users`: a different auth
  // context, not a flag on a customer row.
  await sql`
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
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS admin_roles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS admin_permissions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES admin_roles(id),
      permission_id INTEGER NOT NULL REFERENCES admin_permissions(id),
      PRIMARY KEY (role_id, permission_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Milestone 5 additions. Kept as ALTERs rather than folded into the CREATE
  // above so a database that already has the table gets them too.
  await sql`ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES admin_sessions(id)`;
  await sql`ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS role TEXT`;
  await sql`ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS request_duration_ms INTEGER`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_user_id ON admin_audit_logs(admin_user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON admin_audit_logs(correlation_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON admin_audit_logs(created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON admin_audit_logs(action)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON admin_audit_logs(resource_type)`;
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
  // Customer-facing audit trail written by auditLog() in lib/auth.ts. That
  // helper swallows its own errors, so while this table was missing every
  // audit write across the app silently did nothing.
  await sql`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time ON audit_logs(action, created_at)`;
  // FX rate cache read and written by getFxRate() in lib/fx.ts. That read is
  // not guarded, so a missing table failed every cross-border quote outright.
    await sql`
      CREATE TABLE IF NOT EXISTS fx_rates (
        id SERIAL PRIMARY KEY,
        from_currency TEXT NOT NULL,
        to_currency TEXT NOT NULL,
        rate NUMERIC(18,8) NOT NULL,
        provider TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (from_currency, to_currency)
      )
    `;
  });

  // Runs outside the DDL transaction above: a database created before money
  // became NUMERIC still has float columns, and CREATE TABLE IF NOT EXISTS will
  // never fix them. No-op once converted.
  const upgraded = await upgradeLegacyMoneyColumns(db);
  if (upgraded.length > 0) {
    console.warn(
      'Converted legacy float money columns to NUMERIC(14,2): ' +
        upgraded.map((u) => `${u.table}.${u.column} (was ${u.from})`).join(', '),
    );
  }
}

/**
 * True when this database has no account on it yet.
 *
 * This is the bootstrap condition for /api/migrate. A brand-new deployment
 * cannot authenticate anyone — registration needs the `users` table, which
 * only the migration creates — so the migration has to be reachable exactly
 * once, before the first account exists, and never again.
 *
 * Deliberately conservative: anything unexpected (an unreadable table, a
 * failed query) reports false, which keeps the endpoint closed. The window
 * shuts permanently the moment one account is registered.
 */
export async function isUninitializedDatabase(
  sql: ReturnType<typeof getSql> = getSql(),
): Promise<boolean> {
  try {
    const present = await sql`SELECT to_regclass('public.users') IS NOT NULL AS exists`;
    if (!present[0]?.exists) return true;

    const rows = await sql`SELECT EXISTS (SELECT 1 FROM users) AS any_user`;
    return rows[0]?.any_user === false;
  } catch (err) {
    console.error('Bootstrap check failed; treating database as initialized.', err);
    return false;
  }
}

/**
 * Columns on `users` that the authentication path reads.
 *
 * If any of these is absent, login, registration and every authenticated
 * request fail with `42703 column ... does not exist` — nobody can obtain a
 * cookie, which means nobody can reach an endpoint that requires one.
 *
 * Adding a column here that the auth path reads is what keeps the bootstrap
 * window honest; `lib/__tests__/schema-bootstrap.test.ts` fails if lib/auth.ts
 * reads a `users` column this list does not name.
 */
export const AUTH_CRITICAL_USER_COLUMNS = [
  'password_hash',
  'token_version',
] as const;

/**
 * True when the schema is missing something authentication needs.
 *
 * ## Why this exists
 *
 * Release 1.0 added `users.token_version`, which `getAuthUser()` and
 * `signTokenForUser()` both read, and put the `ALTER TABLE` that creates it in
 * `/api/migrate` — an endpoint that requires an authenticated caller. On a live
 * database the result was a closed cycle: registration 500s on the missing
 * column, login 500s on it too, so no cookie can be obtained, so the migration
 * that would add the column cannot be reached. Production was locked out until
 * someone ran the `ALTER` by hand against the database.
 *
 * `isUninitializedDatabase()` did not open the window, because the database was
 * not empty — it had accounts, they just could not be used.
 *
 * The bootstrap window exists precisely because authentication is impossible.
 * "No accounts yet" is one way for that to be true; "the schema auth depends on
 * is incomplete" is another, and the remedy is identical — run the additive,
 * idempotent DDL that fixes it. So the window opens for both.
 *
 * Conservative in the same way as the check above: anything unexpected reports
 * false and keeps the endpoint closed. A database whose `users` table is absent
 * entirely is not this condition — that is `isUninitializedDatabase()`.
 */
export async function isAuthBlockedBySchema(
  sql: ReturnType<typeof getSql> = getSql(),
): Promise<boolean> {
  try {
    const present = await sql`SELECT to_regclass('public.users') IS NOT NULL AS exists`;
    if (!present[0]?.exists) return false;

    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    const have = new Set(rows.map((r) => r.column_name));
    const missing = AUTH_CRITICAL_USER_COLUMNS.filter((c) => !have.has(c));

    if (missing.length > 0) {
      console.warn(
        `Authentication is blocked by the schema: users is missing ${missing.join(', ')}. ` +
          'Opening the bootstrap window so /api/migrate can add it.',
      );
      return true;
    }
    return false;
  } catch (err) {
    console.error('Auth schema check failed; treating auth as reachable.', err);
    return false;
  }
}

/**
 * Whether /api/migrate may run without a cookie.
 *
 * True only when nobody could present one: an empty database, or one whose
 * schema cannot satisfy the auth path. Both are states where requiring
 * authentication would make the fix unreachable.
 */
export async function isBootstrapAllowed(
  sql: ReturnType<typeof getSql> = getSql(),
): Promise<boolean> {
  if (await isUninitializedDatabase(sql)) return true;
  return isAuthBlockedBySchema(sql);
}

/**
 * Money columns that must hold exact cent values.
 *
 * Shared by `upgradeLegacyMoneyColumns()` and the migrate endpoint so the two
 * cannot drift. Columns absent from a given deployment are skipped.
 */
export const MONEY_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['users', 'balance'],
  ['users', 'balance_cad'],
  ['users', 'balance_usd'],
  ['transactions', 'amount'],
  ['transactions', 'sender_amount'],
  ['transactions', 'receiver_amount'],
  ['transfer_intents', 'amount'],
] as const;

export interface MoneyColumnUpgrade {
  table: string;
  column: string;
  from: string;
}

/**
 * Convert any money column still stored as REAL/DOUBLE PRECISION to
 * NUMERIC(14,2), in place.
 *
 * `CREATE TABLE IF NOT EXISTS` only shapes a *new* database, so a deployment
 * created before this change keeps float money columns forever unless something
 * alters them. This is that something: it runs on every boot, and on a database
 * already converted it does nothing but read information_schema.
 *
 * ## Why the conversion is safe to run unattended here
 *
 * A value is converted only when it survives a round trip — when re-encoding
 * its cent value in the column's own float type reproduces the stored value
 * exactly. That identity holds for every amount that was ever a real cent
 * amount, at any magnitude, and fails only for values that were never cent
 * amounts (fractional cents, sub-cent dust). If any such value exists the
 * column is left alone and its rows are reported, because choosing what
 * 0.333333 "should have been" is a decision for a person, not a boot sequence.
 *
 * A tempting alternative — comparing against a fixed absolute tolerance — does
 * not work on float4, whose error scales with magnitude: it rejects ordinary
 * balances over a few hundred dollars. See
 * migrations/20260907_money_real_to_numeric.sql for the measurements.
 *
 * For a large production table, prefer that migration script: it takes explicit
 * locks and is meant to run during a maintenance window — and per sql/README.md
 * that run needs a reviewed procedure, a verified backup, a write drain and
 * explicit authorization, not a developer deciding on the spot. Note the
 * archived copy under sql/archive/ is the superseded draft and must not be run;
 * the corrected script is the one named above. This function exists
 * so fresh and small deployments are correct without one.
 *
 * @returns the columns it converted, empty when there was nothing to do
 */
export async function upgradeLegacyMoneyColumns(
  sql: ReturnType<typeof getSql> = getSql(),
): Promise<MoneyColumnUpgrade[]> {
  const upgraded: MoneyColumnUpgrade[] = [];

  for (const [table, column] of MONEY_COLUMNS) {
    const meta = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
        AND column_name = ${column}
    `;

    const dataType = meta[0]?.data_type;
    // Missing column: an older deployment that never had it. Already numeric:
    // nothing to do. Either way, leave it be.
    if (dataType !== 'real' && dataType !== 'double precision') continue;

    // Identifiers cannot be bound as parameters. Both come from MONEY_COLUMNS
    // above — a module-level constant, never from a request — and postgres.js
    // quotes them via sql(). The round-trip cast target is chosen from the two
    // literal branches rather than interpolated, so no value reaches the query
    // text.
    const roundTrip =
      dataType === 'real'
        ? sql`${sql(column)} <> ROUND((${sql(column)}::double precision)::numeric, 2)::real`
        : sql`${sql(column)} <> ROUND((${sql(column)}::double precision)::numeric, 2)::double precision`;

    const unsafeRows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM ${sql(table)}
      WHERE ${sql(column)} IS NOT NULL
        AND (
          ${sql(column)}::text IN ('NaN', 'Infinity', '-Infinity')
          OR ABS((${sql(column)}::double precision)::numeric) > 999999999999.99
          OR ${roundTrip}
        )
    `;

    if ((unsafeRows[0]?.count ?? 0) > 0) {
      console.error(
        `Money precision upgrade skipped for ${table}.${column}: ` +
          `${unsafeRows[0].count} value(s) are not exact cent amounts. ` +
          `Run migrations/20260907_money_real_to_numeric.sql (Stage 1 audits without ` +
          `converting) under the maintenance procedure in sql/README.md. Do not run ` +
          `the superseded draft in sql/archive/.`,
      );
      continue;
    }

    await sql.unsafe(
      `ALTER TABLE public."${table}" ALTER COLUMN "${column}" ` +
        `TYPE NUMERIC(14,2) USING ROUND(("${column}"::double precision)::numeric, 2)`,
    );
    upgraded.push({ table, column, from: dataType });
  }

  return upgraded;
}

export default getSql;