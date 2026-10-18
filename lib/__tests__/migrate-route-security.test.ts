/**
 * Security properties of `GET /api/migrate`, the only mechanism by which the
 * production schema changes.
 *
 * This file exists to make the route's security posture *measured* rather than
 * argued, because the decision about where migrations should live depends on
 * which of these are real. Each case either pins an existing control so it
 * cannot silently regress, or records a present weakness so a later fix has
 * something to flip.
 *
 * Cases marked DOCUMENTS A WEAKNESS assert the current, undesirable behaviour
 * on purpose. They are not approval of it. When the behaviour is fixed these
 * assertions must be inverted in the same change — that is the point of
 * writing them down rather than describing them in prose.
 *
 * Nothing here touches production. The route runs against the test database,
 * and the one case that deliberately breaks a statement cleans up the object
 * it introduced.
 *
 * See docs/decisions/0005-migration-privilege-separation.md.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { getSql } from '@/lib/db';
import { __resetInMemoryCounters } from '@/lib/rate-limit';

const MIGRATE_ROUTE = path.join(process.cwd(), 'app/api/migrate/route.ts');
const ADMIN_AUTH = path.join(process.cwd(), 'lib/rbac/admin-auth.ts');

const OPERATOR_ID = 9902;

/** Swapped per-case so one file can exercise every authorization path. */
let currentAdmin: Record<string, unknown> | null = null;
let currentUser: { userId: number } | null = null;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getAuthUser: async () => currentUser };
});

vi.mock('@/lib/rbac/admin-middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rbac/admin-middleware')>();
  return { ...actual, resolveAdminBySessionId: async () => currentAdmin };
});

const sql = getSql();
const routeSource = readFileSync(MIGRATE_ROUTE, 'utf8');

