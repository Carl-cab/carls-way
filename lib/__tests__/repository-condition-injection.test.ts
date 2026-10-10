/**
 * SQL injection through BaseRepository's `exists` / `count` conditions.
 *
 * Both helpers took `condition: string` and interpolated it into `sql.unsafe`,
 * so the only way to call them was to assemble SQL by concatenation. Five
 * callers did, and three of them concatenated a request-shaped value:
 *
 *     this.exists('users', `email = '${email.toLowerCase()}'`)
 *
 * Measured against that code before the fix, on the same `sql.unsafe` path:
 *
 *     absent address        -> false
 *     crafted address       -> true        // input: x' OR '1'='1
 *     table still present   -> false       // a stacked statement dropped it
 *
 * So it was never a boolean oracle: `sql.unsafe` executes stacked statements,
 * which makes the same hole arbitrary SQL execution. No route called these
 * helpers, so nothing was exploitable in production — but `emailExists` and
 * `usernameExists` are exactly the helpers a registration handler reaches for,
 * and wiring one in would have made it remotely reachable.
 *
 * The fix is a type, not an escape: the helpers take a postgres.js fragment,
 * whose values travel as bound parameters, so the concatenated shape no longer
 * compiles. These tests pin the behaviour; `pnpm run typecheck` pins the shape.
 * The fifth caller (AdminRepository.adminEmailExists) was found only because
 * the signature changed — grep for callers had missed it.
 */
import { getSql, initializeSchema } from '@/lib/db';
import { UserRepository } from '@/lib/repositories/UserRepository';

const sql = getSql();
const EMAIL = 'injection_probe@example.test';
const USERNAME = 'injection_probe';

let repo: UserRepository;

beforeAll(async () => {
  await initializeSchema();
  repo = new UserRepository();
  await sql`DELETE FROM users WHERE email = ${EMAIL}`;
  await sql`
    INSERT INTO users (name, username, email, password_hash, country)
    VALUES ('Injection Probe', ${USERNAME}, ${EMAIL}, 'x', 'CA')
  `;
}, 60000);

afterAll(async () => {
  await sql`DELETE FROM users WHERE email = ${EMAIL}`;
}, 60000);

describe('emailExists', () => {
  it('still answers truthfully for a real and an absent address', async () => {
    // Guard the fix against the trivial regression of always returning false.
    await expect(repo.emailExists(EMAIL)).resolves.toBe(true);
    await expect(repo.emailExists('nobody-at-all@example.test')).resolves.toBe(false);
  });

  it('treats a tautology payload as an ordinary address, not as SQL', async () => {
    // Returned true before the fix. The payload is now a value compared with
    // `=`, and no row holds it.
    await expect(repo.emailExists("x' OR '1'='1")).resolves.toBe(false);
    await expect(repo.emailExists("' OR 1=1 --")).resolves.toBe(false);
  });

  it('does not execute a stacked statement', async () => {
    // The payload that dropped a table before the fix. `users` must survive,
    // and the call must answer rather than error: the string is just data now.
    await expect(repo.emailExists("x'; DROP TABLE users; --")).resolves.toBe(false);

    const [present] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.users') IS NOT NULL AS exists
    `;
    expect(present.exists).toBe(true);
  });

  it('does not let a payload delete rows', async () => {
    await expect(repo.emailExists("x'; DELETE FROM users WHERE 1=1; --")).resolves.toBe(false);

    const rows = await sql`SELECT 1 FROM users WHERE email = ${EMAIL}`;
    expect(rows).toHaveLength(1);
  });

  it('is unharmed by a quote in a legitimate address', async () => {
    // An apostrophe is legal in a local part. Before the fix it broke the
    // query; it must now be an ordinary character, neither an error nor a
    // match.
    await expect(repo.emailExists("o'brien@example.test")).resolves.toBe(false);
  });
});

describe('usernameExists', () => {
  it('answers truthfully', async () => {
    await expect(repo.usernameExists(USERNAME)).resolves.toBe(true);
    await expect(repo.usernameExists('nobody_at_all')).resolves.toBe(false);
  });

  it('treats a tautology payload as an ordinary username', async () => {
    await expect(repo.usernameExists("x' OR '1'='1")).resolves.toBe(false);
  });
});
