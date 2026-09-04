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
    const routeFiles = collectRouteFiles(ADMIN_API_DIR);

    it('finds the admin API routes', () => {
      expect(routeFiles.length).toBeGreaterThan(0);
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
    const layout = readFileSync(join(REPO_ROOT, 'app/admin/layout.tsx'), 'utf8');

    it('resolves the admin on the server before rendering the console', () => {
      expect(layout).toContain('getServerAdmin');
      expect(layout).toContain('notFound');
    });

    it('is a server component (no client directive)', () => {
      // A 'use client' layout could not perform a server-side authorization check.
      expect(layout).not.toContain("'use client'");
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
