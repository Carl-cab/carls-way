/**
 * Admin authorization boundary regression tests.
 *
 * Proves the boundary is structural rather than incidental:
 *   - anonymous callers are denied,
 *   - authenticated-but-not-admin callers are denied,
 *   - an authorized admin is allowed,
 *   - the API cannot be reached by bypassing the UI,
 *   - the page guard and API guard cannot drift apart.
 *
 * The permission layer is exercised directly against the real
 * AsyncLocalStorage-backed context. The route surface is verified structurally,
 * because asserting "every admin route is guarded" is a property of the whole
 * directory, not of any single handler, and must keep holding as routes are
 * added.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  adminContextStorage,
  checkPermission,
  requirePermission,
  getAdminContext,
  getCurrentPermissions,
} from '../rbac/admin-middleware';
import { ROLE_PERMISSIONS } from '../rbac/types';
import type { AdminContext, AdminUser, AdminRole, Permission } from '../rbac/types';

const REPO_ROOT = join(__dirname, '..', '..');
const ADMIN_API_DIR = join(REPO_ROOT, 'app/api/admin');

function makeAdmin(role: AdminRole): AdminUser {
  return {
    id: 1,
    email: 'ops@example.test',
    name: 'Ops Admin',
    password_hash: 'unused-in-test',
    role,
    status: 'active',
    failed_login_attempts: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeContext(role: AdminRole): AdminContext {
  return {
    adminUser: makeAdmin(role),
    sessionId: 'test-session',
    permissions: ROLE_PERMISSIONS[role] ?? [],
    sourceIp: '127.0.0.1',
    userAgent: 'vitest',
  };
}

/** Run `fn` as if the request carried an authenticated admin of `role`. */
function asAdmin<T>(role: AdminRole, fn: () => T): T {
  return adminContextStorage.run(makeContext(role), fn);
}

