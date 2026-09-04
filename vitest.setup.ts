/**
 * Vitest global setup.
 *
 * These are unit tests over pure logic (formatting, pagination, permission
 * evaluation, export shaping). Several of them construct repositories or
 * services whose constructors call getSql(), which throws when DATABASE_URL is
 * unset. postgres.js connects lazily, so supplying a syntactically valid URL is
 * enough for construction to succeed — no database is contacted, and no test
 * issues a query.
 *
 * `??=` so a real DATABASE_URL (for example a CI service container) is honoured
 * when one is provided.
 */
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/manna_test';

/**
 * Deliberately NOT set here: MANNA_ENV.
 *
 * The KYC security tests assert that an undeclared environment resolves to
 * production and therefore fails closed. Defaulting it to sandbox in test setup
 * would mask exactly the regression those tests exist to catch.
 */
