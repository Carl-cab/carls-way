# Beta deployment verification — command sequence

**Status: NOT RUN. Every command below is written to be run by the owner
against the isolated Preview deployment, and none of it has been executed.**

This file is the executable companion to
`docs/runbooks/preview-environment-isolation.md`. That document decides *what
must be true*; this one gives the commands that establish it, in order, with
the expected output for each and what a wrong answer means.

**Scope: the first beta needs neither Plaid nor Wise.** Funding, cash-out,
cross-currency, bank linking and external FX are all withheld by
`lib/beta-restrictions.ts`, so no participant action contacts a provider.
Section 5 proves that rather than assuming it.

**Two rules that govern the whole sequence.**

1. **Create every account through the running application, never from SQL and
   never from the CI fixture.** `lib/__tests__/helpers/test-schema.sql` seeds
   accounts holding 500.00 with **no ledger entries**; a database built from
   it fails `user_wallets_exactly_match_ledger` before a single participant
   signs up. Measured: 3 violations and the cron answering HTTP 500.
2. **Stop at the first failure.** These checks are ordered so that a failure
   invalidates everything after it. A reconciliation pass on the wrong
   database proves nothing.

Throughout, `$BETA` is the Preview deployment origin and `$COOKIE` a cookie
jar from a real login. **Never paste a connection string, password or API key
into a command you also paste into a transcript** — §1 is written to report
differences, not values.

```bash
BETA="https://<preview-deployment>.vercel.app"
COOKIE="$(mktemp)"        # holds the session cookie; delete when finished
```

---

## 1. Database identity and isolation

Run against each database **from its own environment's console** (Supabase SQL
editor for each project), not through the application:

```sql
SELECT current_database(), current_user, inet_server_addr();
```

Record only **whether the three differ** between Preview and Production, plus
each Supabase **project reference** from the dashboard URL. Report
`same` or `different`. Do not report the values.

```
Expected: DIFFERENT on all three, and two distinct project references.
```

**A `same` answer stops the beta here.** It means every preview build of every
pull request has been reading and writing production, and no later check in
this file may be run.

Then confirm, in the Vercel dashboard, that `DATABASE_URL` is **two entries**
— one Production-scoped, one Preview-scoped. A single entry covering both
scopes is one value, and is the shape that produced this question.

## 2. Schema initialization and migration verification

The schema comes from the repository, in this order, and from nowhere else:

```bash
# a. Deploy the branch to Preview, which runs initializeSchema() on first boot.
#    Then apply the convergent reconciler ONCE, authenticated, against PREVIEW:
curl -i -X POST "$BETA/api/migrate" -b "$COOKIE"
```

```
Expected: 200. A 405 means the call was made as GET.
          A 401/403 means the admin session is missing or lacks the permission.
```

```bash
# b. Verify every object the application reads unguarded.
psql "$PREVIEW_DB" -f scripts/verify-migrate.sql
```

```
Expected: ZERO non-OK rows.
```

```bash
# c. Confirm no schema-tracking ambiguity.
psql "$PREVIEW_DB" -tAc "SELECT id, status FROM schema_migrations ORDER BY id;"
```

```
Expected: convergent_api_migrate present. An EMPTY table means
          "not adopted into tracking", NOT "no migrations applied" —
          adopt it with docs/runbooks/migration-baseline-adoption.md
          before relying on any state claim.
```

**Do not apply `lib/__tests__/helpers/test-schema.sql`.** See rule 1.

## 3. Zero initial users

```bash
psql "$PREVIEW_DB" -tAc "SELECT count(*) FROM users;"
psql "$PREVIEW_DB" -tAc "SELECT count(*) FROM ledger_entries;"
psql "$PREVIEW_DB" -tAc "SELECT count(*) FROM transactions;"
```

```
Expected: 0, 0, 0.
```

A non-zero `users` count before anyone registers means either the fixture was
applied or a production dump was restored. Either one invalidates §1 and the
database must be rebuilt.

## 4. Create the synthetic participants through the application

Two accounts in the same currency, so the permitted P2P paths can be
exercised:

