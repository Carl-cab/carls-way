/**
 * Security properties of `POST /api/migrate`, the only mechanism by which the
 * production schema changes.
 *
 * This file exists to make the route's security posture *measured* rather than
 * argued, because the decision about where migrations should live depends on
 * which of these are real. Each case either pins an existing control so it
 * cannot silently regress, or records a present weakness so a later fix has
 * something to flip.
 *
 * Phase 1 of decision 0005 fixed five of the six weaknesses this file
 * originally pinned, and the assertions were inverted in that same change —
 * which was the stated point of writing them as assertions rather than prose.
 * What remains documented as present is the one Phase 1 does not address:
 * the route still requires table ownership, which is what blocks audit
 * immutability and needs the credential split (Phases 2-5).
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
  return new NextRequest('https://example.test/api/migrate', {
    method: 'POST',
    headers,
  });
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
  it('exposes the DDL operation on POST, not GET', async () => {
    const mod = await import('@/app/api/migrate/route');

    expect(typeof mod.POST).toBe('function');
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      expect((mod as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('answers GET with 405 and a pointer, not silence', async () => {
    // The old runbook said GET. An operator following it mid-incident should
    // be told what changed rather than left with an empty 405 or a 404.
    const { GET } = await import('@/app/api/migrate/route');
    const res = await GET();

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json();
    expect(body.error).toMatch(/requires POST/i);
    expect(body.hint).toMatch(/curl -X POST/);
  });

  it('the admin session cookie is still SameSite=Lax, which POST-only is what fixes', async () => {
    // Lax is left as-is deliberately: it is correct for a login cookie, and it
    // only became a CSRF path because the operation was on GET. Pinned so that
    // a future change back to GET has to confront this.
    const source = readFileSync(ADMIN_AUTH, 'utf8');
    expect(source).toMatch(/sameSite:\s*'lax'/);
  });
});

// ─── CSRF: Origin validation ────────────────────────────────────────────────

describe('origin validation', () => {
  it('refuses a browser request from another origin, before touching auth', async () => {
    // Set up a credential that WOULD succeed, to prove the origin check runs
    // first and the pipeline never starts.
    currentUser = null;
    currentAdmin = admin('SuperAdmin');
    __resetInMemoryCounters();

    const { POST } = await import('@/app/api/migrate/route');
    const res = await POST(request({ origin: 'https://attacker.example' }));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/origin not allowed/i);
  });

  it('refuses an opaque origin', async () => {
    currentUser = null;
    currentAdmin = admin('SuperAdmin');
    const { POST } = await import('@/app/api/migrate/route');
    expect((await POST(request({ origin: 'null' }))).status).toBe(403);
  });

  it('refuses a malformed origin', async () => {
    currentUser = null;
    currentAdmin = admin('SuperAdmin');
    const { POST } = await import('@/app/api/migrate/route');
    expect((await POST(request({ origin: 'not-a-url' }))).status).toBe(403);
  });

  it('ALLOWS an absent origin, which is what keeps the recovery path usable', async () => {
    // This is the deliberate shape of the control, not a gap. A browser always
    // sends Origin on POST, so a request without one did not come from a
    // browser and cannot be the cross-site forgery this guards against. What
    // it usually is, is curl from an operator's terminal — and requiring the
    // header would disable the anonymous auth-repair break-glass that exists
    // because production was once locked out.
    currentUser = null;
    currentAdmin = admin('SuperAdmin');
    __resetInMemoryCounters();

    const { POST } = await import('@/app/api/migrate/route');
    const res = await POST(request());

    expect(res.status).toBe(200);
  }, 180000);

  it('the route checks origin before authentication', () => {
    // Structural, because ordering is the property: a forged request must not
    // reach a credential lookup or the database.
    const originAt = routeSource.indexOf('checkOrigin(req)');
    const authAt = routeSource.indexOf('await getAuthUser()');
    expect(originAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(-1);
    expect(originAt).toBeLessThan(authAt);
  });
});

// ─── Authorization: the controls that DO hold ────────────────────────────────

describe('authorization', () => {
  it('refuses an unauthenticated caller once the database is populated', async () => {
    currentAdmin = null;
    currentUser = null;
    __resetInMemoryCounters();

    const { POST } = await import('@/app/api/migrate/route');
    const res = await POST(request());

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

    const { POST } = await import('@/app/api/migrate/route');
    const res = await POST(request());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/operations administrator/i);
  });

  it('refuses an administrator whose role cannot run operations', async () => {
    currentUser = null;
    currentAdmin = admin('SupportAgent');

    const { POST } = await import('@/app/api/migrate/route');
    const res = await POST(request());

    expect(res.status).toBe(403);
  });

  it('a read-only administrator role is refused even with a customer JWT present', async () => {
    // Belt and braces: holding both credentials must not combine into
    // operator authority.
    currentUser = { userId: 4242 };
    currentAdmin = admin('ComplianceOfficer');

    const { POST } = await import('@/app/api/migrate/route');
    expect((await POST(request())).status).toBe(403);
  });
});

// ─── Rate limiting: present on one path, absent on the other ────────────────

describe('rate limiting', () => {
  it('rate limits the authenticated operator path', async () => {
    currentUser = null;
    currentAdmin = admin('SuperAdmin');
    __resetInMemoryCounters();

    const { POST } = await import('@/app/api/migrate/route');

    // 6/hour keyed on the admin id. The 7th must be refused — previously the
    // operator path called checkRateLimit nowhere and ran unbounded.
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await POST(request())).status);
    }

    expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(statuses[6]).toBe(429);
  }, 300000);

  it('the 429 says plainly that no schema change was made', async () => {
    currentUser = null;
    currentAdmin = admin('SuperAdmin');
    __resetInMemoryCounters();

    const { POST } = await import('@/app/api/migrate/route');
    let res = await POST(request());
    for (let i = 0; i < 6 && res.status === 200; i++) res = await POST(request());

    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/no schema change was made/i);
  }, 300000);

  it('the rate limiter is invoked on both paths now', () => {
    // Was exactly 1 — the anonymous branch only. Pinned at 2 so removing
    // either limiter changes this count.
    const calls = routeSource.match(/checkRateLimit\(/g) ?? [];
    expect(calls).toHaveLength(2);
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

  it('redacts the 500 response and keeps the detail in the log', () => {
    // `String(err)` on a postgres.js error carries the server message and can
    // name tables, columns and constraints — and on a fresh deployment the
    // caller may be anonymous. The response now carries a reference instead,
    // and the full error is logged against it, so this is a redaction rather
    // than a loss of diagnostics.
    expect(routeSource).not.toMatch(/error:\s*String\(err\)/);
    expect(routeSource).toMatch(/Schema migration failed\. The error has been logged\./);
    expect(routeSource).toMatch(/reference:\s*ref/);
    expect(routeSource).toMatch(/console\.error\(`Migration error \[ref=/);
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
