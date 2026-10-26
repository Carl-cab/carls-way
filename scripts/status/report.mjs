/**
 * Manna progress report.
 *
 * Generates a Markdown summary of where the project stands, from repository
 * evidence. Run it locally with `pnpm run status`, or let CI append it to the
 * job summary so the owner can read it in the GitHub UI without any new web
 * surface, credential, or deployment.
 *
 * Two rules shape this script, and both are there to stop it lying:
 *
 * 1. **It never infers a status.** Gate and operational statuses come from
 *    `scripts/status/readiness.json`, where each one carries named evidence
 *    and changing it is a reviewable diff. A dashboard that guesses
 *    "VERIFIED" manufactures exactly the false confidence the audit record
 *    exists to prevent.
 *
 * 2. **It never reports a check it did not see run.** Test, typecheck, lint
 *    and build results are passed in by whoever ran them (CI, or a developer
 *    via flags). Absent input renders as NOT RUN, not as a pass. Successful
 *    CI is evidence about the code, not about production readiness, and the
 *    report says so where it matters.
 *
 * It prints no secrets, no customer data and no transaction detail: its inputs
 * are `git`, a committed JSON file, and optional numeric arguments.
 *
 * ── Why this is .mjs and not .ts ───────────────────────────────────────────
 *
 * A deliberate exception to CLAUDE.md's "all new files must be .ts" rule,
 * recorded there too rather than left as a silent violation.
 *
 * The first version was `.ts` run via `tsx`, which failed in CI with
 * `tsx: not found` — it worked locally only because `npx` fetches on demand,
 * while CI installs `--frozen-lockfile` from declared dependencies. The two
 * ways to keep `.ts` both cost something: adding `tsx` pulls a build toolchain
 * into a payments repository that has an open supply-chain decision (0006)
 * purely to render a Markdown table, and Node's native type stripping needs
 * 22.6+ while CI pins Node 20 — that route would have passed locally and
 * failed in CI again.
 *
 * This script has no meaningful type surface: its inputs are git output, a
 * JSON file and argv strings. Plain ESM runs on Node 20 with no flags and no
 * dependency, so that is what it is.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const READINESS = path.join(ROOT, 'scripts/status/readiness.json');

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '(unavailable)';
  }
}

/** `--key=value` arguments, so CI can pass real results it actually observed. */
function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const ICON = {
  VERIFIED: '✅',
  PARTIAL: '🟡',
  BLOCKED: '⛔',
  'NOT RUN': '⬜',
  'NOT APPLICABLE': '—',
};

function requirementRows(reqs) {
  return reqs
    .map((r) => `| ${ICON[r.status]} ${r.status} | ${r.name} | ${r.evidence} |`)
    .join('\n');
}