```bash
curl -i -X POST "$BETA/api/auth/register" -H 'content-type: application/json' \
  --form-string unused=unused -o /dev/null   # placeholder: see note
```

Use the **registration page in a browser** rather than curl, so the real
client path is what gets exercised. Emails under a domain you control or
`@example.test`.

```
Expected per account: 201 and a redirect to /feed, with a CA$100 / US$100
          opening balance AND a matching opening_balance ledger entry.
```

```bash
# The grant must be BOOKED, not just credited — this is the check that was
# failing before PR #83.
psql "$PREVIEW_DB" -tAc "
  SELECT u.username, u.balance_cad, u.balance_usd,
         (SELECT count(*) FROM ledger_entries l
           WHERE l.user_id = u.id AND l.entry_type = 'opening_balance')
  FROM users u ORDER BY u.id;"
```

```
Expected: exactly ONE opening_balance entry per account, and the sandbox grant
          present. Zero entries means MANNA_ENV is not 'sandbox' (production
          accounts correctly start at zero) or the grant was not booked.
```

**Note on the `auth:register` limit: 3/hour**, keyed on `clientIdentifier()`,
which collapses to **one global bucket** when no client IP header is present.
Several people behind one NAT share it, and the fourth signup inside an hour is
refused. Space the seeding out, or accept the refusals as expected rather than
reading them as a defect.

## 5. All five capability restrictions

First, read the profile **from the running deployment**. A variable somebody
believes they set is not evidence:

```bash
curl -s "$BETA/api/beta-profile" -b "$COOKIE" | python3 -m json.tool
```

```
Expected EXACTLY:
{
  "profile": "p2p_only",
  "restricted": true,
  "capabilities": {
    "funding": false, "cash_out": false, "cross_currency": false,
    "bank_linking": false, "external_fx": false
  }
}
```

**All five keys must be present and false.** A response carrying only the
first three is an **older deployment**, not a passing check: `bank_linking`
and `external_fx` were added 2026-11-18, and a three-key response means bank
linking and external FX are open on that build.

Then the refusals. Each must answer **403** with `"code":"BETA_RESTRICTED"`
and the stated `capability`:

```bash
r() { echo "--- $1"; shift; curl -s -o /tmp/b -w '%{http_code} ' "$@" -b "$COOKIE"; \
      python3 -c "import json,sys;d=json.load(open('/tmp/b'));print(d.get('code'),d.get('capability'))"; }

J='content-type: application/json'

r "funding"        -X POST "$BETA/api/transfers/intent" -H "$J" --form-string unused= \
                   --data '{"type":"add_money","amount":50,"currency":"CAD"}'
r "cash_out"       -X POST "$BETA/api/transfers/intent" -H "$J" \
                   --data '{"type":"cash_out","amount":50,"currency":"CAD"}'
r "bank_linking a" -X POST "$BETA/api/plaid/create-link-token"
r "bank_linking b" -X POST "$BETA/api/plaid/exchange-token" -H "$J" \
                   --data '{"public_token":"public-sandbox-x"}'
r "bank_linking c" -X POST "$BETA/api/stripe/setup-intent"
r "bank_linking d" -X POST "$BETA/api/stripe/confirm-setup" -H "$J" \
                   --data '{"setup_intent_id":"seti_x","bank_account_id":1}'
r "external_fx"    -X POST "$BETA/api/fx/quote" -H "$J" \
                   --data '{"amount":100,"fromCurrency":"CAD","toCurrency":"USD"}'
```

```
Expected: 403 BETA_RESTRICTED <capability> for all seven.
```

`cross_currency` needs two accounts in different currencies; with a
same-currency pair it is not reachable through the UI at all. Both forms:

```bash
# a. a NEW cross-currency payment
r "cross_currency new"    -X POST "$BETA/api/transactions" -H "$J" \
   --data '{"recipientUsername":"<us-account>","amount":10,"type":"payment"}'
# b. ACCEPTING a cross-currency request created BEFORE the restriction.
#    This is the bypass independent inspection found in PR #87 — it must be
#    tested separately, because gating (a) does not gate (b).
r "cross_currency accept" -X PATCH "$BETA/api/transactions/<id>" -H "$J" \
   --data '{"action":"accept"}'
```

