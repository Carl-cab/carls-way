/**
 * Registration: the grant is sandbox-only, and it is booked atomically.
 *
 * TWO DEFECTS, corrected together because fixing either alone leaves an
 * inconsistent account (owner decision 2, 2026-11-18).
 *
 * 1. THE GRANT WAS UNCONDITIONAL. Every account on every deployment received
 *    CA$100 or US$100 — production included. Simulated money credited to a
 *    real customer wallet with no funding event, no provider settlement and
 *    no accounting behind it.
 * 2. THE GRANT WAS NEVER BOOKED. It went straight into the balance columns
 *    with no ledger entry, so every registered user's wallet was permanently
 *    out of step with their ledger by their seed amount and
 *    `user_wallets_exactly_match_ledger` could never pass. Measured on the
 *    sandbox before this change: two users, each +100.00.
 *
 * WHAT IS PINNED HERE, and why each case is not redundant:
 *
 *   - the CAD and USD grants, because the currency is country-derived;
 *   - production starting at ZERO, which is the security property;
 *   - the ledger entry existing and matching the wallet exactly, because a
 *     grant that is booked wrong is worse than one not booked at all;
 *   - ROLLBACK: a ledger failure must leave no account behind, which is the
 *     only case that distinguishes a real transaction from two statements
 *     that happen to run in order;
 *   - repeated and concurrent registration, because "duplicate registration
 *     cannot create duplicate credits" is a requirement in its own right.
 *
 * Real PostgreSQL on a disposable database. The subject is transaction
 * boundaries and a unique constraint under concurrency; a mock has neither.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { resolveSslMode } from '../db';

const DB = 'manna_registration_grant_test';
const baseUrl = process.env.DATABASE_URL!;

function urlFor(db: string) {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

let admin: ReturnType<typeof postgres>;
let db: ReturnType<typeof postgres>;

/**
 * Drop the scratch database, first disconnecting anything still attached.
 *
 * A plain DROP fails with `database "..." is being accessed by other users`:
 * the route under test reaches the database through `getSql()`'s module-level
 * singleton pool, which this file never holds a handle to and therefore
 * cannot close. The failure appears only in a full-suite run, because running
 * this file alone tears the worker down before the drop is reached.
 */
async function dropScratchDatabase() {
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${DB}' AND pid <> pg_backend_pid()`,
  );
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
}


const ORIGINAL_ENV = { ...process.env };

/**
 * The route reads `DATABASE_URL` through `getSql()`'s module-level singleton,
 * so the environment has to be set before the module is first imported and
 * the module registry reset between environment changes.
 */
async function importRoute() {
  const mod = await import('../../app/api/auth/register/route');
  return mod.POST;
}

function registerRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '198.51.100.7' },
    body: JSON.stringify(body),
  }) as never;
}

async function walletAndLedger(email: string) {
  const [row] = await db<
    {
      id: number;
      balance_cad: string;
      balance_usd: string;
      ledger_cad: string;
      ledger_usd: string;
      opening_entries: string;
    }[]
  >`
    SELECT u.id,
           u.balance_cad,
           u.balance_usd,
           -- Cast to numeric(14,2) BEFORE ::text. A COALESCE default of 0 is
           -- an integer, so a user with no entries rendered '0' while one with
           -- entries rendered '100.00', and an assertion comparing the two
           -- shapes failed on formatting rather than on money.
           COALESCE(SUM(le.credit - le.debit) FILTER (WHERE le.currency = 'CAD'), 0)::numeric(14,2)::text AS ledger_cad,
           COALESCE(SUM(le.credit - le.debit) FILTER (WHERE le.currency = 'USD'), 0)::numeric(14,2)::text AS ledger_usd,
           COUNT(le.id) FILTER (WHERE le.entry_type = 'opening_balance')::text AS opening_entries
    FROM users u
    LEFT JOIN ledger_entries le ON le.user_id = u.id AND le.account_type = 'wallet'
    WHERE u.email = ${email}
    GROUP BY u.id, u.balance_cad, u.balance_usd
  `;
  return row;
}

