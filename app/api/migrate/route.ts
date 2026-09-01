import { NextRequest, NextResponse } from 'next/server';
import { getSql, initializeSchema, isUninitializedDatabase } from '@/lib/db';
import { getAuthUser, auditLog } from '@/lib/auth';
import { checkRateLimit, clientIdentifier, rateLimitHeaders } from '@/lib/rate-limit';

/**
 * Apply pending schema changes.
 *
 * This endpoint executes DDL, so it normally requires an authenticated caller.
 * It was once reachable anonymously, which left an unauthenticated
 * schema-mutation endpoint exposed on the public internet; that is closed.
 *
 * The one exception is first-run bootstrap. A brand-new deployment cannot
 * authenticate anyone, because registration needs the `users` table that only
 * this migration creates — schema, account, and cookie form a cycle with no
 * entry point. So when the database holds no account at all, this runs
 * unauthenticated, and it stops doing so permanently once the first account
 * exists.
 *
 * What that window can be used for is bounded: every statement here is
 * idempotent (CREATE TABLE / ADD COLUMN / CREATE INDEX ... IF NOT EXISTS) and
 * none are destructive, so the most an anonymous caller can do on a database
 * with no accounts on it is create the empty schema that deployment was about
 * to create anyway. No data is read back to the caller and no privilege is
 * granted. The path is rate limited and audited separately from the
 * authenticated one.
 *
 * Follow-up recorded for a later phase: hold the authenticated path to an admin
 * permission rather than to any authenticated customer. That depends on the
 * admin login lifecycle, which remains out of scope here.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getAuthUser();
    let bootstrap = false;

    if (!user) {
      bootstrap = await isUninitializedDatabase();
      if (!bootstrap) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      // Throttle the anonymous path so the bootstrap window cannot be used to
      // hammer DDL at the database.
      const limit = await checkRateLimit('schema:bootstrap', clientIdentifier(req), {
        limit: 3,
        windowSeconds: 3600,
      });
      if (!limit.allowed) {
        return NextResponse.json(
          { error: 'Too many attempts. Please try again later.' },
          { status: 429, headers: rateLimitHeaders(limit) },
        );
      }
    }

    // On the bootstrap path audit_logs does not exist yet, so the bootstrap
    // run is recorded after the schema has been created instead.
    if (user) await auditLog(user.userId, 'schema_migration_run', {});

    // Run full schema initialization (creates missing tables)
    await initializeSchema();

    const sql = getSql();

    // Add missing columns to bank_accounts table if they don't exist
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS plaid_item_id TEXT`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS plaid_access_token_enc TEXT`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'depository'`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_mask TEXT`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CAD'`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'CA'`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_token_encrypted BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS relink_required BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

    // Add missing columns to users table if they don't exist
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_cad REAL NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_usd REAL NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'pending'`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_provider TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_session_id TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_verified_at TIMESTAMPTZ`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`;

    // Add missing columns to friends table if they don't exist
    await sql`ALTER TABLE friends ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES users(id)`;
    await sql`ALTER TABLE friends ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

    // Create notifications table if it doesn't exist
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

    // Create password_reset_tokens table if it doesn't exist
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

    // Create transfer_intents table if it doesn't exist
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
        failure_reason TEXT,
        consent_confirmed_at TIMESTAMPTZ,
        idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Add new transfer_intents columns for existing production tables
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id)`;
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS provider_region TEXT NOT NULL DEFAULT 'CA'`;
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS provider_name TEXT NOT NULL DEFAULT 'sandbox_ca'`;
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'sandbox'`;
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS consent_confirmed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS idempotency_key TEXT`;

    // ── Phase 4: bill splitting ─────────────────────────────────────────────
    // A split is a request fanned out to several people. It records who owes
    // what and tracks each portion independently, so a partially-paid split is
    // a first-class state rather than something inferred.
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
        -- One row per person per split: makes double-paying structurally impossible.
        UNIQUE(split_id, user_id)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_split_participants_user ON split_participants(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_splits_creator ON splits(creator_id)`;

    // ── velocity_checks ─────────────────────────────────────────────────────
    // This table was read and written by lib/auth.ts but was never created by
    // initializeSchema() or by this route, so every send failed with a 500 on
    // any environment that had not had it created by hand. Every statement is
    // additive, so an environment that already carries the table keeps its
    // data and simply gains any column or index it was missing.
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
    await sql`ALTER TABLE velocity_checks ADD COLUMN IF NOT EXISTS window_type TEXT`;
    await sql`ALTER TABLE velocity_checks ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ`;
    await sql`ALTER TABLE velocity_checks ADD COLUMN IF NOT EXISTS transaction_count INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE velocity_checks ADD COLUMN IF NOT EXISTS total_amount NUMERIC(14,2) NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE velocity_checks ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CAD'`;
    await sql`ALTER TABLE velocity_checks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_velocity_checks_lookup
        ON velocity_checks (user_id, window_type, currency, window_start)
    `;
    // recordVelocity()'s upsert names this index as its conflict target, so it
    // must exist before that path can run. It can only fail on an environment
    // that already holds duplicate rows for a window — report that rather than
    // aborting the rest of the migration, since it needs a human to dedupe.
    let velocityIndexNote: string | undefined;
    try {
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS velocity_checks_window_key
          ON velocity_checks (user_id, window_type, window_start, currency)
          WHERE transaction_count >= 0
      `;
    } catch (indexErr) {
      velocityIndexNote =
        'velocity_checks_window_key could not be created — the table holds duplicate ' +
        'rows for at least one (user_id, window_type, window_start, currency). Dedupe ' +
        'them and re-run this migration; recordVelocity() will fail until it exists.';
      console.error('velocity_checks unique index creation failed:', indexErr);
    }

    // ── audit_logs and fx_rates ─────────────────────────────────────────────
    // Both were read and written by application code but created by neither
    // initializeSchema() nor this route. auditLog() swallows its own errors,
    // so the customer audit trail silently recorded nothing; getFxRate() does
    // not guard its cache read, so every cross-border quote failed outright.
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
    await sql`
      CREATE TABLE IF NOT EXISTS fx_rates (
        id SERIAL PRIMARY KEY,
        from_currency TEXT NOT NULL,
        to_currency TEXT NOT NULL,
        rate NUMERIC(18,8) NOT NULL,
        provider TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // getFxRate() upserts with ON CONFLICT (from_currency, to_currency), so the
    // pair must be unique. Reported rather than fatal if existing rows already
    // duplicate a pair, since that needs a human to pick the surviving row.
    let fxIndexNote: string | undefined;
    try {
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_pair_key
          ON fx_rates (from_currency, to_currency)
      `;
    } catch (indexErr) {
      fxIndexNote =
        'fx_rates_pair_key could not be created — the table holds duplicate rows for ' +
        'at least one (from_currency, to_currency). Dedupe them and re-run this ' +
        'migration; FX rate caching will fail until it exists.';
      console.error('fx_rates unique index creation failed:', indexErr);
    }

    // ── Phase 4: Interac e-Transfer fields ──────────────────────────────────
    // Registration/auto-deposit settings. The Interac provider itself is
    // flag-gated and inert; these columns only carry user preferences.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS interac_email TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_deposit_enabled BOOLEAN NOT NULL DEFAULT false`;
    // External provider reference for a P2P transaction (e.g. an Interac ref).
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_ref TEXT`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS split_id INTEGER REFERENCES splits(id)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_ref
              ON transactions(external_ref) WHERE external_ref IS NOT NULL`;

    // Phase 3: transfer execution safety.
    // provider_authorization_id is persisted before the provider call and is the
    // Plaid idempotency identifier for transferCreate, so a transfer that the
    // provider accepted can always be recovered even if the follow-up write fails.
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS provider_authorization_id TEXT`;
    // One logical transfer must map to at most one provider operation. Partial
    // indexes so the many rows with NULLs are unaffected.
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_idempotency_key
              ON transfer_intents(idempotency_key) WHERE idempotency_key IS NOT NULL`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_provider_reference
              ON transfer_intents(provider_reference_id) WHERE provider_reference_id IS NOT NULL`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_intents_provider_authorization
              ON transfer_intents(provider_authorization_id) WHERE provider_authorization_id IS NOT NULL`;
    // Reconciliation scans intents whose provider outcome is unknown.
    await sql`CREATE INDEX IF NOT EXISTS idx_transfer_intents_submitting
              ON transfer_intents(status) WHERE status = 'submitting'`;

    // Add missing columns to transactions table if they don't exist
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sender_currency TEXT NOT NULL DEFAULT 'CAD'`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receiver_currency TEXT NOT NULL DEFAULT 'CAD'`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(12,6) NOT NULL DEFAULT 1.0`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fx_fee NUMERIC(10,2) NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sender_amount NUMERIC(12,2)`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receiver_amount NUMERIC(12,2)`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_cross_border BOOLEAN NOT NULL DEFAULT false`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_rail TEXT NOT NULL DEFAULT 'internal'`;
    await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS estimated_settlement TIMESTAMPTZ`;

    // Create ledger_entries table if it doesn't exist
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

    // Add provider_event_id column to ledger_entries if it doesn't exist
    await sql`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS provider_event_id TEXT`;

    // Create provider_webhook_events table if it doesn't exist
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

    // Add balance tracking columns to provider_webhook_events if they don't exist
    await sql`ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS balance_processed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS balance_processing_error TEXT`;

    // Phase C1: Live provider columns
    // bank_accounts: Plaid account_id (for Transfer API) and Stripe payment method (for ACSS)
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS plaid_account_id TEXT`;
    await sql`ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT`;
    // users: Stripe customer_id (for ACSS debit mandate)
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`;
    // Milestone 2: Add correlation IDs for request tracing
    // Correlation IDs allow tracking a financial event through its entire lifecycle
    await sql`ALTER TABLE transfer_intents ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)`;
    await sql`ALTER TABLE provider_webhook_events ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)`;
    await sql`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255)`;

    // Milestone 4: Create admin tables for RBAC
    // Admin users separate from customer users - different auth context
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

    // Admin roles: SuperAdmin, OperationsAdmin, FinancialInvestigator, ComplianceOfficer, ReadOnlyAuditor
    await sql`
      CREATE TABLE IF NOT EXISTS admin_roles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Permissions: granular access control
    await sql`
      CREATE TABLE IF NOT EXISTS admin_permissions (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        category TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Join table: roles have permissions
    await sql`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INTEGER NOT NULL REFERENCES admin_roles(id),
        permission_id INTEGER NOT NULL REFERENCES admin_permissions(id),
        PRIMARY KEY (role_id, permission_id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Admin sessions for authentication
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

    // Audit log hooks for Milestone 5 (prepare structure, don't populate yet)
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

    // Milestone 5: Enhance admin_audit_logs with additional fields
    await sql`ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES admin_sessions(id)`;
    await sql`ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS role TEXT`;
    await sql`ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS request_duration_ms INTEGER`;

    // Add index for audit log queries
    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_user_id ON admin_audit_logs(admin_user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON admin_audit_logs(correlation_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON admin_audit_logs(created_at)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON admin_audit_logs(action)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON admin_audit_logs(resource_type)`;

    if (bootstrap) {
      await auditLog(null, 'schema_migration_bootstrap', { client: clientIdentifier(req) });
    }

    const warnings = [velocityIndexNote, fxIndexNote].filter(
      (w): w is string => typeof w === 'string',
    );

    return NextResponse.json({
      success: true,
      message: 'Schema migration completed successfully',
      ...(bootstrap ? { bootstrap: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (err) {
    console.error('Migration error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
