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
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

type Status = 'VERIFIED' | 'PARTIAL' | 'BLOCKED' | 'NOT RUN' | 'NOT APPLICABLE';

interface Requirement {
  name: string;
  status: Status;
  evidence: string;
}
interface Gate {
  title: string;
  requirements: Requirement[];
}
interface Readiness {
  updated: string;
  verifiedAgainstCommit: string;
  gates: Record<string, Gate>;
  operational: Requirement[];
  ownerActions: { action: string; why: string }[];
}

const ROOT = process.cwd();
const READINESS = path.join(ROOT, 'scripts/status/readiness.json');

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '(unavailable)';
  }
}

/** `--key=value` arguments, so CI can pass real results it actually observed. */
function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const ICON: Record<Status, string> = {
  VERIFIED: '✅',
  PARTIAL: '🟡',
  BLOCKED: '⛔',
  'NOT RUN': '⬜',
  'NOT APPLICABLE': '—',
};

function requirementRows(reqs: Requirement[]): string {
  return reqs
    .map((r) => `| ${ICON[r.status]} ${r.status} | ${r.name} | ${r.evidence} |`)
    .join('\n');
}

function tally(reqs: Requirement[]): string {
  const counts = new Map<Status, number>();
  for (const r of reqs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return (['VERIFIED', 'PARTIAL', 'NOT RUN', 'BLOCKED', 'NOT APPLICABLE'] as Status[])
    .filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(' · ');
}

function main(): void {
  if (!existsSync(READINESS)) {
    console.error(`Missing ${READINESS}`);
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(READINESS, 'utf8')) as Readiness;

  const head = git('rev-parse', '--short', 'HEAD');
  const headFull = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const lastSubject = git('log', '-1', '--pretty=%s');
  const lastDate = git('log', '-1', '--pretty=%cI');

  const tests = arg('tests');
  const files = arg('files');
  const failures = arg('failures');
  const typecheck = arg('typecheck');
  const lint = arg('lint');
  const build = arg('build');
  const audit = arg('audit');

  const notRun = '⬜ NOT RUN (not supplied to this run)';
  const out: string[] = [];

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
  out.push(`| Tests | ${tests ? `${tests} passing across ${files ?? '?'} files` : notRun} |`);
  out.push(`| Test failures | ${failures ?? notRun} |`);
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
  for (const a of r.ownerActions) out.push(`| ${a.action} | ${a.why} |`);
  out.push('');
  out.push(
    `_Readiness evidence last reviewed ${r.updated}, against \`${r.verifiedAgainstCommit}\`._`,
  );
  out.push('');

  console.log(out.join('\n'));
}

main();
