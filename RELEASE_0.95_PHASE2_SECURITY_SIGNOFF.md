# Release 0.95 — Phase 2 Final Pre-Merge Security & Release Verification

**Branch:** `integration/release-0.95` @ `7e9e9be`
**Master:** `62b4e15` (untouched, not merged)
**Scope:** read-only verification

---

## 1. VERDICT

```
PASS — SAFE TO MERGE PHASE 2
```

No unresolved critical security vulnerability, authorization bypass, KYC
fail-open path, live-provider activation risk, financial integrity issue,
unauthenticated privileged operation, event-losing webhook path, or secret
exposure was found.

Two latent defects were found on the **live-provider execution path**. Both are
unreachable in Phase 2 (live flags disabled *and* no execute endpoint exists) and
are recorded as HIGH go-live blockers, not Phase 2 merge blockers.

---

## 2. ENVIRONMENT SECURITY

Verified empirically by loading `lib/environment.ts` and exercising twelve
configuration combinations, not by reading intent:

| Configuration | Environment | Auto-verify KYC | KYC config check |
|---|---|---|---|
| `MANNA_ENV=production` + valid `sk_live_` | production | **false** | ok |
| `MANNA_ENV` missing + valid key | production | **false** | ok |
| `MANNA_ENV=production`, no Stripe secret | production | **false** | **ConfigurationError** |
| `MANNA_ENV=production`, empty secret | production | **false** | **ConfigurationError** |
| `MANNA_ENV=production`, malformed secret | production | **false** | **ConfigurationError** |
| `MANNA_ENV=sandbox` | sandbox | true | ok (no credential needed) |
| `MANNA_ENV=dev` | production | **false** | ConfigurationError |
| `MANNA_ENV=SANDBOX_` | production | **false** | ConfigurationError |
| `MANNA_ENV=true` | production | **false** | ConfigurationError |
| `MANNA_ENV=sandbox` + `VERCEL_ENV=production` | **production** | **false** | ConfigurationError |
| `MANNA_ENV=sandbox` + `VERCEL_ENV=preview` | sandbox | true | ok |
| nothing set at all | production | **false** | ConfigurationError |

- **Production + valid credentials** → production behaviour only.
- **Production + missing/empty/malformed Stripe secret** → fails closed:
  `ConfigurationError` → HTTP 503, `kyc_status` untouched, no sandbox fallback,
  no live provider initialised with incomplete credentials, no fake provider.
- **Sandbox** requires the exact opt-in `MANNA_ENV=sandbox`.
- **Unknown / invalid / missing** → production → fail closed.
- **Conflict:** `VERCEL_ENV=production` overrides `MANNA_ENV=sandbox`; a
  production deployment target cannot be downgraded into permissive mode.
  `VERCEL_ENV=preview` + explicit sandbox stays sandbox, which is intentional.
- `NODE_ENV` is not an environment signal.

**No combination produces accidental permissive behaviour.**

---

## 3. LIVE PROVIDER AUDIT

**Conclusion: no path can accidentally activate Stripe live, Plaid live, or
live settlement.**

Provider selection is centralised. Live providers are instantiated in exactly
one file (`lib/providers/TransferProviderFactory.ts`, lines 26 and 38) and the
factory is called from exactly three server-side routes (transfer
intent / review / confirm). No client component participates.

Activation matrix, measured by executing the factory:

| Flag | Requested mode | US provider | CA provider |
|---|---|---|---|
| unset | sandbox | sandbox_us | sandbox_ca |
| unset | **live** (DB row claims live) | **sandbox_us** | **sandbox_ca** |
| `false` | live | sandbox_us | sandbox_ca |
| `1` | live | sandbox_us | sandbox_ca |
| `TRUE` | live | sandbox_us | sandbox_ca |
| `true` | live | plaid_transfer (live) | canadian_eft (live) |
| `true` | sandbox | sandbox_us | sandbox_ca |

- A **missing secret cannot enable live mode** — live is gated on the flag only,
  never on credential presence.
- A **test key cannot trigger live behaviour** — no code branches on key prefix
  (`isStripeLive()` was deleted in Phase 2).
- **Production cannot silently fall back to sandbox for KYC** (fails closed
  instead). Transfer routing does fall back to sandbox when a live flag is
  absent, which is the safe direction and is the intended go-live gate.
- **Sandbox cannot use live settlement:** `executeTransfer()` throws in both
  sandbox providers, and `settleSandboxTransfer` has **zero** callers outside the
  sandbox providers.
