/**
 * Every third-party GitHub Action must be pinned to a full commit SHA.
 *
 * ## Why this is a security control and not style
 *
 * `uses: actions/checkout@v4` resolves a *tag*, and a tag is a mutable
 * pointer the action's owner can move at any time. Whoever controls that
 * repository — or anyone who compromises it — can repoint `v4` at new code,
 * and every workflow in the world that names `@v4` runs it on the next job
 * with no change to this repository and no review here.
 *
 * That matters more than usual for this repo's jobs. `actions/checkout`
 * handles the job token; the secret-scan job downloads and executes a binary
 * over the whole git history; CodeQL's job holds `security-events: write`. A
 * moved tag in any of them is arbitrary code execution inside CI with those
 * permissions.
 *
 * A 40-hex SHA cannot be repointed. Upgrading becomes a deliberate, reviewable
 * diff instead of something that happens silently between two runs.
 *
 * ## Why a test rather than a convention
 *
 * Pinning is easy to do once and easy to lose: the obvious way to add a step
 * is to copy a `uses: owner/action@v4` line from documentation. Nothing in
 * typecheck, lint or the build looks at a YAML file, so an unpinned action
 * would reach `master` with six green checks. This test is the only thing in
 * the repository that would notice.
 *
 * ## What it deliberately does not check
 *
 * That the SHA corresponds to the version in the trailing comment. Verifying
 * that needs network access to another repository, which a unit test must not
 * take. The comment is a human-readable hint; the SHA is the control.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIR = join(process.cwd(), '.github', 'workflows');

/** `uses:` lines, with the file and line number so a failure is locatable. */
function usesLines(): Array<{ file: string; line: number; value: string }> {
  const out: Array<{ file: string; line: number; value: string }> = [];
  for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    text.split('\n').forEach((raw, i) => {
      // Skip comment lines: the explanatory prose above several steps mentions
      // action names, and a comment is not an execution.
      if (/^\s*#/.test(raw)) return;
      const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(raw);
      if (m) out.push({ file, line: i + 1, value: m[1] });
    });
  }
  return out;
}

describe('GitHub Actions supply chain', () => {
  it('finds the workflows it is supposed to be guarding', () => {
    // Without this, deleting or renaming the workflow directory would make
    // every assertion below pass over an empty list — a green test that
    // guards nothing, which is worse than a missing test.
    const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
    expect(files).toContain('ci.yml');
    expect(files).toContain('codeql.yml');

    const lines = usesLines();
    expect(lines.length).toBeGreaterThanOrEqual(7);
  });

  it('pins every action to a full 40-character commit SHA', () => {
    const offenders = usesLines().filter(
      ({ value }) =>
        // A local action (`./path`) is this repository's own code and is
        // already covered by review; it has no upstream to repoint.
        !value.startsWith('./') && !/@[0-9a-f]{40}$/.test(value),
    );

    expect(
      offenders.map((o) => `${o.file}:${o.line} ${o.value}`),
      'Pin to a commit SHA, not a tag or branch. A tag can be moved by the ' +
        'action owner, which would run unreviewed code in CI with this job’s ' +
        'permissions. Take the SHA from a run log line "Download action ' +
        'repository \'owner/action@vN\' (SHA:...)" and keep "# vN" as a comment.',
    ).toEqual([]);
  });

  it('keeps a readable version hint beside each pinned SHA', () => {
    // A bare SHA is secure but unreadable: nobody can tell v3 from v4 at a
    // glance, so upgrades get skipped. The comment is documentation, not a
    // control — hence a separate, softer assertion from the one above.
    const unlabelled: string[] = [];
    for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
      text.split('\n').forEach((raw, i) => {
        if (/^\s*#/.test(raw)) return;
        if (!/^\s*(?:-\s*)?uses:\s*\S+@[0-9a-f]{40}/.test(raw)) return;
        if (!/#\s*v?\d/.test(raw)) unlabelled.push(`${file}:${i + 1}`);
      });
    }
    expect(unlabelled, 'Add a trailing "# vN" comment naming the version.').toEqual([]);
  });

  it('does not reintroduce a mutable reference anywhere in the directory', () => {
    // Belt and braces against a syntax the line parser above might not match
    // (a `uses` nested in a composite step, an unusual indentation). Any
    // `@`-reference to a non-SHA in a non-comment line is worth a look.
    const suspicious: string[] = [];
    for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
      text.split('\n').forEach((raw, i) => {
        if (/^\s*#/.test(raw)) return;
        const m = /uses:\s*([^\s#]+)/.exec(raw);
        if (!m) return;
        const ref = m[1];
        if (ref.startsWith('./')) return;
        if (/@[0-9a-f]{40}$/.test(ref)) return;
        suspicious.push(`${file}:${i + 1} ${ref}`);
      });
    }
    expect(suspicious).toEqual([]);
  });
});
