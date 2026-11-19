# Audit — restricted-beta containment: external providers

**Date:** 2026-11-18
**Scope:** Section 3 of the owner's "PR #87 MERGE AUTHORIZATION AND BETA
CONVERGENCE" directive — disable unnecessary bank-linking and external
FX-provider operations in the restricted beta, verify direct API refusals,
confirm the profile does not permit provider execution, and verify production
access restrictions separately.
**Tree:** master at `71d7425` (the PR #87 merge) plus the working branch
described below.

This document is immutable. A later finding goes in a new audit.

---

## 1. What PR #87 left reachable

PR #87 withheld `funding`, `cash_out` and `cross_currency`. It did **not**
touch the routes that *talk to a provider*, and those are a different
question: a route can move no balance and still make a live call on a
participant's behalf.

Enumerated by grepping `app/api/**/route.ts` for `plaidClient`, `getStripe`,
`buildFxQuote` and `resolveFxRate`:

| Route | Provider | Before this change |
|---|---|---|
| `POST /api/plaid/create-link-token` | Plaid | reachable, ungated |
| `POST /api/plaid/exchange-token` | Plaid | reachable, ungated — exchanges a token, reads accounts, stores an encrypted access token, writes `bank_accounts` |
| `POST /api/stripe/setup-intent` | Stripe | reachable, ungated — creates an ACSS PAD SetupIntent |
| `POST /api/stripe/confirm-setup` | Stripe | reachable, ungated — stores a payment method |
| `POST /api/fx/quote` | Wise | reachable, ungated for a cross-currency pair |
| `POST /api/transactions`, `PATCH /api/transactions/[id]` | Wise | already gated by #87's `cross_currency` |
| `POST /api/kyc/create-session` | Stripe Identity | **reaches no provider in sandbox** — see §4 |
| `POST /api/webhooks/stripe` | Stripe | inbound, signature-authorized — see §4 |

Why this matters more than it looks. `PLAID_SECRET` is scoped **Production
and Preview** and holds the **production** secret (owner's 2026-11-17 audit).
What stops a preview build reaching live Plaid today is a *missing*
`PLAID_CLIENT_ID`, which is an accident rather than a control. So before this
change the honest statement about the beta was "preview probably cannot reach
Plaid", not "no participant action reaches Plaid".

## 2. What was changed

Two capabilities added to `lib/beta-restrictions.ts`:

- **`bank_linking`** — gates the two Plaid routes and both Stripe PAD-mandate
  steps. Each gate sits ahead of the body parse, the provider client and every
  query, and answers 403 `BETA_RESTRICTED` with `capability: 'bank_linking'`.
- **`external_fx`** — gates `POST /api/fx/quote` **only when the currency pair
  differs**. A same-currency quote short-circuits inside `buildFxQuote()` to
  the identity rate and contacts nobody, so refusing it would withhold
  something that is neither external nor cross-currency.

Placement decisions worth recording, each of which could reasonably have gone
the other way:

- The FX gate sits **after** the currency validation, so `toCurrency: "EUR"`
  answers **400** and not 403. A refusal that doubled as an input validator
  would tell a caller to wait for the beta to end instead of fixing the call.
- The Stripe `setup-intent` gate sits **before** the CA-only check, so a US
  caller gets 403 rather than a 400 reading "only available for Canadian
  users" — which would imply the beta would otherwise allow it.
- The gates **return** rather than throw. These handlers have an outer
  `try/catch` that answers 500, so a throw would be reported as a server
  fault.

The interface reflects it: `components/PlaidLinkButton.tsx` reads
`GET /api/beta-profile` — the same resolver the routes enforce with — and
renders "Bank linking unavailable in this beta" in place of the link control.
Unknown (`null`) claims nothing either way, so a failed fetch neither hides a
working button nor shows a control the API would refuse. **This is
presentation only.** The control is the 403.

## 3. Direct API refusals — verified at the handler

`lib/__tests__/beta-containment.test.ts`, 22 cases, calling the real route
handlers. Every refusal case asserts the status **and** that the provider
client was never touched, because a 403 returned after a Plaid or Stripe call
has already done the thing the containment statement denies.

Mutation-tested per gate. Each gate was individually neutered, the suite run,
and the file restored from a backup copy:

| Mutation | Result |
|---|---|
| FX gate removed | 1 failed |
| FX gate made over-broad (same-currency refused too) | 1 failed |
| Plaid `create-link-token` gate removed | 1 failed |
| Plaid `exchange-token` gate removed | 2 failed |
| Stripe `setup-intent` gate removed | 2 failed |
| Stripe `confirm-setup` gate removed | 1 failed |
| `bank_linking` dropped from the restricted set | 7 failed |
| `external_fx` dropped from the restricted set | 2 failed |

**A procedural error worth recording, because it nearly produced a false
result.** The first mutation pass used a helper that restored the tree with
`git checkout -- .`. That reverted all six gates after the first mutation, so
mutations two and three were measured against a tree with *no* gates at all
and reported "9 failed" — a number that looked like strong detection and
measured nothing about the gate named in its label. Only the first of that
pass's three results was valid. All edits were reapplied with asserted
anchors and the table above was measured again with per-file `cp` backups.
This is the second time in this session that `git checkout --` has destroyed
in-progress work; the lesson is to back up the single file being mutated, not
to clean the tree.

## 4. What is deliberately NOT contained

Recorded so a later reader does not "tidy it up", with the reason in each
case:

- **`GET /api/bank-accounts`** — read-only. A participant may still see what
  is on file.
- **`DELETE /api/bank-accounts`** — unlinking only **reduces** exposure.
  Gating it would trap an already-linked account inside the beta, which is the
  opposite of containment. Same reasoning as leaving request `decline`
  ungated.
- **A same-currency FX quote** — neither external nor cross-currency.
- **`POST /api/kyc/create-session`** — in sandbox, `canAutoVerifyIdentity()`
  is `isSandboxEnvironment()`, and on that branch the route marks the user
  verified and **returns before `getStripe()` is called**. So a sandbox beta
  deployment makes no Stripe Identity call, and the containment claim holds
  for it without a gate. Not gated on purpose: identity verification is
  neither bank linking nor FX, participants may need it, and restricting it
  would be a scope decision the owner has not made.
- **`POST /api/webhooks/stripe`** — inbound. Stripe calls it, not the reverse,
  and it is authorized by signature verification rather than by the user
  session the profile applies to.

Each of these is asserted, not merely asserted-about: the suite includes
positive cases for the bank-account list, the unlink, and the same-currency
quote. A deployment where everything refuses is not contained, it is broken.

## 5. The profile cannot permit provider execution

Asserted with the profile at its **most permissive** value, which is the
version of this claim that can fail:

- `MANNA_BETA_PROFILE=unrestricted` with `PLAID_TRANSFER_LIVE` and
  `CA_EFT_LIVE` unset → `resolveExecutionMode()` returns `sandbox` for both
  regions, `getProviderByCountry()` returns providers whose `executionMode` is
  `sandbox`, and `executeTransfer()` **throws** on both.
- The same holds for `p2p_only` and `unrestricted` alike, pinned in a loop, so
  wiring the profile into provider selection fails a test.

The separation is the point and is worth stating plainly: **the beta profile
is not what keeps a live rail off.** That is `PLAID_TRANSFER_LIVE` /
`CA_EFT_LIVE` and decision 0010's zero permitted throughput. Nothing in this
change adds to those, and nothing here should be quoted as if it did.

## 6. Production access restrictions — verified separately

Verified as its own group of cases, because a beta control that silently
started refusing bank linking or FX in production would be a regression
dressed as a safety feature:

| Environment | `POST /api/plaid/create-link-token` | cross-currency FX quote |
|---|---|---|
| `MANNA_ENV` absent (production) | **200**, Plaid called once | **200**, provider called once |
| `MANNA_ENV=sandbox` + `VERCEL_ENV=production` | **200** | not retested; same resolver |
| `MANNA_ENV=sandbox` (beta) | **403** `bank_linking` | **403** `external_fx` |
| `MANNA_BETA_PROFILE=p2p_only` in production | **403** | not retested; same resolver |

The last row is the escape hatch in the other direction, pinned because it is
otherwise surprising, and it is **not** a recommendation.

## 7. Static guards, and what they are not

`lib/__tests__/beta-restriction-coverage.test.ts` now walks every route
**twice** — once for money markers, once for provider markers — and requires
each match to reference `beta-restrictions` or carry a written reason of at
least 80 characters in an allowlist. The provider allowlist is additionally
checked in both directions: an entry naming a route that no longer exists
fails, and so does an entry excusing a route that no longer reaches a
provider.

Mutation-tested:

| Mutation | Result |
|---|---|
| ungated provider-reaching probe route added | 1 failed, naming the route |
| provider-allowlist entry for a route that reaches no provider | 1 failed, naming the entry |

**These guards are not evidence of runtime enforcement**, and the owner's
directive says so explicitly. They read source text, so a route that imported
`beta-restrictions` and never called it would satisfy them. They exist to make
a *new* money-moving or provider-reaching route impossible to add without
someone deciding what the profile does about it. The runtime evidence is §3,
§5 and §6.

## 8. Verification at this commit

| Check | Result |
|---|---|
| `pnpm test` | see the merge commit for this branch; measured on a database created fresh with the CI fixture applied |
| `pnpm run typecheck` | **0 errors** |
| `pnpm run lint` | **0 errors**, 29 pre-existing unused-variable warnings |
| `beta-containment.test.ts` | **22 / 22** |
| `beta-restriction-coverage.test.ts` | **6 / 6** (was 4) |

## 9. What this audit does NOT establish

- **Nothing was verified against a deployment.** Every result above is from
  the local handlers and the test database. The runbook boxes for the running
  Preview deployment remain unticked, and this document does not tick them.
- **Preview database isolation is still unresolved** (owner-blocked on a
  separate Supabase project), so no transactional testing has run against
  Preview.
- `PLAID_SECRET` is **still scoped to Preview** with the production value.
  This change means no beta route will use it; removing it from Preview is a
  production configuration change and remains the owner's.
- No production database, credential, migration or configuration was touched.
  No live rail was enabled. No beta invitation was sent.
- Not independently reviewed — this session authored it.

---

# ADDENDUM — 2026-11-19: three defects found by reviewing this change

**Explicitly marked as an addendum, not an edit.** The sections above record
what was measured on 2026-11-18 and stand unaltered. This addendum records
what a review of the same change found afterwards, and what was done about it.

The review was run at the owner's request on PR #88 at head `7dba34a`, after
all four required GitHub checks had passed green on that commit. **Green checks
did not find any of these**, which is the point worth keeping: the suite, the
typecheck, the lint, the dependency audit and CodeQL were all satisfied by code
containing all three.

**This was not an independent review.** It was run by the change's own author
over the author's own diff. It is evidence, and it is not the independent
accounting validation decision 0012 requires.

## Finding 1 — the interface told production users about a beta that does not exist

`components/PlaidLinkButton.tsx`. The fail-closed fix folded a **failed**
profile request into the same state as a **withheld** capability, and that
state renders "Bank linking unavailable in this beta".

In production there is no beta: `bank_linking` resolves available, so the only
way the component reaches a non-available state there is a failed request. A
transient network blip or a 401 from a cookie refreshed mid-flight therefore
told a production user their bank linking was restricted by a beta — and the
effect had an empty dependency array, so there was no retry and no re-fetch.
The only way out was reloading the page.

The fail-closed *decision* was correct and is unchanged. The defect was the
wording and the absence of a way back.

**Fixed:** four states — `pending`, `available`, `withheld`, `unknown` — where
`withheld` and `unknown` fail closed identically but say different things, and
`unknown` offers a Retry that re-runs the fetch through a `profileAttempt`
counter. Pinned statically, because the distinction is about rendered copy
rather than a decision function: the guard requires the `catch` to resolve to
`'unknown'` and requires the retry to exist. Mutation: folding `unknown` back
into `withheld` fails 1.

## Finding 2 — a malformed amount reported a beta restriction

`app/api/fx/quote/route.ts`. The gate sat above `parsePositiveMoney()`, so
`{"amount":"abc","fromCurrency":"CAD","toCurrency":"USD"}` answered **403
BETA_RESTRICTED** where it had previously answered 400. The caller was told to
wait for the beta to end when their request was simply malformed.

The gate's own comment claimed that placing it after the currency validation
kept input validation answering 400. That was true for an invalid *currency*
and false for an invalid *amount* — a comment that was half right, which is
worse than a missing one.

**Fixed:** `parsePositiveMoney()` now runs **before** the gate. It contacts
nobody, so there was never a containment reason to gate ahead of it. A new case
pins 400 for a malformed amount on a cross-currency request, and also asserts
the provider was still not called. Mutation: moving the gate back above that
line fails 1.

## Finding 3 — the profile read was cacheable

Neither component passed `cache: 'no-store'`, and `app/api/beta-profile/route.ts`
sets no cache headers. A heuristically cached 200 could keep rendering a
control after the profile had been tightened.

Impact is cosmetic — the route still answers 403, so containment holds — but it
reintroduces exactly the UI/server mismatch the one-resolver rule exists to
prevent, in the direction that matters: a page looking **less** restricted than
the server is.

**Fixed:** both reads pass `cache: 'no-store'`, pinned by a guard over both
files. Mutation: removing it from either fails 1.

## What this addendum does not change

Everything in §1–§9 above was measured as stated. The containment claim is
unchanged: all five capabilities withheld, every gate ahead of its provider
client, the permitted paths still working, production unrestricted, and the
profile unable to enable a rail. Nothing here has been verified against a
running deployment, and the beta remains NO-GO pending infrastructure
isolation.
