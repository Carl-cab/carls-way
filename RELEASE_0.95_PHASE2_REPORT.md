# Release 0.95 — Phase 2 Security & Quality Remediation Report

**Branch:** `integration/release-0.95`
**Baseline:** Phase 1 integration at `b870055`
**Master:** unchanged at `62b4e15` (not merged)

---

## A. Integration Preservation

**The money-loop behaviour verified in Phase 1 is unchanged.** No payment,
settlement, or provider logic was rewritten to satisfy a static check.

Verified byte-identical to `master` (empty `git diff`):

| Area | Status |
|---|---|
| `lib/providers/CanadianEFTProvider.ts` (ACSS) | unchanged |
| `lib/providers/PlaidTransferProvider.ts` (US ACH) | unchanged |
| `components/PlaidLinkButton.tsx` | unchanged |
| `lib/settlement/SettlementExecutor.ts` | unchanged |
| `lib/ledger.ts` | unchanged |

Nothing prohibited was done: ACSS was not redesigned, the settlement model was
not changed, live providers were not enabled, the Stripe API version declaration
was not touched, provider semantics were not altered, transaction-state
behaviour was not modified, and the Phase 1 lockfile fix was not reverted.

**One deliberate behavioural change, required by Objective 2:** sandbox
deployments must now set `MANNA_ENV=sandbox`. This is the point of making
permissive behaviour an explicit opt-in rather than something inferred from a
missing credential. Documented in `.env.example`.

Three defects were fixed *in the implementation* because tests correctly caught
them. All three are in admin/reporting infrastructure, none in the money loop:
`COUNT(*)` string arithmetic, repository error re-wrapping, and the
correlation-ID contract.

---

## B. Security Fixes

### B1. KYC fail-closed (highest priority)

**Before:** `isStripeLive()` returned false when `STRIPE_SECRET_KEY` was absent
*or* was a `sk_test_` key, and the KYC route auto-verified on that branch.
Production losing its Stripe secret would have silently begun approving every
user's identity.

**After:** `lib/environment.ts` resolves the environment explicitly.

- Sandbox requires an exact `MANNA_ENV=sandbox` opt-in.
- Production is the default: unset, empty, and unrecognised values all resolve
  to production, so an unconfigured deployment fails closed.
- `VERCEL_ENV=production` overrides `MANNA_ENV`, so a production deployment
  target cannot be downgraded into permissive mode.
- A missing or malformed key raises `ConfigurationError` — never an environment
  signal. `NODE_ENV` is not a signal either.
- `isStripeLive()` was deleted, with a comment in `lib/stripe.ts` recording why
  credential-sniffing must not return.

The route gates auto-verification solely on `canAutoVerifyIdentity()` and calls
`assertKycProviderConfigured()` before the production path. Configuration
failure → 503; provider failure → 500. **Neither touches `kyc_status`.**

Audited every path able to set a user verified. Exactly two exist: the
sandbox-gated route branch, and the Stripe Identity webhook, which verifies the
signature before writing and scopes the write to the provider's session id
(`UserRepository.updateKycStatus` exists but has no callers).

### B2. Admin authentication and authorization

**Unguarded privileged mutation found.**
`/api/admin/ledger/backfill-opening-balances` was the one route under
`/api/admin` not using `withAdminAuth`. Its POST writes `ledger_entries` and was
gated only by `getAuthUser()` — *any authenticated customer* — plus a shared
header. Its GET was fully unauthenticated and disclosed configuration state.
Both now require an admin session **and** the `exceptions:manage` permission
(SuperAdmin/OperationsAdmin only), are audit-logged, and retain the shared
secret as a second factor. The SQL is untouched.

**Admin pages had no server-side authorization.** The console layout was a
client component, so protection depended on the client failing to fetch — not a
security boundary. `app/admin/layout.tsx` is now a server component that
resolves the session against the database and calls `notFound()` when
unauthorized. Build output confirms `/admin/*` moved from prerendered static
(`○`) to per-request server-rendered (`ƒ`). Unauthorized callers receive 404
rather than 401, so the console's existence is not disclosed before
authorization.

**Guards could drift.** Session resolution is extracted to
`resolveAdminBySessionId()`, the single source of truth used by both
`withAdminAuth` and the new `getServerAdmin()`. It fails closed on missing
session, inactive or locked account, and infrastructure error.

### B3. Middleware coverage

`proxy.ts` now gates `/admin/**` on the `admin_session` cookie — never the
customer `manna-token` — and carries a documented boundary map. Routes were
reviewed by category rather than blanket-protected:

| Surface | Authorized by | Rationale |
|---|---|---|
| Customer pages | `manna-token` JWT in middleware | unchanged |
| `/admin/**` pages | `admin_session` at edge + server-side DB check in layout | two independent layers |
| `/api/admin/**` | `withAdminAuth` + `requirePermission` in-route | needs per-route granularity and DB access the edge cannot provide |
| `/api/webhooks/**` | **provider signature** (Stripe `constructEvent`, Plaid JWKS `jwtVerify`) | user auth would break delivery and add nothing; deliberately excluded from the matcher |
| `/api/auth/**` | none | how a caller obtains credentials |

