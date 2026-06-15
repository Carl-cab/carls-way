# Manna App – Database Documentation

## Schema Overview
The database uses a single schema with direct SQL queries.

## Tables
- `users`: Core identity, dual balances (`balance_cad`, `balance_usd`), legacy `balance`, `kyc_status`, auth fields.
- `transactions`: Records all money movement, including FX details (`fx_rate`, `fx_fee`, `sender_currency`, `receiver_currency`, `is_cross_border`).
- `bank_accounts`: Linked external accounts via Plaid.
- `friends`: Social graph relationships.
- `velocity_checks`: Tracks transaction volume against limits.
- `audit_logs`: System audit trail.

## Migration History
Migrations are currently ad-hoc. The initial schema is defined in `initializeSchema()` in `lib/db.ts`. Recent schema updates (adding `balance_cad`, `balance_usd`, `bank_accounts` columns) were applied via the `/api/migrate` endpoint using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
