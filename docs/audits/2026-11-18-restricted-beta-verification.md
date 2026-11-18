# Restricted P2P-only internal beta — verification evidence

**Date:** 2026-11-18
**Baseline:** `master` at `c942ab0`; working branch `feat/restricted-p2p-beta`
**Method:** built the application, ran it against an isolated local PostgreSQL
database with `MANNA_ENV=sandbox`, registered synthetic participants, and used
it — HTTP against the real routes, a real browser, a real Redis instance.
**Immutable.** Later findings go in a new audit or a marked addendum.

No production database, credential, migration or configuration was touched. No
live rail was enabled. No beta invitation was sent.

---

## Summary against the owner's priorities

| # | Priority | Result |
|---|---|---|
| 1 | Isolated Preview environment | **Owner-blocked.** Checklist updated; two new provisioning requirements found |
| 2 | Server-enforced P2P-only restriction | **Done and verified**, including bypass attempts |
| 3 | Preserve the CA$100/US$100 grant + atomic ledger entry | **Verified intact** |
| 4 | Keep 0013 blocked | **Unchanged.** Not implemented, not waived |
| 5 | Remediation/quarantine plan from the read-only assessment | **Written**, unauthorized |
| 6 | Schema + 7 reconciliation checks on a fresh isolated DB | **7/7 PASS, cron HTTP 200** |
| 7 | `/feed?_rsc=` 404 | **Diagnosed; not fixable at the application layer.** Not suppressed |
| 8 | Browser workflows, Redis, reconciliation monitoring | **17/19 PASS, 1 N/A, 1 FAIL**; Redis fully verified |
| 9 | Readiness records | Updated to this commit |

---

## 2. The restriction, verified against a running deployment

Server started with `MANNA_ENV=sandbox` and **no `MANNA_BETA_PROFILE` set at
all**, which is the configuration a forgetful operator produces.

```
GET /api/beta-profile
{"profile":"p2p_only","restricted":true,
 "capabilities":{"funding":false,"cash_out":false,"cross_currency":false}}
```

Direct API bypass attempts:

```
POST /api/transfers/intent {"type":"add_money"}   403 BETA_RESTRICTED funding
POST /api/transfers/intent {"type":"cash_out"}    403 BETA_RESTRICTED cash_out
POST /api/transactions     CA -> US               403 BETA_RESTRICTED cross_currency
POST /api/transactions     CA -> CA               201  (unaffected)
```

Before this change the same three requests settled: measured in the previous
audit, CA$1,850 funded across five confirmations and a CA$500 cash-out
debited a balance.

**Why the default is fail-closed.** The profile resolves from
`MANNA_BETA_PROFILE`, but an absent or misspelled value in a **sandbox**
deployment resolves to `p2p_only`. Forgetting the variable leaves the beta
restricted rather than open. Lifting it requires an explicit
`MANNA_BETA_PROFILE=unrestricted`. Production is deliberately untouched — its
protection is the live-rail flags and decision 0010, and this control must not
be read as adding to those.

**Bypass surface tested beyond the happy path:** casing and whitespace variants
of `type`, body fields named after the environment variable
(`betaProfile`, `MANNA_BETA_PROFILE`), and a **pre-existing draft confirmed
after the restriction took effect**. Each case asserts not only the 403 but
that nothing downstream ran — no query, no FX quote, no velocity admission, no
transaction opened, `confirmTransfer` never called.

**Mutation-checked:** making sandbox opt-in instead of fail-closed fails 8
cases; removing the confirm gate fails 1; removing the cross-currency gate
fails 1.

### A route-ordering defect my own test caught

The intent gate originally sat **after** the user and bank-account lookups,
which made its own comment false and meant a withheld capability still cost
two queries. Body parsing and type validation now precede every database read,
and the test asserts the tagged template was never called. Recorded because the
comment was wrong before the code was.

### The interface

`/api/beta-profile` returns the same `betaRestrictionState()` the routes
enforce with, and both pages read it — a page that hid a button the API still
honoured would merely *look* controlled. The transfers page shows a plain
explanation and hides the form entirely rather than disabling it; the send page
refuses a cross-currency recipient before requesting an FX rate. Screenshot
captured; no broken state.

## 3. The registration grant is intact

Verified on the beta database: a CA registration produces `balance_cad`
100.00 with a matching `opening_balance` ledger entry, a US registration
produces `balance_usd` 100.00, and wallet equals ledger for every
application-created account. Unchanged by this work.

## 6. Schema and reconciliation on a fresh isolated database

```
scripts/verify-migrate.sql      0 non-OK rows
```

All seven checks, after a P2P send, a request-accept and a split payment:

