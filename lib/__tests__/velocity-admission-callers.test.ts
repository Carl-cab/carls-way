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