- **A compromised or incorrect `execution_mode='live'` database row cannot
  escalate** — the factory independently re-checks the environment flag.
- `toExecutionMode()` narrows strictly: only `'live'` maps to live; `'LIVE'`,
  `''`, `null`, `undefined`, `'prod'` all map to sandbox.
- Provider selection is server-side only; no `NEXT_PUBLIC_*` variable
  participates.

---

## 4. KYC AUDIT

**Every KYC failure mode is fail-closed.**

Exactly two code paths can set `kyc_status='verified'`:

1. `app/api/kyc/create-session/route.ts` — guarded solely by
   `canAutoVerifyIdentity()`, which consults the declared environment and never
   a credential. Exactly one `kyc_status = 'verified'` statement exists in the
   file and it sits inside that branch.
2. `app/api/webhooks/stripe/route.ts` — signature verified (`constructEvent` at
   offset 856) **before** the first state write (`UPDATE users` at offset 1312),
   scoped by `WHERE kyc_session_id = …`.

`UserRepository.updateKycStatus` exists but has **no callers**.

Traced request → validation → environment detection → provider call →
success/failure → database update:

- Provider errors → 500, no status mutation.
- Missing/malformed configuration → `ConfigurationError` → 503, no status
  mutation.
- Exceptions → the `catch` contains no `UPDATE users` and no `SET kyc_status`
  (asserted by test, matched on SQL verbs so prose comments cannot satisfy it).
- Production cannot enter sandbox verification implicitly (section 2).
- Schema default is `'pending'`, so a new user starts unverified.

No `finally` block, fallback, or default branch touches `kyc_status`.

**Remaining concern:** none.

---

## 5. ADMIN AUDIT

Every mutating API route was enumerated and its guard identified:

| Group | Count | Guard |
|---|---|---|
| `/api/admin/**` | 22 | `withAdminAuth` (all 22) |
| `/api/admin/ledger/backfill-opening-balances` | 1 | `withAdminAuth` **+ `requirePermission('exceptions:manage')`** |
| Customer routes (transactions, transfers, plaid, stripe, ledger, notifications, friends…) | 25 | `getAuthUser` + 401 guard |
| `/api/webhooks/*` | 2 | provider signature |
| `/api/auth/*` | 5 | intentionally public |
| `/api/dev/settlement-test` | 1 | 404 when `VERCEL` is set |
| `/api/feed` | 1 | public; filters `privacy='public'` |

- **`/admin` and `/admin/*` pages:** `app/admin/layout.tsx` is a server
  component that resolves the session against the database and calls
  `notFound()`. Every page renders through it. `proxy.ts` additionally gates the
  path at the edge on `admin_session` — never the customer `manna-token`.
- **Direct API bypass is prevented.** Authorization lives in the route handlers
  (`withAdminAuth` + `requirePermission`), not in the UI, so calling the API
  directly is subject to the same checks. A forged `admin_session` cookie passes
  only the cheap edge check; the layout's database lookup and every admin API
  still reject it.
- **`backfill-opening-balances`: the mutation itself is protected**, not merely
  the UI. `requirePermission('exceptions:manage')` is called inside the handler
  before any SQL, and `getAuthUser` (the previous any-customer check) is gone.
  Its GET, previously anonymous, is now equally guarded.
- **Session handling verified:** `findSession` enforces `expires_at > NOW()`;
  inactive and locked accounts are rejected; resolution fails closed on
  infrastructure error. `createSession` currently has **no callers**, so no admin
  session can be minted at all — the console is inert and unreachable, which is
  maximally fail-closed for this merge.

---

## 6. WEBHOOK AUDIT

| Property | Stripe | Plaid |
|---|---|---|
| Signature verified | `constructEvent` with `STRIPE_WEBHOOK_SECRET` | `jose` JWKS `jwtVerify` |
| Missing secret | 500, no processing | n/a |
| Missing/invalid signature | 400, never retried | rejected |
| Verification precedes state write | **yes** (856 < 1312) | **yes** (86 < 248) |
| Duplicate events safe | `UNIQUE(provider, provider_event_id)`; `recordProviderEvent` returns `false` on replay | same |
| Success | 200 | 200 |
| Genuine failure | **500 (retryable)** | **500 (retryable)** |