### 5b. The negatives — what proves the restriction is SCOPED

A deployment where everything refuses is not contained, it is broken. All of
these must still work:

```bash
# same-currency payment
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BETA/api/transactions" \
  -H "$J" -b "$COOKIE" --data '{"recipientUsername":"<same-currency>","amount":10,"type":"payment"}'
# -> 201

# payment REQUEST, and DECLINING one (declining moves no money and is
# deliberately ungated, so a pre-beta request is not stranded)
# -> 201 / 200

# split payment  (single-currency by construction; no FX, nothing converted)
# -> 200

# same-currency FX quote (identity rate, contacts no provider)
curl -s -X POST "$BETA/api/fx/quote" -H "$J" -b "$COOKIE" \
  --data '{"amount":100,"fromCurrency":"CAD","toCurrency":"CAD"}' | head -c 120
# -> 200

# an INVALID currency is a bad request, not a restriction
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BETA/api/fx/quote" -H "$J" -b "$COOKIE" \
  --data '{"amount":100,"fromCurrency":"CAD","toCurrency":"EUR"}'
# -> 400, NOT 403

# reading linked accounts, and unlinking (unlinking only reduces exposure)
curl -s -o /dev/null -w '%{http_code}\n' "$BETA/api/bank-accounts" -b "$COOKIE"
# -> 200
```

### 5c. No participant operation reaches a provider, and the rails are off

```bash
# The live-rail flags must be ABSENT in every scope (Vercel dashboard).
# Any value other than 'true' is sandbox, but absence is the state to keep.
#   PLAID_TRANSFER_LIVE   -> absent
#   CA_EFT_LIVE           -> absent
# Also confirm no TEAM-level variable supplies either; a team variable is
# inherited silently.
```

The provider-reach claim is **negative**, so the honest evidence is
provider-side, not application-side:

```
- Plaid dashboard -> API activity for the beta window: ZERO requests.
- Stripe dashboard -> API logs for the beta window: zero banking calls.
  Stripe IDENTITY calls may appear, and that is expected and correct:
  kyc/create-session is deliberately ungated, and in sandbox it returns on the
  canAutoVerifyIdentity() branch BEFORE getStripe() is called, so it should
  show none either — but an Identity call is not a containment failure, a
  Transfer/ACSS/payout call is.
- Wise -> no quote activity for the beta window.
```

Then confirm `PLAID_SECRET` has been **removed from the Preview scope**. Until
it is, what stops a preview build reaching live Plaid is a *missing*
`PLAID_CLIENT_ID` — an accident, not a control. **Do not add the client id to
Preview**; that would point every PR's preview build at live Plaid with the
production secret.

## 6. The seven reconciliation checks

Run **after** §4 and §5b, so the checks have real rows to examine rather than
passing vacuously:

```bash
psql "$PREVIEW_DB" -f scripts/reconciliation-check.sql
```

```
Expected: all SEVEN rows PASS.
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET" "$BETA/api/cron/internal-reconciliation"
```

```
Expected: 200, with passed:true in the body.
```

Note `completed_internal_payments_in_scope` is a **scope counter hardcoded
`PASS`**, not an invariant — if it reports 0 the other checks passed over no
rows, which is not evidence. A FAIL here is a real signal again as of
2026-11-18 (PRs #82 and #83 fixed the two causes that made it fail
permanently). If `user_wallets_exactly_match_ledger` fails, suspect the CI
fixture first — see rule 1.

## 7. Redis connectivity and recovery

```bash
curl -s -X POST "$BETA/api/admin/operations/redis-rate-limit" -b "$COOKIE" \
  | python3 -m json.tool
```

```
Expected: a pass naming the redis backend.
          A 403 means the admin role lacks exceptions:manage (SuperAdmin or
          OperationsAdmin) — easy to MISREAD as Redis being down.
```

