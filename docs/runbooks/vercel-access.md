# Runbook — granting an engineering session read access to Vercel

**Status:** required. Deployment facts are currently **unverifiable** from the
engineering environment, so the progress report records them as BLOCKED rather
than guessing.

## What was attempted, and the exact blocker

```
curl https://api.vercel.com/v2/user           → curl: (56) CONNECT tunnel failed, response 403
curl https://carloscab74.vercel.app           → curl: (56) CONNECT tunnel failed, response 403
command -v vercel                             → not installed
env | grep -i vercel                          → (no variables)
ls .vercel                                    → does not exist
```

The environment's egress proxy allows package registries, Anthropic APIs and
git, and refuses everything else — including Vercel. So **none** of the
following has been verified, and no document in this repository should claim
otherwise:

- which Vercel project is Manna's
- which branch deploys to production
- the current production deployment SHA
- the most recent preview SHA
- whether production and preview environments are isolated
- deployment logs, health, or error rates
- whether the declared cron actually fires, or whether `CRON_SECRET` is set

What *is* known, from the repository alone: `vercel.json` declares one cron,
`/api/cron/internal-reconciliation` on `0 15 * * *`. The project URL you gave,
`https://vercel.com/cocopiuf-laa-projects1/carlos_cab74`, is consistent with
the Vercel comments on recent pull requests, which name project
`carlos_cab74` under `cocopiuf-laa-projects1` and a production host of
`carloscab74.vercel.app`. **That is corroboration from PR metadata, not
verification against the Vercel API.**

## Option 1 — you read the facts out (no access granted, fastest)

The quickest unblock, and it grants this session nothing. From the Vercel
dashboard, Deployments tab:

1. Filter to **Production**. Note the newest deployment's **commit SHA** and
   status.
2. Filter to **Preview**. Note the newest preview's SHA and branch.
3. Settings → Git: note which branch is the **production branch**.
4. Settings → Environment Variables: note **which names exist** for Production
   and for Preview, and whether the two lists differ.
5. Settings → Cron Jobs: note whether the reconciliation cron is listed, and
   its last run.

Paste the **names and SHAs only**. Do not paste values — not `DATABASE_URL`,
not `CRON_SECRET`, not any key. Names and SHAs are enough to fill the report;
values would put live credentials in a chat transcript.

## Option 2 — grant the session read access via the CLI

Run these yourself, in a terminal you control. They are listed so nothing has
to be guessed, not so they can be run unattended.

**Caveat before you run any of these.** The egress proxy refuses Vercel, so
these invocations were written from memory and **could not be checked against
Vercel's documentation or a real CLI from this session**. Treat them as the
right commands with possibly-wrong flags: run `vercel <command> --help` and
prefer what that prints. Subcommand names and flags move between CLI versions.

```bash
# 1. Install the CLI
pnpm add -g vercel            # or: npm i -g vercel

# 2. Authenticate interactively. This opens a browser; no token is pasted
#    anywhere, and nothing is written into the repository.
vercel login

# 3. Link this checkout to the project. Creates .vercel/ locally —
#    it is gitignored and must stay that way.
vercel link --scope cocopiuf-laa-projects1 --project carlos_cab74

# 4. Read-only facts
vercel project ls
vercel ls --prod                  # production deployments, newest first
vercel ls                         # most recent deployments incl. previews
vercel env ls production          # NAMES only; never `vercel env pull`
vercel env ls preview
vercel inspect <deployment-url>   # build detail and deployment status
vercel logs <deployment-url>      # runtime logs
```

Two corrections to an earlier draft of this file, both worth stating because
acting on the wrong version wastes your time:

- **It is `vercel ls`, not `vercel deployments ls`**, and the `--limit` flag it
  showed is not something I can confirm exists. `vercel ls` lists newest
  first, so reading the top entries is enough for what this report needs.
- **`vercel inspect` reports the deployment's build and status, not whether
  the application is healthy.** It will happily describe a successfully built
  deployment that is returning 500s. Application health needs the logs, or a
  request against a real endpoint.

Cron jobs are most reliably read from the dashboard (Settings → Cron Jobs). A
CLI subcommand for them may or may not exist on this plan; Option 1 above
covers it either way.

**Do not run `vercel env pull`** in a shared or agent-accessible environment:
it writes real secret *values* to `.env.local` on disk.

If you want this session to be able to re-read these facts without you, it
needs a Vercel access token, provided through the environment's secret
mechanism — **not pasted into chat or committed**. Be clear-eyed about what
that grants:

**A personal access token carries your own account's permissions.** It can be
scoped to a team, but Vercel does not offer a token scoped to a single project,
and there is no "read-only" option on a personal token — it can deploy, change
environment variables and promote or delete deployments, because you can.
Issuing one hands this session your access to everything in that scope.

Genuinely least-privilege access means a separate member account holding a
read-only project role, and project-level viewer roles are an **Enterprise**
feature. On the current Hobby plan that option does not exist, which is why
Option 1 — you reading five facts out of the dashboard — is the recommendation
rather than the fallback.

If you grant a token anyway, confirm the boundary *before* issuing it: check
that each command above, run with that token, cannot reach a project other than
`carlos_cab74`. `--scope` selects a team context; it does not restrict the
token to one project. If you cannot confirm that boundary, use Option 1.

Either way the egress proxy must also be allowed to reach `api.vercel.com`,
which is a separate change to this environment.

## What this unblocks

Only reporting. It does **not** authorise changing environment variables,
promoting or rolling back a deployment, or enabling any flag. Those stay owner
actions regardless of access.