### B4. Other fail-open conditions found

1. **Stripe webhook acknowledged failures with HTTP 200**, so Stripe never
   redelivered and any event hitting an exception was lost permanently. Now
   returns 500 so the event is retried. Safe because the signature is verified
   first, `recordProviderEvent` is idempotent via
   `UNIQUE(provider, provider_event_id)`, and the KYC updates are idempotent by
   session id. Now consistent with the Plaid webhook. Signature failures still
   return 400 and are never retried.

2. **`/api/migrate` executed DDL with no authentication**, contradicting its own
   documented contract. Now requires an authenticated caller and writes an audit
   entry. Statements are idempotent and non-destructive, so this closes
   anonymous access without changing what the migration does.

3. **Database TLS** (introduced while enabling CI): `resolveSslMode()` requires
   TLS for absent, empty, malformed, unrecognised, and differently-cased values;
   only an exact `?sslmode=disable` relaxes it. Pinned by tests.

Swept and verified clean: no authorization or authentication error path returns
allow/continue; no missing-secret path selects a permissive mode; every route
using `getAuthUser` guards with 401. The only unauthenticated API routes are
`/api/auth/*`, `/api/dev/settlement-test` (404s when `VERCEL` is set), and
`/api/feed`, which filters to `privacy='public'` and exposes no private
transaction.

---

## C. Test Remediation

```
Previous: 53 failing
Current:   0 failing   (316 passing, up from 136 total)
```

Every failure was classified before being touched. **No skips. No weakened
assertions.**

| Cause | Count | Resolution |
|---|---|---|
| Environment (no `DATABASE_URL`) | 43 | `vitest.setup.ts` supplies a lazy-connect URL |
| Incorrect implementation | 3 | fixed in the implementation (below) |
| Fixture (missing FK rows) | — | real schema + seeds in `test-schema.sql` |
| Incorrect/obsolete test | 7 | wrong import path, stale allow-list, inverted assertion, Jasmine matcher, CJS require, abstract instantiation, NULL-vs-undefined |

**Implementation defects the tests correctly caught:**

1. **`COUNT(*)` returned as a string.** PostgreSQL `bigint` arrives as a string;
   the statistics APIs declared `number`. Found in `AuditLogRepository` and then,
   while removing `any`, in four more admin services where
   `(byStatus[x] || 0) + row.count` was doing string concatenation rather than
   addition. All coerce with `Number()` now.
2. **`BaseRepository.handleError` re-wrapped repository errors.**
   `RepositoryError` carries its own `code`, so the generic `error.code` branch
   matched first and converted every `NotFoundError`/`DuplicateKeyError` into a
   `TransactionError`, erasing error identity. The `instanceof` check now runs
   first.
3. **`sanitizeCorrelationId` had no contract** — see Objective 7 below.

The audit suite is now a genuine integration suite running against a real
PostgreSQL server, because a hand-written fake would have tested the fake.

### `sanitizeCorrelationId` contract

Specified and implemented in `lib/correlation.ts`:

| Aspect | Contract |
|---|---|
| Legal characters | `[A-Za-z0-9-_]`; everything else removed |
| Separators | runs of 2+ collapse to a single hyphen — removes `--` and stops `a--b`/`a-b` aliasing |
| Leading/trailing | trimmed |
| Max length | 255, with no trailing separator left by truncation |
| Whitespace / control / Unicode | removed |
| Empty / null / undefined | never returns empty; generates a fresh id |
| Normalization | idempotent |

Parameterised tests cover every case the objective lists.

---

## D. Typecheck

```
Previous: 22 errors (all in test files)
Current:   0 errors
```

Fixed by correcting types, not suppressing: `isValidCorrelationId`'s signature
widened to match its runtime behaviour; `assertFound` rebound through an
explicitly annotated call signature; `NODE_ENV` managed via vitest env stubs.

**No `as any`, `@ts-ignore`, or `@ts-nocheck` was added anywhere** (verified by
repository scan).

---

## E. Lint

```
Previous: 111 errors, 34 warnings
Current:    0 errors, 33 warnings   (exit code 0 — PASS)
```

No rule disabled, no `eslint-disable` added, no directory excluded. Each error
was resolved by giving the value its real type:

- 21 × `catch (error: any)` → `unknown` + typed narrowing (`lib/errors.ts`)
- statistics/DTO row types named honestly, which exposed defect (1) above
- `Record<string, any>` → `Record<string, unknown>` across masking, audit
  options, and the API client
- `require()` inside `RepositoryRegistry` → static imports
- admin UI `any` state → interfaces for the fields each card renders
- `GlobalSearch` called `setState` synchronously in an effect (React cascading
  render); empty-query results are now derived

33 `no-unused-vars` **warnings** remain. They do not fail lint and are recorded
as release-quality debt rather than silenced.

---

## F. CI

`.github/workflows/ci.yml`, on PRs and pushes to `master` and `integration/**`:

