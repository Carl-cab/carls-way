#!/usr/bin/env bash
# Validates migrations/20261003_widen_transactions_cross_border_amounts.sql
# against a disposable local PostgreSQL database. It never connects to a remote
# database and refuses a test database name that does not contain "test".

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/migrations/20261003_widen_transactions_cross_border_amounts.sql"
base_url="${PG_TEST_BASE_URL:-postgres://postgres@127.0.0.1:5432}"
test_db="${PG_TEST_DATABASE:-manna_money_column_migration_test}"

case "$base_url" in
  postgres://postgres@127.0.0.1:*|postgresql://postgres@127.0.0.1:*) ;;
  *)
    echo "Refusing non-local PG_TEST_BASE_URL; this validator destroys a disposable database." >&2
    exit 2
    ;;
esac

case "$test_db" in
  *test*) ;;
  *)
    echo "Refusing PG_TEST_DATABASE without 'test' in its name." >&2
    exit 2
    ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required." >&2
  exit 2
fi

# Override only for a local disposable Postgres installation if necessary.
export PGPASSWORD="${PGPASSWORD:-postgres}"
url="$base_url/$test_db?sslmode=disable"

cleanup() {
  psql "$base_url/postgres" -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $test_db" >/dev/null || true
}
trap cleanup EXIT

psql "$base_url/postgres" -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $test_db" >/dev/null
psql "$base_url/postgres" -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $test_db" >/dev/null

psql "$url" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.transactions (
  id SERIAL PRIMARY KEY,
  sender_amount NUMERIC(12,2),
  receiver_amount NUMERIC(12,2)
);
INSERT INTO public.transactions (sender_amount, receiver_amount)
VALUES (9999999999.99, -9999999999.99), (0.01, 0.01), (NULL, NULL);
SQL

# Default mode must not perform DDL.
psql "$url" -v ON_ERROR_STOP=1 -f "$script" >/dev/null 2>&1
[[ "$(psql "$url" -Atqc "SELECT numeric_precision || ',' || numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name='transactions' AND column_name='sender_amount'")" == '12,2' ]]

# Authorized mode widens capacity without changing stored amount values.
psql "$url" -v ON_ERROR_STOP=1 -v apply=true -f "$script" >/dev/null 2>&1
[[ "$(psql "$url" -Atqc "SELECT string_agg(column_name || ':' || numeric_precision || ',' || numeric_scale, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='transactions' AND column_name IN ('sender_amount','receiver_amount')")" == 'receiver_amount:14,2,sender_amount:14,2' ]]
[[ "$(psql "$url" -Atqc "SELECT COALESCE(sender_amount::text, 'NULL') || ':' || COALESCE(receiver_amount::text, 'NULL') FROM public.transactions ORDER BY id" | tr '\n' '|')" == '9999999999.99:-9999999999.99|0.01:0.01|NULL:NULL|' ]]

# A second approved run is a no-op.
psql "$url" -v ON_ERROR_STOP=1 -v apply=true -f "$script" \
  >/tmp/manna_widen_rerun.out 2>&1
grep -F 'already NUMERIC(14,2); no DDL applied' /tmp/manna_widen_rerun.out >/dev/null

# An unexpected type blocks before either column can be changed.
psql "$url" -v ON_ERROR_STOP=1 -c 'TRUNCATE public.transactions' >/dev/null
psql "$url" -v ON_ERROR_STOP=1 \
  -c 'ALTER TABLE public.transactions ALTER COLUMN sender_amount TYPE NUMERIC(10,2), ALTER COLUMN receiver_amount TYPE NUMERIC(10,2)' \
  >/dev/null
if psql "$url" -v ON_ERROR_STOP=1 -v apply=true -f "$script" \
  >/tmp/manna_widen_blocked.out 2>&1; then
  echo "Expected unexpected-schema run to fail." >&2
  exit 1
fi
grep -F 'Aborting capacity alignment: expected NUMERIC(12,2) or NUMERIC(14,2)' \
  /tmp/manna_widen_blocked.out >/dev/null
[[ "$(psql "$url" -Atqc "SELECT string_agg(column_name || ':' || numeric_precision || ',' || numeric_scale, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='transactions' AND column_name IN ('sender_amount','receiver_amount')")" == 'receiver_amount:10,2,sender_amount:10,2' ]]

echo "Cross-border amount widening migration validation passed."