/** Recursively collect every route.ts under app/api/admin. */
function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectRouteFiles(full));
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('Admin authorization boundary', () => {
  describe('anonymous callers (no admin context)', () => {
    it('has no admin context', () => {
      expect(getAdminContext()).toBeUndefined();
    });

    it('holds no permissions', () => {
      expect(getCurrentPermissions()).toEqual([]);
    });

    it('is denied every permission (default deny)', () => {
      const everyPermission = Object.values(ROLE_PERMISSIONS).flat() as Permission[];
      for (const permission of new Set(everyPermission)) {
        expect(checkPermission(permission)).toBe(false);
      }
    });

    it('is rejected when a route requires a permission', () => {
      expect(() => requirePermission('ledger:view')).toThrow();
      expect(() => requirePermission('exceptions:manage')).toThrow();
    });
  });

  describe('authenticated but under-privileged admin', () => {
    it('ReadOnlyAuditor cannot perform the privileged ledger mutation', () => {
      asAdmin('ReadOnlyAuditor', () => {
        expect(checkPermission('exceptions:manage')).toBe(false);
        expect(() => requirePermission('exceptions:manage')).toThrow();
      });
    });

    it('ComplianceOfficer cannot perform the privileged ledger mutation', () => {
      asAdmin('ComplianceOfficer', () => {
        expect(checkPermission('exceptions:manage')).toBe(false);
      });
    });

    it('FinancialInvestigator cannot perform the privileged ledger mutation', () => {
      asAdmin('FinancialInvestigator', () => {
        expect(checkPermission('exceptions:manage')).toBe(false);
      });
    });

    it('a role never receives permissions outside its grant', () => {
      for (const role of Object.keys(ROLE_PERMISSIONS) as AdminRole[]) {
        asAdmin(role, () => {
          const granted = new Set(ROLE_PERMISSIONS[role]);
          const everyPermission = new Set(
            Object.values(ROLE_PERMISSIONS).flat() as Permission[],
          );
          for (const permission of everyPermission) {
            expect(checkPermission(permission)).toBe(granted.has(permission));
          }
        });
      }
    });
  });

  describe('authorized admin', () => {
    it('SuperAdmin may perform the privileged ledger mutation', () => {
      asAdmin('SuperAdmin', () => {
        expect(checkPermission('exceptions:manage')).toBe(true);
        expect(() => requirePermission('exceptions:manage')).not.toThrow();
      });
    });

    it('OperationsAdmin may perform the privileged ledger mutation', () => {
      asAdmin('OperationsAdmin', () => {
        expect(() => requirePermission('exceptions:manage')).not.toThrow();
      });
    });

    it('authorization does not leak outside the request scope', () => {
      asAdmin('SuperAdmin', () => {
        expect(checkPermission('exceptions:manage')).toBe(true);
      });
      // Back outside the context: default deny must apply again.
      expect(checkPermission('exceptions:manage')).toBe(false);
      expect(getAdminContext()).toBeUndefined();
    });
  });

  describe('API surface cannot be bypassed', () => {
    // The authentication endpoints are the one exemption, and it is enumerated
    // rather than pattern-matched so that adding a route under auth/ does not
    // silently inherit it. An endpoint that issues a session cannot itself
    // require one; each is asserted separately below for what it does instead.
    const PRE_AUTH_ROUTES = [
      'auth/login/route.ts',
      'auth/logout/route.ts',
      'auth/session/route.ts',
    ];

    const allRouteFiles = collectRouteFiles(ADMIN_API_DIR);
    const routeFiles = allRouteFiles.filter(
      (f) => !PRE_AUTH_ROUTES.some((p) => f.endsWith(p)),
    );

    it('finds the admin API routes', () => {
      expect(routeFiles.length).toBeGreaterThan(0);
    });

    it('exempts only the three authentication endpoints', () => {
      const exempt = allRouteFiles
        .filter((f) => PRE_AUTH_ROUTES.some((p) => f.endsWith(p)))
        .map((f) => f.replace(`${REPO_ROOT}/app/api/admin/`, ''));
      expect(exempt.sort()).toEqual([...PRE_AUTH_ROUTES].sort());
    });

    it.each(routeFiles.map((f) => [f.replace(`${REPO_ROOT}/`, ''), f]))(
      '%s enforces admin authentication in-route',
      (_label, file) => {
        const source = readFileSync(file, 'utf8');
        // Every exported HTTP handler must route through withAdminAuth. This is
        // what makes a direct API request (bypassing the UI) fail.
        expect(source).toContain('withAdminAuth');
      },
    );

    it.each(routeFiles.map((f) => [f.replace(`${REPO_ROOT}/`, ''), f]))(
      '%s exports no unguarded HTTP handler',
      (_label, file) => {
        const source = readFileSync(file, 'utf8');
        // A bare `export async function GET/POST/...` bypasses the wrapper.
        // Handlers must be exported as wrapped consts instead.
        expect(source).not.toMatch(
          /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/,
        );
      },
    );

    it('login is throttled and does not disclose whether an account exists', () => {
      const source = readFileSync(join(ADMIN_API_DIR, 'auth/login/route.ts'), 'utf8');
      // Rate limited before any database or bcrypt work.
      expect(source).toContain('checkRateLimit');
      // One message for every rejection: unknown address, wrong password,
      // locked, and inactive must be indistinguishable to the caller.
      expect(source).toContain('GENERIC_FAILURE');
      // Check the responses themselves rather than the prose: every rejection
      // body must be the one shared constant, or the throttle/500 messages.
      // Matching on comment text instead would flag the explanation of why
      // this rule exists.
      const errorBodies = [...source.matchAll(/\{\s*error:\s*([^}]+?)\s*\}/g)].map(
        (m) => m[1].trim(),
      );
      expect(errorBodies.length).toBeGreaterThan(0);
      for (const body of errorBodies) {
        expect([
          'GENERIC_FAILURE',
          "'Too many attempts. Please try again later.'",
          "'Internal server error'",
        ]).toContain(body);
      }
      // Verification runs even with no account, so timing does not answer it.
      expect(source).toContain('verifyAdminPassword');
      // A locked or deactivated administrator cannot obtain a session.
      expect(source).toContain('locked_until');
      expect(source).toContain("status !== 'active'");
    });

    it('logout destroys the server-side session, not just the cookie', () => {
      const source = readFileSync(join(ADMIN_API_DIR, 'auth/logout/route.ts'), 'utf8');
      // Clearing the cookie alone would leave a working credential behind for
      // anyone who had copied it.
      expect(source).toContain('deleteSession');
    });

    it('the session endpoint resolves through the shared server guard', () => {
      const source = readFileSync(join(ADMIN_API_DIR, 'auth/session/route.ts'), 'utf8');
      expect(source).toContain('getServerAdmin');
      expect(source).toContain('401');
    });

    it('the privileged ledger mutation additionally requires a permission', () => {
      const source = readFileSync(
        join(ADMIN_API_DIR, 'ledger/backfill-opening-balances/route.ts'),
        'utf8',
      );
      expect(source).toContain('withAdminAuth');
      expect(source).toContain("requirePermission('exceptions:manage')");
      // Authentication alone must not be sufficient for a ledger write.
      expect(source).not.toContain('getAuthUser');
    });
  });

  describe('admin pages are guarded server-side', () => {
    // The console lives in the (console) route group so that the sign-in page
    // can sit at /admin/login without this guard above it — a layout that
    // notFound()s every anonymous caller would otherwise make login
    // unreachable for the people who need it.
    const layout = readFileSync(
      join(REPO_ROOT, 'app/admin/(console)/layout.tsx'),
      'utf8',
    );

    it('resolves the admin on the server before rendering the console', () => {
      expect(layout).toContain('getServerAdmin');
      expect(layout).toContain('notFound');
    });

    it('is a server component (no client directive)', () => {
      // A 'use client' layout could not perform a server-side authorization check.
      expect(layout).not.toContain("'use client'");
    });

    it('keeps every console page inside the guarded route group', () => {
      // A page added directly under app/admin/ would render with no server-side
      // authorization above it. Only the sign-in page is allowed to live there.
      const entries = readdirSync(join(REPO_ROOT, 'app/admin'), { withFileTypes: true });
      const outsideGroup = entries
        .filter((e) => e.name !== '(console)' && e.name !== 'login')
        .map((e) => e.name);
      expect(outsideGroup).toEqual([]);
    });

    it('shares one session resolver with the API guard, preventing drift', () => {
      const server = readFileSync(join(REPO_ROOT, 'lib/rbac/admin-server.ts'), 'utf8');
      const middleware = readFileSync(
        join(REPO_ROOT, 'lib/rbac/admin-middleware.ts'),
        'utf8',
      );
      expect(server).toContain('resolveAdminBySessionId');
      expect(middleware).toContain('resolveAdminBySessionId');
    });
  });

  describe('edge middleware', () => {
    const proxySource = readFileSync(join(REPO_ROOT, 'proxy.ts'), 'utf8');

    it('gates /admin on the admin credential, not the customer token', () => {
      expect(proxySource).toContain("'/admin'");
      expect(proxySource).toContain("cookies.get('admin_session')");
    });

    it('does not treat a customer token as admin authorization', () => {
      // Scope to the admin decision branch itself: from the /admin conditional
      // up to where ordinary customer-path handling resumes.
      const branchStart = proxySource.indexOf('if (pathname === ADMIN_PATH');
      const branchEnd = proxySource.indexOf('const isPublicPath');
      expect(branchStart).toBeGreaterThan(-1);
      expect(branchEnd).toBeGreaterThan(branchStart);

      const adminBranch = proxySource.slice(branchStart, branchEnd);
      expect(adminBranch).toContain('admin_session');
      expect(adminBranch).not.toContain('manna-token');
      expect(adminBranch).not.toContain('verifyToken');
    });

    it('leaves API routes to their own in-route authorization', () => {
      // Webhooks authorize by provider signature; admin APIs by session +
      // permission. Blanket user auth here would break webhook delivery.
      expect(proxySource).toContain('(?!api|');
    });
  });
});