function admin(role: string) {
  return {
    id: OPERATOR_ID,
    email: 'migrate-security@example.test',
    name: 'Migrate Security',
    role,
    status: 'active',
    failed_login_attempts: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function request(headers: Record<string, string> = {}) {
  return new NextRequest('https://example.test/api/migrate', { headers });
}

/**
 * Highest `audit_logs.id` before this file ran. Cleanup is scoped to rows above
 * it, so a concurrent or earlier file's audit evidence is never deleted — the
 * same watermark approach as migrate-route-execution.test.ts. Matching on
 * action plus a time window would reach another file's rows, which on an audit
 * table is destroying exactly the evidence the suite exists to check.
 */
let auditWatermark = 0;

beforeAll(async () => {
  currentAdmin = null;
  currentUser = null;
  const [row] = await sql<{ max: number | null }[]>`SELECT MAX(id) AS max FROM audit_logs`;
  auditWatermark = row?.max ?? 0;
});

afterAll(async () => {
  await sql`
    DELETE FROM audit_logs
    WHERE id > ${auditWatermark}
      AND action IN (
        'schema_migration_run', 'schema_migration_bootstrap', 'money_precision_upgraded'
      )
  `;
});

// ─── The HTTP surface ────────────────────────────────────────────────────────

describe('HTTP method surface', () => {
  it('DOCUMENTS A WEAKNESS: the DDL operation is exposed on GET, and only GET', async () => {
    const mod = await import('@/app/api/migrate/route');

    // GET is the whole API. A state-changing operation on a safe method is
    // reachable by top-level navigation, which is what makes the SameSite=Lax
    // cookie below insufficient.
    expect(typeof mod.GET).toBe('function');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((mod as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('DOCUMENTS A WEAKNESS: the admin session cookie is SameSite=Lax', async () => {
    // Lax is correct for a login cookie in general: it blocks cross-site POST,
    // fetch, iframe and image loads. It deliberately DOES send the cookie on a
    // top-level cross-site GET navigation — a link click or a redirect.
    //
    // Combined with the previous case that is a CSRF path: a logged-in
    // operations administrator who follows a link to this endpoint from any
    // other site runs the full pipeline, including the money-column type
    // conversion, against whatever database the deployment points at.
    //
    // Asserted against the source rather than a live response because the
    // attribute is what carries the risk, and it is set in one place.
    const source = readFileSync(ADMIN_AUTH, 'utf8');
    expect(source).toMatch(/sameSite:\s*'lax'/);
  });

  it('the route has no Origin, Referer or CSRF-token check', () => {
    expect(routeSource).not.toMatch(/\borigin\b/i);
    expect(routeSource).not.toMatch(/\breferer\b/i);
    expect(routeSource).not.toMatch(/csrf/i);
  });
});

// ─── Authorization: the controls that DO hold ────────────────────────────────

describe('authorization', () => {
  it('refuses an unauthenticated caller once the database is populated', async () => {
    currentAdmin = null;
    currentUser = null;
    __resetInMemoryCounters();

    const { GET } = await import('@/app/api/migrate/route');
    const res = await GET(request());

    // The test database has rows, so anonymousRecoveryMode() is at most
    // 'auth-repair' — never the full pipeline.
    const body = await res.json();
    if (res.status === 200) {
      expect(body.repair).toBe(true);
      expect(body.success).toBe(true);
      // The decisive property: the repair path reports columns, never a
      // completed migration.
      expect(body.message).not.toContain('Schema migration completed');
    } else {
      expect([401, 429]).toContain(res.status);
    }
  });

  it('refuses a customer JWT with 403', async () => {
    currentAdmin = null;
    currentUser = { userId: 4242 };

    const { GET } = await import('@/app/api/migrate/route');
    const res = await GET(request());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/operations administrator/i);
  });

  it('refuses an administrator whose role cannot run operations', async () => {
    currentUser = null;
    currentAdmin = admin('SupportAgent');

    const { GET } = await import('@/app/api/migrate/route');
    const res = await GET(request());

    expect(res.status).toBe(403);
  });

  it('a read-only administrator role is refused even with a customer JWT present', async () => {
    // Belt and braces: holding both credentials must not combine into
    // operator authority.
    currentUser = { userId: 4242 };
    currentAdmin = admin('ComplianceOfficer');

    const { GET } = await import('@/app/api/migrate/route');
    expect((await GET(request())).status).toBe(403);
  });
});

// ─── Rate limiting: present on one path, absent on the other ────────────────

describe('rate limiting', () => {
  it('DOCUMENTS A WEAKNESS: the authenticated operator path is not rate limited', async () => {
    currentUser = null;
    currentAdmin = admin('SuperAdmin');
    __resetInMemoryCounters();

    const { GET } = await import('@/app/api/migrate/route');

    // The anonymous branch is capped at 3/hour. The operator branch calls
    // checkRateLimit nowhere, so an operator (or anything that can make an
    // operator's browser issue a GET) can run the pipeline without limit.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await GET(request())).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(statuses).not.toContain(429);
  }, 180000);

  it('the rate limiter is invoked on exactly one path in the route', () => {
    // Structural, and deliberately so: it pins the asymmetry the case above
    // demonstrates, so adding a limiter to the operator path changes this
    // count and forces both to be updated together.
    const calls = routeSource.match(/checkRateLimit\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});

// ─── Failure atomicity ──────────────────────────────────────────────────────

describe('failure behaviour', () => {
  it('runs no statement inside a transaction', () => {
    expect(routeSource).not.toMatch(/sql\.begin/);
  });

  it('DOCUMENTS A WEAKNESS: a failure leaves earlier DDL committed', async () => {
    // Run against a disposable database, not the shared one. Demonstrating
    // partial migration requires a run that fails part-way, which means
    // leaving a schema inconsistent — not something to do to a database other
    // test files depend on.
    //
    // This exercises the real `initializeSchema()`, which is the route's first
    // step, then fails a statement of exactly the kind the route issues
    // afterwards. Combined with the structural case above (the route opens no
    // transaction anywhere), it establishes that a mid-pipeline failure leaves
    // the schema in a state that is neither the old one nor the new one.
    //
    // What this does NOT do is run the whole 103-statement route to a failure
    // against a populated production-shaped database; that needs a
    // representative copy, which this environment does not have. Recorded as
    // not-run rather than implied.
    const { initializeSchema, resolveSslMode } = await import('@/lib/db');
    const postgres = (await import('postgres')).default;

    const base = new URL(process.env.DATABASE_URL!);
    const adminUrl = new URL(base.toString());
    adminUrl.pathname = '/postgres';
    // Unique per invocation, and never dropped unless this run created it.
    // A fixed name would let two invocations sharing DATABASE_URL destroy each
    // other's scratch database, and would delete a developer database that
    // happened to carry the same name.
    const scratchName = `manna_migrate_atomicity_${randomUUID().replaceAll('-', '')}`;
    const scratchUrl = new URL(base.toString());
    scratchUrl.pathname = `/${scratchName}`;

    const connect = (u: string) =>
      postgres(u, { ssl: resolveSslMode(u), max: 1, onnotice: () => {} });

    const adminConn = connect(adminUrl.toString());
    let scratch: ReturnType<typeof postgres> | null = null;
    let created = false;
    try {
      await adminConn.unsafe(`CREATE DATABASE ${scratchName}`);
      created = true;
      scratch = connect(scratchUrl.toString());

      await initializeSchema(scratch);

      // A statement in the same additive style as the route's, made to fail:
      // the referenced table does not exist.
      let failed = false;
      try {
        await scratch`ALTER TABLE users ADD COLUMN IF NOT EXISTS probe_col INTEGER REFERENCES nonexistent_table(id)`;
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      // The failure rolled back nothing that came before it: every table
      // initializeSchema created is still there, committed.
      const rows = await scratch`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('users', 'ledger_entries', 'audit_logs')
      `;
      expect(rows.map((r) => r.table_name).sort()).toEqual([
        'audit_logs',
        'ledger_entries',
        'users',
      ]);

      // And the failed statement itself added nothing — so the schema sits
      // between the two versions rather than at either.
      const probe = await scratch`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'probe_col'
      `;
      expect(probe).toHaveLength(0);
    } finally {
      if (scratch) await scratch.end();
      if (created) await adminConn.unsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
      await adminConn.end();
    }
  }, 180000);

  it('DOCUMENTS A WEAKNESS: the 500 response returns the raw error string', () => {
    // `String(err)` on a postgres.js error carries the server message, and can
    // name objects and constraints. It is returned to whoever called the
    // endpoint — including, on a fresh deployment, an anonymous caller.
    expect(routeSource).toMatch(/NextResponse\.json\(\{\s*error:\s*String\(err\)\s*\}/);
  });
});

// ─── Privilege requirement ──────────────────────────────────────────────────

describe('privileges the route requires', () => {
  it('needs table ownership, not merely DML, which is what couples it to audit immutability', async () => {
    // `ALTER TABLE` and `CREATE INDEX` are owner-only. So the credential this
    // route uses must own the tables — and it is the same credential the
    // application uses for every query, because both come from DATABASE_URL.
    //
    // That is the coupling: giving the application a non-owning role (the only
    // way to make audit rows immutable against the application's own
    // credential) stops this route working. Measured as a fact about the
    // statements, so the dependency is not a matter of opinion.
    const ddl = routeSource.match(/ALTER TABLE|CREATE INDEX|CREATE TABLE/g) ?? [];
    expect(ddl.length).toBeGreaterThan(50);

    // And the route takes its connection from the same singleton the app uses.
    expect(routeSource).toMatch(/getSql\(\)/);
  });
});
