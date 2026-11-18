# Preview environment isolation — checklist

**Status: NOT RUN. Every item below is unverified, and this document cannot
verify any of them.**

The engineering session that wrote this cannot reach Vercel: `vercel.com`,
`api.vercel.com` and the deployment host all answer `403 CONNECT` through the
egress proxy, and no Vercel CLI or token is present. Every item here is a
**dashboard fact** that only the owner can read, and several are questions
about **values**, which are deliberately never compared through a session or a
transcript.

Do not treat an unticked box as low risk. Item 2 in particular describes
something that may already have happened many times.

---

## Why this exists

Sprint 2 requires: *"Preview must use an isolated database containing synthetic
data. Verify whether separate overrides already exist. Do not perform
transactional testing against Preview until database isolation is confirmed."*

That last sentence is the operative one. **Until item 2 is answered, no
transactional testing may run against a Preview deployment.** A preview build
runs on every push to every PR, resolves to `production` mode
(`MANNA_ENV` is absent and `lib/environment.ts` correctly defaults to
production), and would therefore exercise whatever database `DATABASE_URL`
names.

---

## What the owner's 2026-11-17 read-only audit established

Names and scopes only; no values read, nothing changed.

| Variable | Scope | Note |
|---|---|---|
| `DATABASE_URL` | Production **and** Preview | single entry — **the question behind item 2** |
| `PLAID_SECRET` | Production **and** Preview | production secret, reaches every preview build |
| `PLAID_CLIENT_ID` | Production only | the accidental protection |
| `REDIS_URL` | separate entries for Production and Preview | both recently updated |
| `NEXT_PUBLIC_PLAID_ENV` | Production and Preview | read by no code in this repository |
| `CRON_SECRET` | Production only | |
| `MANNA_ENV` | absent | correct: production is the safe default |
| `PLAID_TRANSFER_LIVE`, `CA_EFT_LIVE` | absent | live rails off |
| `RESEND_API_KEY`, `EMAIL_FROM`, `BACKFILL_SECRET` | All Environments | |

**A single entry scoped to two environments is one value.** Vercel shows a
separate entry per scope when the values differ. `REDIS_URL` has two entries —
so Redis is plausibly already split. `DATABASE_URL` has one, which is
consistent with Preview and Production sharing a database, and is the reason
item 2 is first.

---

## 1. Establish the facts (owner, dashboard)

- [ ] Open Settings → Environment Variables and confirm whether `DATABASE_URL`
      is **one entry covering both scopes** or **two entries with different
      values**. Report only *same* or *different* — never the values.
- [ ] If one entry: Preview and Production share a database. Treat every
      preview deployment to date as having read and written production data,
      and go to item 2.
- [ ] Confirm the two `REDIS_URL` entries point at different instances. A
      shared Redis is a smaller problem than a shared database — rate-limit
      counters, not money — but it is still shared state between environments.

## 2. Give Preview its own database (owner)

- [ ] Create a **separate Supabase project** for Preview. Not a second schema
      in the same project: a schema shares the instance, its connection limits
      and its backups, and one wrong `search_path` crosses the boundary.
- [ ] Isolate the Preview credentials: a database user of its own, whose
      password is not the production one and is not reused anywhere else.
- [ ] Configure the Preview-scoped variables (see 2c) **before** deploying, so
      the first deployment that touches this database is already restricted.
- [ ] Deploy the corrected application privately to Preview.
- [ ] Build its schema from the repository, in this order:
      1. deploy the branch so `initializeSchema()` runs on first boot;
      2. call `POST /api/migrate` once against the **Preview** deployment,
         authenticated — the authorized Preview migration, never production;
      3. run `scripts/verify-migrate.sql` and require **0 non-OK rows**;
      4. confirm `SELECT count(*) FROM users` is **0**.
- [ ] Create every synthetic account **through the application**, never by
      SQL insert, so the seed matches what the code produces — including the
      opening-balance ledger entry.

  **Never apply `lib/__tests__/helpers/test-schema.sql`, and never restore a
  production dump.** An earlier revision of this step offered the fixture as
  an alternative to `initializeSchema()`; that was wrong and contradicted
  section 2b, which was added later from measurement. The fixture seeds test
  accounts holding 500.00 with no ledger entries, and a database built from it
  fails `user_wallets_exactly_match_ledger` before a single participant signs
  up. The contradiction is removed here rather than left for a reader to
  resolve.