function tally(reqs) {
  const counts = new Map();
  for (const r of reqs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return ['VERIFIED', 'PARTIAL', 'NOT RUN', 'BLOCKED', 'NOT APPLICABLE']
    .filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(' · ');
}

function main() {
  if (!existsSync(READINESS)) {
    console.error(`Missing ${READINESS}`);
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(READINESS, 'utf8'));

  const head = git('rev-parse', '--short', 'HEAD');
  const headFull = git('rev-parse', 'HEAD');
  // On a pull_request run the checkout is a detached merge commit, so
  // `rev-parse --abbrev-ref HEAD` prints the literal `HEAD` — useless in a
  // report whose whole purpose is telling the owner which branch this is.
  // GITHUB_HEAD_REF carries the source branch on PR events and is empty
  // elsewhere; GITHUB_REF_NAME covers push events; git covers local runs.
  const branch =
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    git('rev-parse', '--abbrev-ref', 'HEAD');
  const lastSubject = git('log', '-1', '--pretty=%s');
  const lastDate = git('log', '-1', '--pretty=%cI');

  const tests = arg('tests');
  const files = arg('files');
  const failures = arg('failures');
  // CI runs `pnpm test` but does not parse vitest's output, so it can report
  // the step's outcome without knowing the counts. Inventing a count would
  // break rule 2 above; omitting the row entirely reported NOT RUN for a
  // suite that demonstrably ran, which is just as misleading.
  const testOutcome = arg('test-outcome');
  const typecheck = arg('typecheck');
  const lint = arg('lint');
  const build = arg('build');
  const audit = arg('audit');

  const notRun = '⬜ NOT RUN (not supplied to this run)';
  const out = [];

  out.push('# Manna — Progress Report');
  out.push('');
  out.push(`Generated from repository evidence at \`${head}\`.`);
  out.push('');
  out.push(
    'Statuses are claims with named evidence, maintained in' +
      ' `scripts/status/readiness.json` and changed only by a reviewed diff.' +
      ' **No percentages are reported** — there is no defined denominator, so' +
      ' any percentage would be invented. **Green CI is evidence about the' +
      ' code, not about production readiness.**',
  );
  out.push('');

  out.push('## Engineering health');
  out.push('');
  out.push('| Item | Value |');
  out.push('|---|---|');
  out.push(`| Branch | \`${branch}\` |`);
  out.push(`| Commit | \`${headFull}\` |`);
  out.push(`| Last commit | ${lastSubject} |`);
  out.push(`| Commit date | ${lastDate} |`);
  const testCell = tests
    ? `${tests} passing across ${files ?? '?'} files`
    : (testOutcome ?? notRun);
  // A NOT RUN outcome means the suite never executed, so there is no count to
  // have failed to parse. Saying "count not parsed" there implies a run
  // happened — the same over-claim this script exists to prevent.
  const testRan = Boolean(tests) || (testOutcome && !testOutcome.includes('NOT RUN'));
  out.push(`| Tests | ${testCell} |`);
  out.push(
    `| Test failures | ${failures ?? (testRan ? '(count not parsed from this run)' : (testOutcome ?? notRun))} |`,
  );
  out.push(`| Typecheck | ${typecheck ?? notRun} |`);
  out.push(`| Lint | ${lint ?? notRun} |`);
  out.push(`| Build | ${build ?? notRun} |`);
  out.push(`| Dependency audit (prod) | ${audit ?? notRun} |`);
  out.push('');

  out.push('## Deployment status');
  out.push('');
  out.push(
    '⛔ **BLOCKED — not verifiable from the engineering environment.** The' +
      ' egress proxy refuses `api.vercel.com` and the deployment host with' +
      ' `403 CONNECT`, and no Vercel CLI or token is present. Production SHA,' +
      ' preview SHA, environment isolation, deployment logs and health are' +
      ' therefore **NOT RUN**, not passing. Steps to grant access are in' +
      ' `docs/runbooks/vercel-access.md`.',
  );
  out.push('');
  out.push(
    'What *is* known from the repository: `vercel.json` declares one cron,' +
      ' `/api/cron/internal-reconciliation` at `0 15 * * *`. Whether it fires,' +
      ' and whether `CRON_SECRET` is set, is unverified.',
  );
  out.push('');

  out.push('## Banking readiness');
  out.push('');
  out.push(
    'Three independent gates. A gate is not a sequence — B and C each carry' +
      ' blockers that no engineering work can clear.',
  );
  for (const key of Object.keys(r.gates)) {
    const g = r.gates[key];
    out.push('');
    out.push(`### Gate ${key} — ${g.title}`);
    out.push('');
    out.push(`_${tally(g.requirements)}_`);
    out.push('');
    out.push('| Status | Requirement | Evidence |');
    out.push('|---|---|---|');
    out.push(requirementRows(g.requirements));
  }
  out.push('');

  out.push('## Operational readiness');
  out.push('');
  out.push(`_${tally(r.operational)}_`);
  out.push('');
  out.push('| Status | Item | Evidence |');
  out.push('|---|---|---|');
  out.push(requirementRows(r.operational));
  out.push('');

  out.push('## Owner actions');
  out.push('');
  out.push('These cannot be completed from an engineering session.');
  out.push('');
  out.push('| Action | Why it matters |');
  out.push('|---|---|');
  // Fail loudly on the wrong shape. A plain string here produced
  // "| undefined | undefined |" for all eight rows — the one section written
  // for the owner, rendered empty, with a zero exit status. A renderer that
  // interpolates whatever it is handed turns a data mistake into a silent
  // one, and `node report.mjs > /dev/null` then "passes".
  for (const a of r.ownerActions) {
    // Truthiness is not enough, and getting that wrong here reproduced the
    // very bug this guard was added for: `action: []` is truthy, a template
    // literal renders it as the empty string, and the report emitted "|  |  |"
    // with exit 0. Require a non-empty string, which is the only thing that
    // can render as a cell.
    if (
      typeof a !== 'object' ||
      a === null ||
      typeof a.action !== 'string' ||
      a.action.trim() === '' ||
      typeof a.why !== 'string' ||
      a.why.trim() === ''
    ) {
      throw new Error(
        `ownerActions entries must be { action, why } objects; got ${JSON.stringify(a)?.slice(0, 80)}`,
      );
    }
    out.push(`| ${a.action} | ${a.why} |`);
  }
  out.push('');
  out.push(
    `_Readiness evidence last reviewed ${r.updated}, against \`${r.verifiedAgainstCommit}\`._`,
  );
  out.push('');

  console.log(out.join('\n'));
}

main();
