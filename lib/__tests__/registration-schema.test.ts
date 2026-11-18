/**
 * `POST /api/auth/register` against a real database.
 *
 * WHY THIS FILE EXISTS. The suite stood at 68 files / 977 passing tests while
 * registration was broken on any database built from
 * `lib/__tests__/helpers/test-schema.sql`. Booting the application against
 * such a database and registering a user answered
 *
 *     500 {"error":"Internal server error"}
 *     column "province" of relation "users" does not exist   (42703)
 *
 * No test caught it because no test exercised the route. That is the whole
 * lesson: registration is the first step of every user workflow, so a test
 * count says nothing about whether anyone can sign up.
 *
 * WHY THE THREE EXISTING SCHEMA GUARDS COULD NOT CATCH IT, each for its own
 * reason — which is why this file checks the route rather than the schema:
 *
 *   - `schema-source-parity.test.ts` compares the objects the migrate route
 *     guarantees against a database built by `initializeSchema()`. It runs one
 *     direction only, deliberately. `province` was in `initializeSchema()` and
 *     NOT in the migrate route, so it is invisible from that direction.
 *   - `migrate-route-execution.test.ts` executes the migrate route's
 *     statements. There was no `province` statement to execute.
 *   - `verify-migrate.sql` is driven from a list of columns someone thought to
 *     add. `province` was not on it.
 *
 * All three were working as designed. The gap was that nothing ran the reader.
 *
 * Real PostgreSQL, and the real route handler with the real database layer.
 * A mocked `sql` would have reported this schema correct under any
 * implementation, which is exactly how the defect survived.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSql } from '../db';

const EMAILS = [
  'regtest-ca@example.test',
  'regtest-us@example.test',
  'regtest-dup@example.test',
];

/** The columns `POST /api/auth/register` INSERTs into, in the route's order. */
const REGISTER_INSERT_COLUMNS = [
  'name',
  'username',
  'email',
  'phone',
  'password_hash',
  'province',
  'country',
  'avatar_color',
  'balance_cad',
  'balance_usd',
  'kyc_status',
] as const;

async function cleanup() {
  const sql = getSql();
  const rows = await sql<{ id: number }[]>`
    SELECT id FROM users WHERE email = ANY(${EMAILS as unknown as string[]})
  `;
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  // Scoped to this file's own rows. `provider-event-duplicates.test.ts`
  // learned the other way: a TRUNCATE on a shared table destroyed other
  // files' rows while leaving its own behind.
  await sql`DELETE FROM audit_logs WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM users WHERE id = ANY(${ids})`;
}

beforeAll(cleanup);
afterAll(cleanup);

