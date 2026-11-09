/**
 * Every money path admits through `admitVelocity()`.
 *
 * The TOCTOU this repo just closed was not a bug in one function — it was a
 * *shape*: `checkVelocityLimit()` here, money there, `recordVelocity()`
 * afterwards. Four paths had it because each was written by copying the last.
 * Fixing the four and leaving the unsafe pair exported means the fifth path,
 * written the same way, reintroduces it — and reintroduces it *silently*,
 * because the result is a working feature whose only defect appears under
 * concurrency.
 *
 * So this is a static guard, in the manner of `workflow-action-pinning.test.ts`:
 * nothing in typecheck, lint or the suite reads a money path for the velocity
 * shape, and a reviewer reading one route diff cannot see that the pair is
 * forbidden. It greps instead of reasoning, deliberately — a grep cannot be
 * satisfied by a plausible-looking call that does the wrong thing.
 *
 * `checkVelocityLimit()` has exactly one permitted caller, listed below: the
 * transfer intent route, where it is a non-binding preview on a draft that
 * moves no money and grants no claim.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The one place a read-only velocity preview is legitimate. Adding to this
 * list is a decision about money controls: a preview is only safe where
 * nothing is granted on the strength of its answer.
 */
const PREVIEW_ALLOWED = ['app/api/transfers/intent/route.ts'];

