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

    // Add missing columns to users table if they don't exist
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_cad REAL NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_usd REAL NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'pending'`;

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