- [ ] **Do not restore a production dump into it**, under any circumstances.
      That would put real customer data in an environment every PR can reach,
      and it is the one mistake no later step can undo.
- [ ] Set `DATABASE_URL` **Preview scope only** to the new project. Leave the
      Production entry untouched.
- [ ] Redeploy a preview and confirm it is reading the new database — a fresh
      Preview database has no users, so a login with a known production
      account must **fail**. That negative is the proof; a successful page load
      proves nothing.

- [ ] Record **evidence that the two databases are distinct, without
      exposing either credential**: from each environment, report
      `SELECT current_database(), inet_server_addr(), current_user;` — or the
      Supabase project reference — and show that they differ. Report only
      whether they differ, never a connection string, host password or key.

## 2b. Provision the beta database correctly — NOT from the test fixture

**Found 2026-11-18, and it will fail reconciliation on day one if missed.**

- [ ] Build the beta database from `initializeSchema()` plus
      `POST /api/migrate`. **Do NOT apply
      `lib/__tests__/helpers/test-schema.sql`.**

That file is a CI fixture, and it seeds accounts — `splitpayera`,
`splitpayerb`, `velpayer` — holding 500.00 with **no ledger entries at all**.
Measured: a beta database built from it reported **3 violations** of
`user_wallets_exactly_match_ledger` and the reconciliation cron answered
**HTTP 500 `passed:false`** before a single participant had signed up.
Removing those accounts produced **7/7 PASS and HTTP 200**.

- [ ] After provisioning, confirm `SELECT count(*) FROM users` is **0** before
      any participant registers. A non-zero count means the fixture was
      applied.

## 2c. Set and VERIFY the restricted beta profile

- [ ] Set `MANNA_ENV=sandbox` on the Preview scope. This is what makes the
      restricted profile the default.
- [ ] Set `PLAID_ENV=sandbox` on the Preview scope.
- [ ] Set `MANNA_BETA_PROFILE=p2p_only` **explicitly** on the Preview scope.
      With `MANNA_ENV=sandbox` the profile already resolves to `p2p_only` when
      the variable is absent or misspelled, so this is belt and braces — but
      an explicit value is what a later reader of the dashboard can see, and
      it survives a future change to the sandbox default.
- [ ] **Verify it from the running deployment**, not from the dashboard:

      GET /api/beta-profile   (authenticated)

      must return
      `{"profile":"p2p_only","restricted":true,
        "capabilities":{"funding":false,"cash_out":false,
          "cross_currency":false,"bank_linking":false,"external_fx":false}}`

      **All five must be present and false.** A response carrying only the
      first three is an older deployment, not a passing check — the two
      containment capabilities were added 2026-11-18, and reading a
      three-key response as "restricted" would miss that bank linking and
      external FX are open. A variable somebody believes they set is not
      evidence either; this endpoint reads the same resolver the routes
      enforce with.
- [ ] Confirm the refusals against the deployment. Each must be
      **403 `BETA_RESTRICTED`** with the matching `capability`:

      | Request | capability |
      |---|---|
      | `POST /api/transfers/intent` with `add_money` | `funding` |
      | `POST /api/transfers/intent` with `cash_out` | `cash_out` |
      | cross-currency `POST /api/transactions` | `cross_currency` |
      | `PATCH /api/transactions/<id>` accepting a cross-currency request | `cross_currency` |
      | `POST /api/plaid/create-link-token` | `bank_linking` |
      | `POST /api/plaid/exchange-token` | `bank_linking` |
      | `POST /api/stripe/setup-intent` | `bank_linking` |
      | `POST /api/stripe/confirm-setup` | `bank_linking` |
      | `POST /api/fx/quote` with CAD→USD | `external_fx` |

- [ ] Confirm the negatives, which are what prove the restriction is scoped
      rather than a blanket outage: a **same-currency** payment still answers
      201; a **same-currency** `POST /api/fx/quote` still answers 200;
      `GET /api/bank-accounts` still answers 200; and declining a request
      still succeeds. A deployment where everything refuses is not contained,
      it is broken.
