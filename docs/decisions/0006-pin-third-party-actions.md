# 0006 — Pinning third-party GitHub Actions to commit SHAs

**Date:** 2026-10-18
**Status:** **Proposed** — awaiting the owner's decision. Not implemented, and
deliberately so: see "Why this is not implemented here".

## Context

CI runs seven third-party action references, all pinned to a mutable tag:

```
actions/checkout@v4
actions/setup-node@v4
actions/upload-artifact@v4
pnpm/action-setup@v4
github/codeql-action/init@v3
github/codeql-action/autobuild@v3
github/codeql-action/analyze@v3
```

A tag is a pointer. Whoever controls the upstream repository can move `v4` to
different code at any time, and the next CI run executes it — with whatever
permissions that job holds. This is CWE-829, untrusted functionality inclusion,
and it is the supply-chain concern GitHub's own hardening guidance addresses by
recommending full-length commit SHAs.

The exposure here is not theoretical in scale: these jobs hold
`contents: read`, and the CodeQL job additionally holds
`security-events: write`. A compromised action in the `verify` job also sees
the PostgreSQL service container and the repository checkout.

What it does **not** see: production credentials. No workflow in this
repository holds `DATABASE_URL`, Plaid, Stripe or Wise secrets — the test suite
runs against a job-local PostgreSQL service. That materially lowers the blast
radius, and it is worth stating plainly rather than implying a worse exposure
than exists. The honest summary is that a compromised action could tamper with
CI results, publish false code-scanning alerts, or attempt to open a pull
request — not drain a bank balance.

## What pinning buys, and what it costs

**Buys:** the executed code cannot change under you. A malicious tag move is
inert, because the SHA still names the audited commit.

**Costs:** security patches in those actions stop arriving automatically. A
pinned SHA is frozen, including its vulnerabilities. Pinning without a renewal
mechanism trades a supply-chain risk for a staleness risk, and repositories
routinely end up years behind. This is why the recommendation below pairs
pinning with Dependabot rather than treating pinning as sufficient alone.

## Proposal

1. **Replace each tag with the full 40-character commit SHA**, keeping the
   human-readable version in a trailing comment so the file stays legible:

   ```yaml
   - uses: actions/checkout@<40-char-sha>  # v4.2.2
   ```

   Short SHAs are not acceptable; use the full hash.

2. **Enable Dependabot for GitHub Actions**, so pins are proposed for update
   rather than rotting:

   ```yaml
   # .github/dependabot.yml
   version: 2
   updates:
     - package-ecosystem: "github-actions"
       directory: "/"
       schedule:
         interval: "weekly"
   ```

   Dependabot raises a PR that moves the SHA and updates the comment. The pin
   stays immutable; the renewal becomes a reviewed change.

3. **Optionally** set the repository's Actions policy to allow only actions
   from `actions/`, `github/` and `pnpm/`. That is an owner setting, not a file
   change, and it constrains what a future workflow can introduce.

Order matters: do 2 alongside 1. Pinning without Dependabot is the trade that
goes wrong quietly.

## Why this is not implemented here

**I cannot resolve a tag to its SHA from this environment, and I will not write
a SHA I have not verified.** Measured:

```
gh api repos/actions/checkout/git/ref/tags/v4   → 403 (token lacks the scope)
curl https://api.github.com/...                 → 403 CONNECT (egress proxy)
```

A plausible-looking but wrong SHA is worse than a tag: CI fails with an opaque
"unable to resolve action" and the next person has no way to tell whether the
pin was mistyped or the action was withdrawn. Guessing hashes to appear
thorough is precisely the failure this repository's documentation rules exist
to prevent.

## How to implement it, for whoever has access

Resolve each tag and emit the pinned line:

```bash
for ref in \
  actions/checkout@v4 \
  actions/setup-node@v4 \
  actions/upload-artifact@v4 \
  pnpm/action-setup@v4 \
  github/codeql-action@v3
do
  repo="${ref%@*}"; tag="${ref#*@}"
  sha=$(gh api "repos/$repo/commits/$tag" --jq .sha)
  echo "$repo@$sha  # $tag"
done
```

Then replace each `uses:` line, keeping the three `github/codeql-action/*`
sub-paths on the same SHA, since they ship from one repository. Push to a
branch and confirm CI is green **before** merging — a bad pin fails every job,
so this change verifies itself.

## Alternatives considered

**Leave the tags.** Defensible today given that no workflow holds production
credentials, and it is the status quo. Rejected as the end state: the CodeQL
job can write security events, and a payments repository seeking a sponsor bank
should not have "we trust whatever `v4` points at today" in its supply-chain
answer.

**Pin only the CodeQL actions**, which hold the broader permission. A
reasonable half-measure, and strictly better than nothing, but `actions/checkout`
runs in every job and sees the source tree; pinning six and leaving one is an
odd line to draw once the mechanism exists.

**A third-party pinning tool** (for example `ratchet`). Rejected: it adds a
dependency to solve a problem that is seven lines of `sed` once the SHAs are
known.