```
completed_internal_payments_in_scope              3   0   PASS
internal_ledger_currency_debits_equal_credits     1   0   PASS
internal_ledger_entries_on_noncompleted_records   0   0   PASS
internal_payment_amounts_match_ledger             3   0   PASS
payer_recipient_direction_currency_and_type       3   0   PASS
payment_ledger_pair_cardinality                   3   0   PASS
user_wallets_exactly_match_ledger                10   0   PASS

GET /api/cron/internal-reconciliation -> HTTP 200, passed: true
```

### A provisioning requirement this exposed

The first run reported **3 violations** of `user_wallets_exactly_match_ledger`.
All three were `splitpayera`, `splitpayerb` and `velpayer` — accounts the **CI
test fixture** seeds with 500.00 and no ledger entries. Removing them (a real
beta database would never have had them) produced 7/7.

**`lib/__tests__/helpers/test-schema.sql` must not be used to provision the
beta database.** It is a test fixture: it seeds accounts with balances that no
ledger explains, which makes the reconciliation control fail before a single
participant signs up. The beta database must be built from
`initializeSchema()` plus `POST /api/migrate`. Added to the isolation runbook.

## 7. The `/feed?_rsc=` 404 — diagnosed, and not fixable here

Investigated properly this time, and the conclusion is negative.

**What it is.** Next's client prefetches `/feed` from the login page while the
visitor is signed out. The middleware redirects that prefetch; the browser
follows the redirect **without the RSC header** (redirects drop it) but with
the `_rsc` marker still in the URL, and that combination 404s. Captured in the
browser: `404 /feed?_rsc=<hash>`, `rsc: null`, `referer: /login`, on every run.

**Why it cannot be fixed in the middleware.** Two attempts, both measured:

1. Detect the prefetch by header. Compiled cleanly and did **nothing** — the
   branch was unreachable. Echoing the header names middleware can see returns
   exactly `accept, host, user-agent, x-forwarded-for, x-forwarded-host,
   x-forwarded-port, x-forwarded-proto`. **Next strips `RSC` and
   `Next-Router-Prefetch` before middleware runs.**
2. Detect it by the `_rsc` query marker. Also ineffective: a request for
   `/feed?dbg=1&_rsc=abc` arrives at middleware as `?dbg=1`. **Next strips the
   marker from the URL too.**

So the middleware cannot distinguish a prefetch from a navigation at all, and
**both changes were reverted** rather than shipped as dead code with a
confident comment.

**Impact:** none observed. Every page returns 200, every workflow passes, and
the failed prefetch simply falls back to a full navigation. It is one request
per login-page visit.

**The test still fails and was not suppressed.** 17 PASS / 1 FAIL / 1 N/A.

Options for the owner, none taken: upgrade Next and retest; remove the
prefetch on the login page's link to `/feed`; or accept it as cosmetic. The
last is defensible — it is a speculative request that fails and is retried
correctly.

## 8. Browser, Redis and monitoring

**Browser: 17 PASS / 1 FAIL / 1 N/A of 19.** All five mobile pages render at
iPhone-13 width with no horizontal overflow. The N/A is Plaid Link and
Stripe.js, blocked by this environment's egress proxy — reported as *not
verifiable here* rather than passed, because bank linking was never exercised.

**Redis — fully verified, which previous rounds could not do.** A real
`redis-server` was run on port 6380:

- *Connectivity:* keys written under `ratelimit:auth:login:<ip>:<email>`, so
  the shared backend is demonstrably in use rather than inferred from the
  variable being set.
- *Enforcement:* 401 × 5 then 429, per `client:email`.
- *Degradation:* Redis killed mid-flight — requests were still **served**
  (fail-open, as decision 0007 accepts), and one operator line appeared:
  `Rate limiter: Redis command failed, using in-process counters; shared limits
  are degraded to per-instance for up to 30000ms. degradation_count=1`. **No
  credential in it.**
- *Recovery:* Redis restarted, 30s cooldown waited out, new keys written again.
  It does **not** latch.

**Account lockout, found incidentally:** five failed logins set
`failed_login_attempts=5` and `locked_until`, after which the account answers
429 regardless of the limiter. That is the lockout working, and it is easy to
misread as a rate limit — noted because I misread it myself for one step.

**Monitoring remains the gap.** Nothing scrapes `rateLimitBackendHealth()`, so
a silent demotion to per-instance counting is still indistinguishable from
normal operation in production. Unchanged by this work.

---

## Environment constraints on this audit

- Vercel remains unreachable (`403 CONNECT`), so nothing here is evidence about
  Preview or production.
- Plaid Link and Stripe.js cannot load, so bank linking was not exercised. The
  restriction makes that moot for the beta — funding is disabled anyway.
- All results are from a local isolated database with synthetic accounts.