function sourceFiles(): string[] {
  // git, not a directory walk: it skips node_modules, build output and
  // anything untracked without a hand-maintained ignore list.
  const out = execFileSync('git', ['ls-files', 'app', 'lib'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    // The velocity module defines and tests these; the rule is about callers.
    .filter((p) => p !== 'lib/auth.ts' && !p.startsWith('lib/__tests__/'));
}

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/**
 * Strips comments and quoted strings, so prose explaining the forbidden shape
 * does not trip the grep. Both exclusions were earned: the first by the doc
 * comments on these very call sites, the second by `app/api/migrate/route.ts`,
 * whose operator-facing error message reads "recordVelocity() will fail until
 * it exists" — a mention, not a call, and the guard reported it as a money
 * path.
 *
 * Template literals are deliberately NOT stripped: they carry SQL with `${}`
 * interpolations, and removing them wholesale would blind the guard to a call
 * written inside one.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

describe('accounting domains stay separate', () => {
  it('lib/velocity-claims.ts contains NO write to velocity_checks', () => {
    // The defect this guards was architectural, not arithmetic. velocity_checks
    // has no domain column, so it is one pool per (user, window, currency)
    // holding money:send, request-accept and money:split-pay consumption
    // together. Any INSERT or UPDATE into it from the claim module is
    // cross-domain by construction: a funding or withdrawal return pays back
    // P2P spending, and a release with no prior charge drives usage negative
    // and creates capacity above the ceiling. All three were measured on a
    // real database before this guard existed.
    //
    // Funding and withdrawal exposure is DERIVED from claim state by
    // claimedExposure(). A reviewer reading one diff cannot see that writing
    // a "compensating row" here is forbidden, so the rule is mechanical.
    const src = code(read('lib/velocity-claims.ts'));

    expect(src).not.toMatch(/INSERT\s+INTO\s+velocity_checks/i);
    expect(src).not.toMatch(/UPDATE\s+velocity_checks/i);
    expect(src).not.toMatch(/DELETE\s+FROM\s+velocity_checks/i);
  });

  it('exposure is scoped by claim_kind, so one domain cannot release another', () => {
    // A release reducing the wrong domain is the same class of defect one
    // level in: a withdrawal return must not free funding room. The scoping
    // lives in claimedExposure()'s predicate, so assert it is there.
    // RAW source here, not code(): the stripper blanks quoted strings, so it
    // turns `state = 'reserved'` into `state = ''` and the assertion below
    // could never match. Caught on the first run of this guard.
    const raw = read('lib/velocity-claims.ts');
    const exposure = raw.slice(raw.indexOf('export async function claimedExposure'));

    expect(exposure).toMatch(/claim_kind\s*=\s*\$\{claimKind\}/);
    expect(exposure).toMatch(/user_id\s*=\s*\$\{userId\}/);
    expect(exposure).toMatch(/currency\s*=\s*\$\{currency\}/);
    expect(exposure).toMatch(/state\s*=\s*'reserved'/);
  });

  it('the release keeps all THREE idempotency mechanisms, none of which any behavioural test pins', () => {
    // Found by mutation testing during the validation of PR #77, and this is
    // the reason the guard is static rather than behavioural.
    //
    // releaseVelocityClaim() is idempotent by three mechanisms:
    //   1. SELECT ... FOR UPDATE, which serialises concurrent deliveries;
    //   2. an early return when the locked row already reads 'released';
    //   3. a conditional UPDATE ... WHERE state <> 'released'.
    //
    // They are genuinely 3-WAY REDUNDANT: any ONE of them alone makes a
    // double release impossible. Measured — removing (1), (2) or (3)
    // individually leaves all 73 cases in the velocity files GREEN, because
    // the suite asserts the idempotent OUTCOME and the surviving mechanisms
    // still deliver it.
    //
    // That redundancy is good design and a coverage hole at the same time.
    // The realistic failure is a sequence, not a single edit: someone removes
    // the conditional UPDATE as "redundant given FOR UPDATE", a later change
    // removes FOR UPDATE as "redundant given the early return", and each step
    // is individually green. Only the third removal breaks anything, and by
    // then two reviews have blessed the direction.
    //
    // So assert the presence of all three. RAW source, not code(): the
    // stripper blanks quoted strings, which would turn state <> 'released'
    // into state <> '' — the same trap the claim_kind guard above records.
    const raw = read('lib/velocity-claims.ts');
    const release = raw.slice(raw.indexOf('async function releaseWithin'));
    expect(release).not.toBe('');

    expect(release, 'mechanism 1: the row lock').toMatch(/FOR UPDATE/);
    expect(release, 'mechanism 2: the early already-released return')
      .toMatch(/claim\.state\s*===\s*'released'/);
    expect(release, 'mechanism 3: the conditional update predicate')
      .toMatch(/state\s*<>\s*'released'/);
  });

  it('the claim module does not call auditLog(), which takes its own connection', () => {
    // auditLog() uses getSql() and swallows its errors. Called from inside a
    // release transaction it risks the max:5 pool deadlock documented in
    // CLAUDE.md, and a swallowed failure means a release reports success with
    // no audit record. The release writes its audit row on the caller's
    // executor instead, so it commits and rolls back with the release.
    const src = code(read('lib/velocity-claims.ts'));
    expect(src).not.toMatch(/\bauditLog\s*\(/);
  });
});

describe('velocity admission is the only way a money path consumes budget', () => {
  it('no application file outside lib/auth.ts calls recordVelocity()', () => {
    const offenders = sourceFiles().filter((p) => /\brecordVelocity\s*\(/.test(code(read(p))));

    // recordVelocity() writes without verifying — half of the race. Paired
    // with checkVelocityLimit() it IS the race. Use admitVelocity().
    expect(offenders).toEqual([]);
  });

  it('only the documented preview call site uses checkVelocityLimit()', () => {
    const offenders = sourceFiles()
      .filter((p) => /\bcheckVelocityLimit\s*\(/.test(code(read(p))))
      .filter((p) => !PREVIEW_ALLOWED.includes(p));

    // If this fails on a new money path: that path must call admitVelocity()
    // inside its money transaction, passing `tx`. See the doc comment on
    // admitVelocity() for why the ordering and the executor both matter.
    expect(offenders).toEqual([]);
  });

  it('each money path passes its transaction to admitVelocity()', () => {
    // A four-argument call. Without the executor the claim commits on its own
    // connection — so a rolled-back payment keeps the budget consumed — and
    // it asks the `max: 5` pool for a second connection while holding one.
    // Neither failure is visible in a single-request test.
    const callers = sourceFiles().filter((p) => /\badmitVelocity\s*\(/.test(code(read(p))));
    expect(callers.length).toBeGreaterThan(0);

    for (const path of callers) {
      const calls = code(read(path)).match(/\badmitVelocity\s*\(([^)]*)\)/g) ?? [];
      expect(calls.length, `${path} matched but no call parsed`).toBeGreaterThan(0);
      for (const call of calls) {
        const args = call
          .replace(/^\s*admitVelocity\s*\(/, '')
          .replace(/\)$/, '')
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
        expect(args, `${path}: ${call} must pass an executor`).toHaveLength(4);
      }
    }
  });
});
