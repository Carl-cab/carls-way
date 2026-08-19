import { NextResponse } from 'next/server';
import { getSql, initializeSchema } from '@/lib/db';
import { getAuthUser, auditLog } from '@/lib/auth';

/**
 * Apply pending schema changes.
 *
 * This endpoint executes DDL, so it requires an authenticated caller. It was
 * previously reachable anonymously, which contradicted its own documented
 * contract ("call GET /api/migrate once with a valid auth cookie") and left an
 * unauthenticated schema-mutation endpoint exposed on the public internet.
 *
 * Every statement it runs is idempotent (CREATE TABLE / ADD COLUMN
 * IF NOT EXISTS) and none are destructive, so the change here is to close
 * anonymous access rather than to alter what the migration does.
 *
 * Follow-up recorded for a later phase: hold this to an admin permission rather
 * than to any authenticated customer. That depends on the admin login and
 * bootstrap lifecycle, which is deliberately out of scope for Phase 2.
 */
export async function GET() {
  try {
    const user = await getAuthUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await auditLog(user.userId, 'schema_migration_run', {});

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

    return NextResponse.json({ success: true, message: 'Schema migration completed successfully' });
  } catch (err) {
    console.error('Migration error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