- **No false success remains.** A repository-wide scan of `catch` blocks under
  `app/api/webhooks/` found no `received: true`, `status: 200`, or
  `success: true`. The Phase 2 fix has not been reintroduced elsewhere.
- **Financial effects are idempotent at three independent layers** in
  `SettlementExecutor`: status transition returns idempotent success if already
  at target; ledger writes are guarded by
  `UNIQUE(transfer_intent_id, provider_event_id, entry_type)`; balance updates
  are guarded by `balance_processed_at`. A duplicate retry cannot double-apply.

---

## 7. FINANCIAL INTEGRITY

**Previously verified behaviour remains intact.** Diffed against `master`:

| Component | Result |
|---|---|
| ACSS (`CanadianEFTProvider`, `PlaidLinkButton`, `app/api/stripe/`) | **byte-identical to master** |
| Plaid (`PlaidTransferProvider`) | **byte-identical to master** |
| Settlement (`SettlementExecutor`, `SettlementProcessor`) | **byte-identical to master** |
| Ledger (`lib/ledger.ts`) | **byte-identical to master** |
| Balances | atomic; `sql.begin` in all 3 money paths; 2 overdraw guards each |
| Idempotency | `FOR UPDATE` + `status !== 'ready'` + `ON CONFLICT`; `ALREADY_PROCESSED` double-accept guard |
| Transaction state | unchanged |

**No file under `app/api/transactions/`, `app/api/transfers/`, `lib/providers/`,
`lib/settlement/`, `lib/ledger.ts`, or `lib/fx.ts` was modified anywhere in
Phase 2.**

Dual-write exposure reviewed (not redesigned, per instruction):

- **Sandbox settlement:** provider call and database write occur in a single
  transaction — no dual-write window.
- **Customer send / request-accept:** debit, credit and transaction insert are
  one transaction — no window.
- **Live `executeTransfer` (unreachable):** calls Plaid `transferCreate` and then
  writes `provider_reference_id`. If that write fails the provider has an
  in-flight transfer with no local reference. Recorded as HIGH.

---

## 8. TEST / BUILD RESULTS

```
npm ci:        PASS
Typecheck:     PASS (0 errors)
Lint:          PASS (exit 0 — 0 errors, 33 warnings)
Tests:         PASS (316 passed / 0 failed, 8 files)
Build:         PASS (compiled successfully, TypeScript clean)
13 invariants: PASS (13/13)
Money loop:    PASS (10/10 stages verified in code)
```

Test count is **316**, unchanged from the Phase 2 report — this audit added no
tests.

**Reproducibility note, reported rather than hidden:** the first regression run
showed 17 audit-suite failures. Cause was the verification sandbox's PostgreSQL
instance having stopped, not a code regression; after restarting it the suite
returned 316/316. This is expected — the audit suite is a genuine integration
suite requiring a live database, which CI supplies via its `postgres:16` service
container.

Invariant detail:

| # | Invariant | Evidence |
|---|---|---|
| 1 | ACSS intact | diff vs master empty |
| 2 | Sandbox loop intact | 10/10 stages traced |
| 3 | Sandbox never invokes live | 2/2 `executeTransfer` throw; 0 non-sandbox callers of `settleSandboxTransfer` |
| 4 | Live flags off by default | 4/4 checks require literal `'true'`; measured matrix in §3 |
| 5 | KYC sandbox-only | §4 |
| 6 | Atomicity | `sql.begin` in 3/3 money paths |
| 7 | Ledger integrity | `lib/ledger.ts` identical to master |
| 8 | Idempotency | 2 guards in sandbox settlement, 8 in executor |
| 9 | Signature verification | stripe True, plaid True |
| 10 | US Plaid settlement | provider + executor identical to master |
| 11 | No live transaction | no provider network call made |
| 12 | Vercel config untouched | no change |
| 13 | Not merged | master `62b4e15`; 27 ahead, 0 behind |

---

## 9. CHANGES MADE DURING THIS AUDIT

```
No code changes were required.
```

The working tree is clean and identical to `7e9e9be`. One temporary probe test
was created to measure the live-provider activation matrix and was removed after
use; it is not part of the branch.

---

## 10. REMAINING RISKS

### CRITICAL — blocks merge
None.

### HIGH — requires owner action
1. **CI is not yet a required status check.** The pipeline is green but branch
   protection is a repository setting only the owner can apply.
2. **`MANNA_ENV=sandbox` must be set on every non-production deployment.**
   Without it those deployments correctly refuse to auto-verify identity, and
   the sandbox money loop will stop at the KYC stage.
