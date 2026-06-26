import { NextResponse } from 'next/server';
import { getSql, initializeSchema } from '@/lib/db';

export async function GET() {
  try {
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

    return NextResponse.json({ success: true, message: 'Schema migration completed successfully' });
  } catch (err) {
    console.error('Migration error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