```
npm ci → prepare test schema → typecheck → lint → test → build
       → assert no live provider flag is enabled
+ separate job: npm audit --audit-level=high
```

Backed by a `postgres:16` service container so the audit suite runs for real.
`npm ci` is a real gate — it would have failed before Phase 1.
CI sets a throwaway `DATABASE_URL` only and deliberately leaves `MANNA_ENV`
unset so the KYC suite keeps exercising the fail-closed production default.

**The pipeline is green as of this commit**, so it can be made a required status
check immediately rather than landing red. It is not yet marked required — that
is a repository setting only the owner can apply.

---

## G. Financial Verification

**13/13 invariants PASS.** Re-verified by tracing routes, providers, database
operations and settlement behaviour — not by build status.

| # | Invariant | Evidence |
|---|---|---|
| 1 | ACSS intact | `git diff` vs master empty for ACSS files |
| 2 | Sandbox loop intact | stage-by-stage trace below |
| 3 | Sandbox never invokes live providers | `executeTransfer()` throws in both sandbox providers; zero non-sandbox callers of `settleSandboxTransfer` |
| 4 | Live flags off by default | both flags read only as literal `'true'`; double-checked in factory; none set anywhere |
| 5 | KYC auto-verifies only in sandbox | gated solely on `canAutoVerifyIdentity()`; 35 regression tests |
| 6 | Monetary changes atomic | `sql.begin` in all three money paths |
| 7 | Ledger integrity | `lib/ledger.ts` unchanged from master |
| 8 | Idempotency intact | `FOR UPDATE` + `status !== 'ready'` + `ON CONFLICT DO NOTHING`; `ALREADY_PROCESSED` double-accept guard |
| 9 | Webhook signature verification | Stripe `constructEvent` at offset 856 precedes first `UPDATE users` at 1312; Plaid JWKS `jwtVerify` intact |
| 10 | US Plaid settlement | provider and `SettlementExecutor` unchanged; webhook→orchestrator→executor chain present |
| 11 | No live transaction initiated | no provider network call made in this phase |
| 12 | Vercel config untouched | no change |
| 13 | Not merged to master | master still `62b4e15`; branch 26 commits ahead |

**Sandbox money loop** — register ($100 seed by country) → KYC (auto-verify
under `MANNA_ENV=sandbox`, verified true) → link bank (AES-256-GCM token) → add
money intent (requires `kyc_status='verified'` + encrypted bank account, mode
resolved from env) → confirm (both sandbox providers settle atomically, write a
ledger entry, mark `settled`) → send domestic/cross-border (Wise FX + ledger
pair) → receive → cash out (overdraw-guarded, `INSUFFICIENT_BALANCE` → 400).
All stages present and unchanged.

**ACSS: PASS. US Plaid: PASS. Idempotency: PASS. Webhook verification: PASS.
Settlement invariants: PASS.**

---

## H. Remaining Blockers

### CRITICAL SECURITY
None. All identified fail-open paths are closed.

### FINANCIAL
None. No money-loop regression; three latent arithmetic/error-identity defects
fixed.

### RELEASE QUALITY
1. **33 `no-unused-vars` lint warnings.** Non-blocking (exit 0); not silenced.
2. **CI not yet marked required.** Pipeline is green; enabling the branch
   protection rule is an owner action.
3. **`MANNA_ENV=sandbox` must be set** on every sandbox/dev deployment or KYC
   will correctly refuse to auto-verify. Documented in `.env.example`.

### PHASE 3 / FUTURE WORK
1. **Admin login and bootstrap lifecycle.** The boundary is enforced and fails
   closed, but no login route or first-admin bootstrap exists, so the console
   cannot yet be used. Explicitly out of scope this phase.
2. **`/api/migrate` should require an admin permission**, not merely
   authentication. Depends on (1).
3. **Canadian Stripe settlement is still a no-op** (`// Phase B2` placeholder).
   Out of scope by instruction.
4. **No `POST /api/transfers/[id]/execute`** — live transfers would stall at
   `ready`. Sandbox unaffected. Out of scope by instruction.
5. **`/api/feed` serves `privacy='public'` rows to anonymous callers.** No
   private data leaks, but "public" plausibly means public *within Manna*. A
   product decision, recorded rather than changed.

---

## I. Final Decision

```
READY FOR PHASE 2 MERGE
```

All mandatory acceptance criteria pass:

| Criterion | Result |
|---|---|
| `npm ci` | **PASS** |
| build | **PASS** |
| typecheck | **PASS** (0 errors) |
| lint | **PASS** (0 errors, exit 0) |
| tests | **PASS** (316/316) |
| KYC production | **FAIL-CLOSED** |
| Admin authorization | **ENFORCED** (edge + server + per-permission) |
| CI | **GREEN** |
| 13 invariants | **PASS** |
| Money loop | **PASS** |
| Live providers | **STILL DISABLED** |

Remaining items are release-quality or explicitly deferred scope, not security
or financial blockers. Merging is gated on human review plus the two owner
actions above (mark CI required; set `MANNA_ENV=sandbox` on non-production
deployments).