3. **Live `executeTransfer` does not send an idempotency key to the provider.**
   `idempotency_key` is generated and stored on the intent but is not passed to
   Plaid's `transferCreate`, and it is derived from `Date.now()`, so a retry
   produces a *new* key. If live were enabled, a retried execution could create a
   duplicate ACH transfer. Unreachable today (flags off, no execute endpoint);
   **must be fixed before go-live.**
4. **Live `executeTransfer` has a dual-write window** — provider call succeeds,
   then the database write records the reference. A failure between them leaves
   an untracked live transfer. Same reachability; **must be addressed before
   go-live.**

### MEDIUM — Phase 3
5. **Admin login and bootstrap do not exist.** `createSession` has no callers, so
   no admin can authenticate. The boundary is enforced and fails closed, but the
   console is unusable until this is built.
6. **`/api/migrate` requires authentication but not an admin permission** — see
   §5 and the boundary statement below. Depends on (5).
7. **Test-schema fidelity.** `lib/__tests__/helpers/test-schema.sql` defines
   `admin_sessions` with `ip_address`/`user_agent` and omits
   `token_hash TEXT NOT NULL`, whereas the production migration has `token_hash`
   and no such columns. No currently tested code path inserts sessions, so no
   test passes against a schema it would fail on in production — but the fixture
   should be aligned before session code is tested. Test-only; no production
   impact.
8. **Canadian Stripe settlement remains a no-op** (`// Phase B2` placeholder);
   financial Stripe events are recorded and marked processed without settlement.
   Out of scope by instruction.
9. **No `POST /api/transfers/[id]/execute`** — live transfers would stall at
   `ready`. Out of scope by instruction.

### LOW — future improvement
10. 33 `no-unused-vars` lint warnings (non-blocking, exit 0).
11. No regression test pins "a `execution_mode='live'` database row cannot
    activate a live provider". The property holds (measured in §3) but is not
    guarded against future refactoring.
12. The middleware rewrites unauthorized `/admin` requests to `/404`, and no
    `not-found.tsx` exists, so Next serves its built-in 404. The outcome is
    correct; the authoritative guard is the server layout regardless.
13. `/api/feed` serves `privacy='public'` rows to anonymous callers. No private
    data leaks; whether "public" should mean public to the open internet is a
    product decision.
14. `server-only` sits in `devDependencies`. Consistent with the existing setup —
    `tailwindcss`, `typescript` and `eslint-config-next` are also devDependencies
    required to build, and an `--omit=dev` install already fails on Tailwind — so
    this introduces no new risk.

---

## 11. `/api/migrate` — DOCUMENTED SECURITY BOUNDARY

| Question | Answer |
|---|---|
| Authentication required? | **Yes** — `getAuthUser()`, 401 otherwise |
| Authorization required? | **No admin permission** — any authenticated user |
| Reachable anonymously? | **No** |
| Executes DDL? | **Yes** — `CREATE TABLE` / `ALTER TABLE … IF NOT EXISTS` |
| Can GET change state? | **Yes** — it is a state-changing GET |
| Invokable without the UI? | Yes, by any authenticated caller |
| Header/shared-secret only? | No — no shared secret is used |
| Exposed in production? | Yes, but authenticated |

**Boundary as it stands:** authenticated-user-only access to idempotent,
non-destructive schema migration. Every statement is `IF NOT EXISTS`; a scan
found no `DROP`, `TRUNCATE`, or `DELETE FROM`. Each invocation writes an audit
entry. The pre-Phase-2 vulnerability — anonymous DDL execution — is closed.

Residual risk is that an ordinary customer account can trigger repeated
idempotent DDL (a mild resource-exhaustion vector), not schema damage or data
loss. That is a MEDIUM item, not a merge blocker. Hardening it to an admin
permission is deferred because it depends on the admin login lifecycle, which is
explicitly out of Phase 2 scope.

---

## 12. OWNER ACTIONS BEFORE MERGE

Both remain **outstanding**; neither was verified as complete, and I cannot
perform either:

1. **Configure the CI workflow as a required status check.** `.github/workflows/ci.yml`
   exists and is green, but branch protection is a repository setting.
   *Not verified as applied.*
2. **Set `MANNA_ENV=sandbox` on non-production deployments.** No deployment
   configuration was inspected or changed. *Not verified as applied.*

---

```
PASS — SAFE TO MERGE PHASE 2
```