**One POST proves only the instance that served it.** `redisClient`,
`redisDownUntil` and the in-process counters are module-level, so they are per
serverless instance: another live instance can be counting in-process while
this one answers pass. Serverless instances cannot be addressed individually,
so repeated POSTs give **sampling confidence, not coverage**. Treating this as
VERIFIED requires monitoring the degradation signal, which nothing currently
scrapes — so record it as PARTIAL.

Confirm the two `REDIS_URL` entries (Production and Preview) point at
different instances. A shared Redis is a smaller problem than a shared
database — rate-limit counters, not money — but it is still shared state.

## 8. Desktop and mobile browser workflows

```bash
node scripts/e2e/sandbox-smoke.mjs --base "$BETA"
```

Run it twice: once at desktop viewport, once at a phone viewport.

```
Expected: 17 PASS / 1 FAIL / 1 N/A of 19, with the FAIL being ONLY the
          /feed?_rsc= 404 of §9.
```

The N/A is Plaid Link and Stripe.js blocked by the engineering environment's
egress proxy. On a real browser against Preview those scripts should load —
but **bank linking is withheld**, so the expected observation is the
"Bank linking unavailable in this beta" text and no Plaid Link iframe.

Check by hand, at both viewports, that the restriction is visible and not only
enforced:

```
- /profile shows "Bank linking unavailable in this beta" and NO
  "+ Link Account" control.
- /send to a different-currency recipient shows the cross-currency notice and
  requests NO FX quote.
- /transfers shows funding and cash-out as unavailable.
- Every form field has a usable label (19 label/control associations were
  added in PR #87).
- With /api/beta-profile BLOCKED in devtools, the interface still shows the
  restriction: both controls fail CLOSED on an unknown answer. This is the
  check for the defect fixed in this PR — previously a blocked profile request
  left "+ Link Account" live.
```

## 9. The unresolved `/feed?_rsc=` 404

This is a **known, accepted, unexplained** defect and it is not suppressed.
What is established: `/feed` itself returns 200; middleware sees neither the
RSC headers nor the `_rsc` query marker (both measured, so it cannot be fixed
there); two attempted fixes were reverted rather than shipped as dead code;
and the initiator could not be identified — CDP captured nothing across two
harnesses while a third reproduces it every run. An earlier attribution to a
login-page `Link` prefetch was **wrong**: no `<Link href="/feed">` exists
anywhere in the tree.

Against Preview, establish whether it reproduces and whether it matters:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BETA/feed" -b "$COOKIE"          # -> 200
curl -s -o /dev/null -w '%{http_code}\n' "$BETA/feed?_rsc=abc123" -b "$COOKIE"
```

If it reproduces, demonstrate the four negatives explicitly — this is what
turns "accepted" into a decision rather than a shrug:

```
1. NAVIGATION: every (app) route reachable by clicking, at both viewports.
2. AUTHENTICATION: the 404 does not clear the session; /api/me still 200s
   afterwards.
3. DATA INTEGRITY: run §6 again after exercising the UI — still 7/7 PASS.
4. SECURITY: the 404 body leaks no data, and the request is still subject to
   middleware auth (an UNauthenticated /feed?_rsc= must not return feed
   content — check it with no cookie jar).
```

If all four hold, record it as an accepted cosmetic defect **naming this
evidence**. If any fails, it is a blocker and the beta does not proceed.

---

## What a complete pass does and does not mean

A full pass establishes that the beta environment is isolated, provisioned
from the repository, restricted on all five capabilities, internally
consistent, and usable at both viewports.

It does **not** establish: independent validation of the claim/exposure
accounting model (decision 0012 — still outstanding, and the PR #87 merge
waived it for that decision only, which is not a pass through the gate);
decision 0013's funding capacity control (approved, unimplemented, blocked on
0012); any provider or regulatory approval; or any readiness for a live rail.
Decision 0010 sets permitted live throughput at **zero** as policy.

**The beta remains NO-GO until §1 through §9 have actually been run against
the isolated deployment and recorded with their outputs.** Writing this file
is not running it.