describe('users schema supports the registration route', () => {
  it('every column the register INSERT names exists on users', async () => {
    const sql = getSql();
    const present = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    const names = new Set(present.map((r) => r.column_name));
    const missing = REGISTER_INSERT_COLUMNS.filter((c) => !names.has(c));

    // Named individually rather than as a set difference, so a failure says
    // which column and therefore which schema source to correct.
    expect(
      missing,
      `users is missing ${missing.length} column(s) the registration INSERT ` +
        `names: ${missing.join(', ')}. Add each to ALL THREE sources — ` +
        `lib/db.ts initializeSchema(), app/api/migrate/route.ts, and ` +
        `lib/__tests__/helpers/test-schema.sql — per CLAUDE.md.`,
    ).toEqual([]);
  });

  it('province specifically is present, since only initializeSchema declared it', async () => {
    const sql = getSql();
    const [row] = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
        AND column_name = 'province'
    `;
    expect(row?.data_type).toBe('text');
  });
});

describe('POST /api/auth/register', () => {
  it('creates a CA user with a CA$100 seed balance and pending KYC', async () => {
    const { POST } = await import('../../app/api/auth/register/route');
    const req = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Reg Test CA',
        email: 'regtest-ca@example.test',
        password: 'SandboxPass!2026',
        country: 'CA',
        province: 'ON',
      }),
    });

    const res = await POST(req as never);
    const body = (await res.json()) as { success?: boolean; username?: string; error?: string };

    // Assert on the body before the status: when this fails because a column
    // is missing the route answers a generic 500, and the error text is the
    // only thing that says why.
    expect(body.error, `register returned an error: ${body.error}`).toBeUndefined();
    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.username).toMatch(/^regtestca\d{4}$/);

    const sql = getSql();
    const [user] = await sql<
      {
        country: string;
        province: string | null;
        balance_cad: string;
        balance_usd: string;
        kyc_status: string;
      }[]
    >`
      SELECT country, province, balance_cad, balance_usd, kyc_status
      FROM users WHERE email = 'regtest-ca@example.test'
    `;
    expect(user.country).toBe('CA');
    expect(user.province).toBe('ON');
    // The seed balance is currency-selected by country, which is the rule
    // CLAUDE.md states for every currency decision.
    expect(user.balance_cad).toBe('100.00');
    expect(user.balance_usd).toBe('0.00');
    // A new account is NOT verified. Asserted because the velocity tier and
    // the transfer rail both branch on this.
    expect(user.kyc_status).toBe('pending');
  });

  it('seeds a US user in USD rather than CAD', async () => {
    const { POST } = await import('../../app/api/auth/register/route');
    const res = await POST(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Reg Test US',
          email: 'regtest-us@example.test',
          password: 'SandboxPass!2026',
          country: 'US',
        }),
      }) as never,
    );
    expect(res.status).toBe(201);

    const sql = getSql();
    const [user] = await sql<{ balance_cad: string; balance_usd: string }[]>`
      SELECT balance_cad, balance_usd FROM users WHERE email = 'regtest-us@example.test'
    `;
    expect(user.balance_usd).toBe('100.00');
    expect(user.balance_cad).toBe('0.00');
  });

  it('refuses a duplicate email with 409 and creates no second row', async () => {
    // The existing row is seeded with SQL rather than by a first POST, and
    // that is not tidiness — it is forced by a real limit worth recording.
    //
    // `auth:register` allows 3 per hour keyed on `clientIdentifier(req)`.
    // These requests carry no `x-vercel-forwarded-for`, `x-real-ip` or
    // `x-forwarded-for`, so the key collapses to a single bucket shared by
    // every caller — the "global 3/hour" cell CLAUDE.md's fail-open table
    // calls an availability cliff. Registering twice here made this file's
    // fourth POST answer 429 instead of 201, so the test failed on the limiter
    // rather than on the uniqueness check it was written to examine.
    //
    // Two consequences, one local and one not. Locally: a route test that
    // spends limiter budget on setup is testing two things and will fail for
    // the wrong reason. For the sandbox beta: several participants behind one
    // NAT share that bucket, so the fourth person to sign up inside an hour is
    // refused with a message about trying again later. Recorded in the sprint
    // report; not changed here, because the limit is a security control and
    // loosening it is the owner's call.
    const sql = getSql();
    await sql`
      INSERT INTO users (name, username, email, password_hash, country, kyc_status)
      VALUES ('Reg Test Dup', 'regtestdup0001', 'regtest-dup@example.test',
              'not-a-real-hash', 'CA', 'pending')
    `;

    const { POST } = await import('../../app/api/auth/register/route');
    const res = await POST(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Reg Test Dup',
          email: 'regtest-dup@example.test',
          password: 'SandboxPass!2026',
          country: 'CA',
        }),
      }) as never,
    );

    // 409, not 429: the duplicate-email check must be what refuses this. If
    // the limiter got there first the assertion below says so explicitly,
    // rather than leaving a confusing "expected 429 to be 409".
    expect(
      res.status,
      res.status === 429
        ? 'refused by the rate limiter, not the uniqueness check — this file ' +
          'has spent the global auth:register budget; see the comment above'
        : 'expected the duplicate-email branch',
    ).toBe(409);

    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM users WHERE email = 'regtest-dup@example.test'
    `;
    expect(count).toBe('1');
  });

  it('rejects a weak password with 400 before touching the database', async () => {
    const { POST } = await import('../../app/api/auth/register/route');
    const res = await POST(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Reg Test Weak',
          email: 'regtest-weak@example.test',
          password: 'short',
          country: 'CA',
        }),
      }) as never,
    );
    expect(res.status).toBe(400);

    const sql = getSql();
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM users WHERE email = 'regtest-weak@example.test'
    `;
    expect(count).toBe('0');
  });
});
