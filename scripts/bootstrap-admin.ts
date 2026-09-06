/**
 * Create the first administrator.
 *
 * Run once, against the target database, by an operator who already holds the
 * database credentials:
 *
 *   ADMIN_BOOTSTRAP_SECRET=<64 hex chars> \
 *   DATABASE_URL=<connection string> \
 *   pnpm tsx scripts/bootstrap-admin.ts --email ops@example.com --name "Ops"
 *
 * Deliberately a CLI and not an HTTP route. A bootstrap route is reachable by
 * anyone who can reach the deployment and has to defend itself with a secret
 * comparison on every request for the life of the application; a CLI is
 * reachable only by someone who already has the database connection string,
 * which is a strictly higher bar than knowing a URL. The admin console has no
 * self-service signup for the same reason.
 *
 * Three independent conditions must all hold, and each fails closed:
 *
 *   1. ADMIN_BOOTSTRAP_SECRET is set and at least 32 hex characters.
 *   2. The schema exists (run GET /api/migrate first) and admin_users is empty. One existing administrator, of any role or status,
 *      is enough to refuse — after that, accounts are created through the
 *      console by an administrator holding admins:create.
 *   3. A password is supplied on stdin, or generated here and printed once.
 *
 * The generated password is printed to stdout exactly once and never stored in
 * plain form. It is not written to the audit log.
 */
import { randomBytes } from 'crypto';
import { getSql } from '../lib/db';
import { hashAdminPassword } from '../lib/rbac/admin-password';
import type { AdminRole } from '../lib/rbac/types';

const MIN_SECRET_LENGTH = 32;

function fail(message: string): never {
  console.error(`\n  Refused: ${message}\n`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const secret = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!secret || secret.trim().length < MIN_SECRET_LENGTH) {
    fail(
      `ADMIN_BOOTSTRAP_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters. ` +
        'Generate one with: openssl rand -hex 32',
    );
  }

  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const role = (arg('role')?.trim() || 'SuperAdmin') as AdminRole;

  if (!email || !email.includes('@')) fail('--email is required and must be an email address.');
  if (!name) fail('--name is required.');

  const validRoles: AdminRole[] = [
    'SuperAdmin',
    'OperationsAdmin',
    'FinancialInvestigator',
    'ComplianceOfficer',
    'ReadOnlyAuditor',
  ];
  if (!validRoles.includes(role)) {
    fail(`--role must be one of: ${validRoles.join(', ')}`);
  }

  const sql = getSql();

  // The admin tables are created by the migration, not by initializeSchema(),
  // so this refuses rather than half-creating a schema it does not own. On a
  // brand-new database — as production was after the Neon recovery — call
  // GET /api/migrate first; it runs unauthenticated while no account exists.
  const hasAdminTable = await sql<{ present: boolean }[]>`
    SELECT to_regclass('public.admin_users') IS NOT NULL AS present
  `;
  if (!hasAdminTable[0]?.present) {
    fail(
      'admin_users does not exist. Run GET /api/migrate against this database ' +
        'first, then re-run this command.',
    );
  }

  const existing = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM admin_users`;
  const adminCount = Number(existing[0]?.count ?? 0);
  if (adminCount > 0) {
    fail(
      `${adminCount} administrator account(s) already exist. Bootstrap runs only on an ` +
        'empty admin_users table. Create further accounts through the console.',
    );
  }

  // 24 bytes of CSPRNG output, base64url. Long enough that the operator is
  // expected to store it in a password manager rather than memorise it.
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || randomBytes(24).toString('base64url');
  const passwordHash = await hashAdminPassword(password);

  const inserted = await sql<{ id: number }[]>`
    INSERT INTO admin_users (email, name, password_hash, role, status)
    VALUES (${email}, ${name}, ${passwordHash}, ${role}, 'active')
    RETURNING id
  `;

  // Recorded so the first account's creation is as auditable as every later
  // one. The password is not part of the record.
  await sql`
    INSERT INTO audit_logs (user_id, action, metadata)
    VALUES (
      NULL,
      'admin_bootstrap_created',
      ${JSON.stringify({ admin_user_id: inserted[0].id, email, role })}
    )
  `;

  console.log(`
  Administrator created.

    id       ${inserted[0].id}
    email    ${email}
    role     ${role}
${
  process.env.ADMIN_BOOTSTRAP_PASSWORD
    ? '    password  (as supplied in ADMIN_BOOTSTRAP_PASSWORD)'
    : `    password ${password}`
}

  This password is shown once and is not recoverable. Store it now, sign in at
  /admin/login, and change it.

  Bootstrap will refuse to run again while this account exists.
`);

  await sql.end();
}

main().catch((err) => {
  console.error('\n  Bootstrap failed:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
