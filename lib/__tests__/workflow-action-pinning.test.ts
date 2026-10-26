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

/**
 * Matches a `uses` step, in every spelling YAML accepts for that key.
 *
 * The naive form — `/uses:\s*(\S+)/` — has a bypass, and it was in the first
 * version of this file. YAML allows whitespace before the colon and allows the
 * key to be quoted, so all of these set the key `uses` and all of them run:
 *
 *     - uses: owner/action@v4
 *     - uses : owner/action@v4
 *     - "uses": owner/action@v4
 *     - 'uses': owner/action@v4
 *
 * Verified against a YAML parser: each parses to `{uses: "owner/action@v4"}`.
 * A matcher requiring a bare `uses:` skips the other three, and because the
 * remaining steps still satisfy the reference floor below, the suite would pass
 * while a mutable reference merged. A guard with a bypass is worse than no
 * guard, because it is trusted.
 *
 * Parsing the YAML properly would close this more thoroughly, but no YAML
 * parser is available to this project and adding a dependency to lint two
 * files is out of proportion. Hence a deliberately permissive regex, with the
 * bypass spellings pinned by their own tests below.
 */
const USES_LINE = /^\s*(?:-\s*)?["']?uses["']?\s*:\s*["']?([^\s"']+)/;
/** Same tolerance, unanchored, for the belt-and-braces sweep. */
const USES_ANYWHERE = /["']?uses["']?\s*:\s*["']?([^\s#"']+)/;

/** Action references in one file's text, with line numbers for locatability. */
function refsIn(text: string): Array<{ line: number; value: string }> {
  const out: Array<{ line: number; value: string }> = [];
  text.split('\n').forEach((raw, i) => {
    // Skip comment lines: the explanatory prose above several steps mentions
    // action names, and a comment is not an execution.
    if (/^\s*#/.test(raw)) return;
    const m = USES_LINE.exec(raw);
    if (m) out.push({ line: i + 1, value: m[1] });
  });
  return out;
}

/** `uses` lines across the real workflow directory. */
function usesLines(): Array<{ file: string; line: number; value: string }> {
  const out: Array<{ file: string; line: number; value: string }> = [];
  for (const file of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    for (const r of refsIn(readFileSync(join(WORKFLOW_DIR, file), 'utf8'))) {
      out.push({ file, line: r.line, value: r.value });
    }
  }
  return out;
}

describe('the matcher itself, against the spellings that bypassed it', () => {
  // These run on synthetic text rather than the real files, because the point
  // is to prove the matcher sees a form that is NOT currently in the repo. A
  // guard can only be trusted if its blind spots have been probed directly.
  it.each([
    ['bare', '      - uses: owner/action@v4'],
    ['space before colon', '      - uses : owner/action@v4'],
    ['wide space before colon', '      - uses   : owner/action@v4'],
    ['double-quoted key', '      - "uses": owner/action@v4'],
    ['single-quoted key', "      - 'uses': owner/action@v4"],
    ['not a list item', '    uses: owner/action@v4'],
    // A quoted scalar keeps its quotes in the captured value unless they are
    // excluded. That direction of the defect is a false *failure* — a validly
    // pinned `uses: "owner/action@<sha>"` would be rejected because the
    // anchored SHA assertion saw a trailing quote — so it would have blocked a
    // future workflow rather than let a mutable reference through. Still the
    // matcher being wrong about what it is reading.
    ['double-quoted value', '      - uses: "owner/action@v4"'],
    ['single-quoted value', "      - uses: 'owner/action@v4'"],
    ['quoted key and value', '      - "uses": "owner/action@v4"'],
  ])('sees a %s uses step', (_label, line) => {
    expect(refsIn(line)).toEqual([{ line: 1, value: 'owner/action@v4' }]);
  });

  it('ignores a commented-out reference', () => {
    expect(refsIn('      # - uses: owner/action@v4')).toEqual([]);
  });

  it('would flag each bypass spelling as unpinned', () => {
    // The assertion that matters: every spelling reaches the SHA check, so a
    // mutable reference cannot hide behind YAML syntax.
    const lines = [
      '      - uses : owner/action@v4',
      '      - "uses": owner/action@main',
      "      - 'uses': owner/action@v3",
    ].join('\n');
    const unpinned = refsIn(lines).filter(({ value }) => !/@[0-9a-f]{40}$/.test(value));
    expect(unpinned).toHaveLength(3);
  });

  it('accepts a SHA-pinned reference in any spelling', () => {
    const sha = 'a'.repeat(40);
    const lines = [
      `      - uses : owner/action@${sha}`,
      `      - "uses": owner/action@${sha}`,
      // Quoted *value*: the capture must not keep the closing quote, or the
      // `$`-anchored SHA assertion rejects a correctly pinned action.
      `      - uses: "owner/action@${sha}" # v4`,
      `      - uses: 'owner/action@${sha}'`,
    ].join('\n');
    const unpinned = refsIn(lines).filter(({ value }) => !/@[0-9a-f]{40}$/.test(value));
    expect(unpinned).toEqual([]);
  });
});

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
        if (!/^\s*(?:-\s*)?["']?uses["']?\s*:\s*\S+@[0-9a-f]{40}/.test(raw)) return;
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
        const m = USES_ANYWHERE.exec(raw);
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