- [ ] **Do not take the static coverage guard as proof of any of the above.**
      It reads source text in CI. These boxes are about the running
      deployment, and only a real request against it can tick them.

## 3. Seed synthetic data (owner or engineering, once isolated)

- [ ] Register synthetic participants through the running application rather
      than by SQL insert, so the seed matches what the code produces.
      Emails under a domain you control or `@example.test`.
- [ ] Note the `auth:register` limit: **3/hour**, keyed on
      `clientIdentifier()`, which collapses to **one global bucket** when no
      client IP header is present. Several people behind one NAT share it, and
      the fourth signup inside an hour is refused. Space the seeding out, or
      accept the refusals as expected.
- [ ] Never copy a production row, including a single user, into Preview.

## 4. Remove the production Plaid secret from Preview (owner)

**Do this whether or not Preview exercises Plaid.**

- [ ] Delete `PLAID_SECRET` from the **Preview** scope. Keep Production.
- [ ] **Do NOT add `PLAID_CLIENT_ID` to Preview.** It reads like tidying up an
      inconsistency and is the opposite: today a preview build sends an empty
      client id (`cleanPlaidCredential(undefined)` returns `''`) and Plaid
      rejects it. What stops preview builds reaching live Plaid is a *missing
      credential*, not a control anyone chose. Adding the client id would point
      every PR's preview build at live Plaid with the production secret.
- [ ] If Preview should exercise Plaid at all, add **sandbox** credentials for
      **both** values plus `PLAID_ENV=sandbox`, scoped to Preview only.
- [ ] Afterwards, confirm a preview build's Plaid call fails for the new
      reason (no credentials) rather than the old one (empty client id).

## 5. Delete the unused variable (owner)

- [ ] Delete `NEXT_PUBLIC_PLAID_ENV` from both scopes. Verified 2026-11-18 by
      grepping every `.ts`, `.tsx`, `.mjs` and `.json` outside `node_modules`:
      **zero references**. The server-side resolver is `PLAID_ENV` via
      `lib/plaid-env.ts`. It is inlined into the browser bundle, so it ships to
      every visitor for no purpose, and its name reads as though it controls
      Plaid's host — so an operator changing it to fix a Plaid problem would
      see no effect and look elsewhere.

## 6. Keep the rails off in Preview (owner)

- [ ] Confirm `PLAID_TRANSFER_LIVE` and `CA_EFT_LIVE` remain **absent** in
      every scope. Any value other than `true` is sandbox, but absence is the
      state to maintain.
- [ ] Confirm no team-level variable supplies either. The 2026-11-17 audit
      found none linked to this project; re-check after any team change,
      because a team variable would be inherited silently.
- [ ] Consider setting `MANNA_ENV=sandbox` on Preview **only**. Note what it
      does and does not do: `VERCEL_ENV=production` overrides it, so it cannot
      weaken a production deploy — and on Vercel a preview deployment does not
      carry `VERCEL_ENV=production`, so this does change preview behaviour.
      Decide deliberately; it is not a no-op.

## 7. Before any transactional testing against Preview

All of these must hold, together:

- [ ] Item 2 complete and the negative login test performed.
- [ ] `scripts/verify-migrate.sql` reports **0 non-OK rows** on the Preview
      database.
- [ ] `scripts/reconciliation-check.sql` reports **all seven PASS**, and
      `GET /api/cron/internal-reconciliation` answers **HTTP 200** with
      `passed: true`.

      This changed on 2026-11-18. The two split-payment failures were fixed by
      PR #82 and the wallet-equality failure by PR #83, and a correctly
      provisioned beta database now passes 7/7 — measured, after a P2P send, a
      request-accept and a split payment. A FAIL here is therefore a real
      signal again, not an expected one. If `user_wallets_exactly_match_ledger`
      fails, check item 2b first: it is almost certainly the test fixture.
- [ ] Both live rail flags confirmed absent.
- [ ] The participants are synthetic and the data is disposable.

---

## What this does not cover

Supabase-side isolation: database roles, Row Level Security, connection
limits and backup retention for the Preview project. Those are configured in
Supabase, not Vercel, and nothing in this repository can verify them either.