beforeAll(async () => {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  admin = postgres(adminUrl.toString(), { ssl: resolveSslMode(adminUrl.toString()), max: 1, onnotice: () => {} });
  await dropScratchDatabase();
  await admin.unsafe(`CREATE DATABASE ${DB}`);

  const url = urlFor(DB);
  db = postgres(url, { ssl: resolveSslMode(url), max: 4, onnotice: () => {} });

  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  await db.unsafe(
    readFileSync(path.join(process.cwd(), 'lib/__tests__/helpers/test-schema.sql'), 'utf8'),
  );
}, 180000);

afterAll(async () => {
  if (db) await db.end();
  await dropScratchDatabase();
  await admin.end();
  process.env = ORIGINAL_ENV;
}, 60000);

beforeEach(async () => {
  await db`DELETE FROM ledger_entries WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@grant.test')`;
  await db`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@grant.test')`;
  await db`DELETE FROM users WHERE email LIKE '%@grant.test'`;

  // The rate limiter is in-process and keyed per client; these requests all
  // carry one IP, and `auth:register` allows 3 per hour. Resetting the module
  // registry between cases gives each a fresh counter, which is why every
  // case re-imports the route rather than sharing one handle.
  const { vi } = await import('vitest');
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, DATABASE_URL: urlFor(DB) };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('sandbox registration grants simulated funds and books them', () => {
  it('a CA user receives CA$100 with a matching opening_balance entry', async () => {
    process.env.MANNA_ENV = 'sandbox';
    delete process.env.VERCEL_ENV;
    const POST = await importRoute();

    const res = await POST(
      registerRequest({
        name: 'Grant CA',
        email: 'ca@grant.test',
        password: 'SandboxPass!2026',
        country: 'CA',
      }),
    );
    expect(res.status).toBe(201);

    const row = await walletAndLedger('ca@grant.test');
    expect(row.balance_cad).toBe('100.00');
    expect(row.balance_usd).toBe('0.00');
    expect(row.opening_entries).toBe('1');
    // The property that matters: wallet equals ledger exactly. This is the
    // check that could never pass before.
    expect(row.ledger_cad).toBe('100.00');
  });

  it('a US user receives US$100 in USD, not CAD', async () => {
    process.env.MANNA_ENV = 'sandbox';
    delete process.env.VERCEL_ENV;
    const POST = await importRoute();

    expect(
      (
        await POST(
          registerRequest({
            name: 'Grant US',
            email: 'us@grant.test',
            password: 'SandboxPass!2026',
            country: 'US',
          }),
        )
      ).status,
    ).toBe(201);

    const row = await walletAndLedger('us@grant.test');
    expect(row.balance_usd).toBe('100.00');
    expect(row.balance_cad).toBe('0.00');
    expect(row.ledger_usd).toBe('100.00');
    expect(row.ledger_cad).toBe('0.00');
  });
});

describe('production registration starts at zero', () => {
  it('no balance and no ledger entry when MANNA_ENV is absent', async () => {
    // Absent, not "production": production is the default, and a deployment
    // that simply never set the variable must not receive the grant.
    delete process.env.MANNA_ENV;
    delete process.env.VERCEL_ENV;
    const POST = await importRoute();

    expect(
      (
        await POST(
          registerRequest({
            name: 'Prod Default',
            email: 'proddefault@grant.test',
            password: 'SandboxPass!2026',
            country: 'CA',
          }),
        )
      ).status,
    ).toBe(201);

    const row = await walletAndLedger('proddefault@grant.test');
    expect(row.balance_cad).toBe('0.00');
    expect(row.balance_usd).toBe('0.00');
    expect(row.opening_entries).toBe('0');
  });

  it('VERCEL_ENV=production overrides MANNA_ENV=sandbox', async () => {
    // The override is the control that stops a stray variable turning a
    // production deployment into one that mints simulated money.
    process.env.MANNA_ENV = 'sandbox';
    process.env.VERCEL_ENV = 'production';
    const POST = await importRoute();

    expect(
      (
        await POST(
          registerRequest({
            name: 'Prod Override',
            email: 'prodoverride@grant.test',
            password: 'SandboxPass!2026',
            country: 'CA',
          }),
        )
      ).status,
    ).toBe(201);

    const row = await walletAndLedger('prodoverride@grant.test');
    expect(row.balance_cad).toBe('0.00');
    expect(row.opening_entries).toBe('0');
  });

  it('a misspelled MANNA_ENV does not grant', async () => {
    process.env.MANNA_ENV = 'Sandbox_';
    delete process.env.VERCEL_ENV;
    const POST = await importRoute();

    await POST(
      registerRequest({
        name: 'Typo Env',
        email: 'typo@grant.test',
        password: 'SandboxPass!2026',
        country: 'CA',
      }),
    );

    const row = await walletAndLedger('typo@grant.test');
    expect(row.balance_cad).toBe('0.00');
    expect(row.opening_entries).toBe('0');
  });
});

describe('account creation and the opening entry are one transaction', () => {
  it('rolls the account back when the ledger insert fails', async () => {
    // The ledger insert is made to fail by removing the column it writes,
    // on this file's OWN disposable database — never the shared one, because
    // vitest runs files in parallel and a missing column is a race rather
    // than an ordering problem.
    //
    // Without the transaction, the user row would survive and the account
    // would exist with an unexplained balance. That is the exact state this
    // case exists to forbid.
    process.env.MANNA_ENV = 'sandbox';
    delete process.env.VERCEL_ENV;
    const POST = await importRoute();

    await db`ALTER TABLE ledger_entries RENAME COLUMN entry_type TO entry_type_moved`;
    try {
      const res = await POST(
        registerRequest({
          name: 'Rollback Case',
          email: 'rollback@grant.test',
          password: 'SandboxPass!2026',
          country: 'CA',
        }),
      );
      expect(res.status).toBe(500);
    } finally {
      await db`ALTER TABLE ledger_entries RENAME COLUMN entry_type_moved TO entry_type`;
    }

    const [{ count }] = await db<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM users WHERE email = 'rollback@grant.test'
    `;
    expect(count, 'the account must not survive a failed opening entry').toBe('0');
  });
});

describe('duplicate registration cannot create duplicate credits', () => {
  it('a repeated email is refused with 409 and grants nothing a second time', async () => {
    process.env.MANNA_ENV = 'sandbox';
    delete process.env.VERCEL_ENV;
    const POST = await importRoute();

    const first = await POST(
      registerRequest({
        name: 'Repeat One',
        email: 'repeat@grant.test',
        password: 'SandboxPass!2026',
        country: 'CA',
      }),
    );
    expect(first.status).toBe(201);

    const second = await POST(
      registerRequest({
        name: 'Repeat Two',
        email: 'repeat@grant.test',
        password: 'SandboxPass!2026',
        country: 'CA',
      }),
    );
    expect(second.status).toBe(409);

    const row = await walletAndLedger('repeat@grant.test');
    expect(row.balance_cad).toBe('100.00');
    expect(row.opening_entries).toBe('1');
    expect(row.ledger_cad).toBe('100.00');
  });

  it('concurrent registrations of one email produce one account and one entry', async () => {
    // The pre-check is `SELECT ... WHERE email = ?` followed by an INSERT —
    // two statements on two snapshots — so what actually prevents a double
    // account is the UNIQUE constraint on users.email, not the check. This
    // case exercises that: whichever request loses gets a constraint
    // violation and a 500, and the important assertion is that exactly one
    // account and one credit exist.
    process.env.MANNA_ENV = 'sandbox';
    delete process.env.VERCEL_ENV;
    const POST = await importRoute();

    const results = await Promise.allSettled([
      POST(
        registerRequest({
          name: 'Concurrent A',
          email: 'concurrent@grant.test',
          password: 'SandboxPass!2026',
          country: 'CA',
        }),
      ),
      POST(
        registerRequest({
          name: 'Concurrent B',
          email: 'concurrent@grant.test',
          password: 'SandboxPass!2026',
          country: 'CA',
        }),
      ),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const [{ count }] = await db<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM users WHERE email = 'concurrent@grant.test'
    `;
    expect(count, 'exactly one account').toBe('1');

    const row = await walletAndLedger('concurrent@grant.test');
    expect(row.opening_entries, 'exactly one opening-balance entry').toBe('1');
    expect(row.ledger_cad).toBe('100.00');
    expect(row.balance_cad).toBe('100.00');
  });
});
