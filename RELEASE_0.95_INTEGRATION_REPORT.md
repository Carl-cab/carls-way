# Release 0.95 — Phase 1 Integration Report

**Branch:** `integration/release-0.95`
**Base:** `origin/master` @ `62b4e15`
**Date:** 2026-08-18
**Scope:** Establish one safe integration baseline. No new product features.

---

## 1. Executive Status

### **SAFE WITH BLOCKERS**

`integration/release-0.95` is a coherent, reviewable baseline. It preserves master's
Canadian ACSS and live-provider work, imports the sandbox money loop and admin
infrastructure, builds cleanly, and violates none of the thirteen invariants.

It is **not** merge-ready to `master` because of four blockers, none of which affect
the sandbox money loop: a lint regression (111 errors, all in imported admin code),
53 pre-existing admin test failures, 22 type errors inside test files, and a KYC
fail-open risk if `STRIPE_SECRET_KEY` is absent in a production deployment.

No stop condition was triggered. ACSS did not conflict with the feature-branch
settlement model, no migration is destructive, ledger semantics are identical
across branches, and no credential or customer financial data exposure was found.

---

## 2. Branch Reconciliation Table

Merge-base of `master` and `claude/cool-cerf-ErxD3` is `68cfbc6`. Divergence:
master +6 commits, feature branch +14 commits. **Only three files were modified on
both sides.**

| Area | Branch | Commit(s) | Files | Functionality | Duplicated elsewhere? | Relative age | Source of truth | Risk | Action |
|---|---|---|---|---|---|---|---|---|---|
| Stripe ACSS bank linking | master | `62b4e15` | `components/PlaidLinkButton.tsx`, `app/(app)/profile/page.tsx`, `app/api/stripe/*` | CA pre-authorized-debit setup intent flow | No | Newer | **master** | Low | Preserved verbatim |
| Live providers | master | `9085392` | `PlaidTransferProvider.ts`, `CanadianEFTProvider.ts` | US ACH + CA ACSS execution | No | Newer | **master** | Low | Preserved byte-identical |
| Phase C1 schema | master | `9085392` | `app/api/migrate/route.ts` | `plaid_account_id`, `stripe_payment_method_id`, `stripe_customer_id` | No | Newer | **master** | Med (only true conflict) | Union-merged |
| Stripe API version | master | `62b4e15` | `lib/stripe.ts` | `apiVersion '2026-06-24.dahlia'` | Conflicting decl vs SDK | Newer | **master** (decl kept; SDK pinned to match) | Med | SDK pinned `~22.3.2` |
| Sandbox settlement | feature | `58b8867` | `lib/providers/sandbox-settlement.ts`, both sandbox providers | add_money credits / cash_out debits + ledger entry | No | Newer | **feature** | Low | Imported |
| Atomic P2P | feature | `84204ef` | `app/api/transactions/route.ts`, `[id]/route.ts` | Transactional debit/credit, overdraw + double-accept guards | No | Newer | **feature** | Low | Imported |
| KYC sandbox gate | feature | `170d8fb` | `lib/stripe.ts`, `kyc/create-session`, profile page | `isStripeLive()`; auto-verify only when not live | **Yes — `kyc-sandbox-verify` is an exact patch-id duplicate** | Same | **feature** | Low | Imported once; kyc branch redundant |
| RBAC / audit / repositories | feature | `52f9702`, `81fd29b`, `49d1037`, `b459cbe` | `lib/rbac/*`, `lib/repositories/*`, `lib/services/*`, `app/api/admin/*` | Admin authz, immutable audit, repository pattern | No | Newer | **feature** | Med (lint/test debt) | Imported |
| Operations Console UI | feature | `25826ea` | `app/admin/*` | 8 admin pages | No | Newer | **feature** | Low | Imported |
| Correlation IDs | feature | `953601b` | `lib/correlation*.ts`, migrate | Request tracing across lifecycle | No | Newer | **feature** | Low | Imported |
| Provider routing / go-live gating | go-live-prep | `3d87e84` | `TransferProviderFactory.ts`, `router.ts`, 3 transfer routes | `resolveExecutionMode()`, `toExecutionMode()` | No | Newest | **go-live-prep** | Low | Imported |
| KYC branch | kyc-sandbox-verify | `0410082` | 3 files | — | **Fully contained in feature branch** | — | n/a | None | **Not merged — redundant** |

### Branch disposition

| Branch | Disposition | Evidence |
|---|---|---|
| `master` | Fully preserved | Live providers + PlaidLinkButton byte-identical (`git diff` empty) |
| `claude/cool-cerf-ErxD3` | Merged | commit `0c1abaf` |
| `go-live-prep` | Merged | commit `d4dade2` |
| `kyc-sandbox-verify` | **Not merged — redundant.** Identical patch-id to `170d8fb`; zero diff against integration branch for all three files | verified |

---

## 3. Conflicts Encountered and Resolution

Resolution was performed at feature level. No branch was taken wholesale.

**3.1 `app/api/migrate/route.ts` — the only true merge conflict**
Both sides appended migration statements to the same region. Master added Phase C1
live-provider columns; the feature branch added correlation-ID columns and the admin
RBAC table set. **Resolution: kept both, master's block first.** Justified because
every statement on both sides is `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT
EXISTS` — verified by scanning both branches for `DROP`/`TRUNCATE`/`DELETE FROM`/
`ALTER COLUMN ... TYPE`/`SET NOT NULL`/`RENAME` (zero matches). Order is irrelevant
as the statements are independent and idempotent.

**3.2 `lib/stripe.ts` — auto-merged, verified by inspection**
Master changed `apiVersion`; the feature branch added `isStripeLive()` in a
different region. Both retained. Both are required: the API version for ACSS, the
gate for KYC sandbox behavior.

**3.3 `app/(app)/profile/page.tsx` — auto-merged, verified by inspection**
Master replaced the placeholder link button with `<PlaidLinkButton>` (line ~263);
the feature branch added the sandbox-KYC in-place refresh (line ~82). Non-adjacent;
both retained.

**3.4 `app/api/transfers/[id]/confirm/route.ts` — auto-merged, verified by inspection**
Touched by both the feature branch (INSUFFICIENT_BALANCE → HTTP 400) and
go-live-prep (persisted `execution_mode` + `toExecutionMode()` narrowing). The union
is correct and both are present.

**3.5 Stripe SDK version — cross-branch conflict resolved without behavior change**
Master declares `apiVersion: '2026-06-24.dahlia'`, but the `stripe` SDK exposes
`apiVersion` as a single string literal fixed per release, and `^22.2.1` resolved to
`22.2.1` (which pins `2026-05-27.dahlia`) → hard `TS2322`. Empirically mapped:

| stripe | pinned API version |
|---|---|
| 22.2.1 – 22.2.2 | `2026-05-27.dahlia` |
| **22.3.0 – 22.3.2** | **`2026-06-24.dahlia`** ← matches master |
| 22.4.0 – 22.5.0 | `2026-07-29.dahlia` |

**Resolution: pinned `"stripe": "~22.3.2"`.** The API-version *declaration* was
deliberately left unchanged — altering the version a payment integration negotiates
is a behavioral change, not a build fix. No `as any`, no `@ts-ignore` anywhere.

---

## 4. Functionality Preserved From Master

Verified by `git diff origin/master HEAD -- <path>` returning empty:

- `lib/providers/PlaidTransferProvider.ts` — US live ACH, byte-identical
- `lib/providers/CanadianEFTProvider.ts` — CA live ACSS/EFT, byte-identical
- `components/PlaidLinkButton.tsx` — ACSS bank-linking UI, byte-identical
- `app/(app)/profile/page.tsx` — PlaidLinkButton integration retained
- `lib/stripe.ts` — `apiVersion '2026-06-24.dahlia'` retained
- `app/api/migrate/route.ts` — all three Phase C1 columns retained
- Untouched by either branch and carried over unchanged: `lib/db.ts`,
  `lib/ledger.ts`, `lib/provider-events.ts`, `lib/settlement/SettlementExecutor.ts`,
  `app/api/webhooks/stripe/route.ts`

**Invariant 1 (ACSS intact): SATISFIED.**

---

## 5. Functionality Imported

**From `claude/cool-cerf-ErxD3`:** sandbox settlement (`sandbox-settlement.ts`);
atomic P2P send and request-accept; cross-border FX preview fix (`/api/users` now
honours `search` and returns `country`); KYC sandbox gate; correlation-ID
infrastructure; repository pattern; RBAC; immutable audit logging; 7 admin services
+ ~30 admin API routes; 8-page Operations Console; `OPERATIONS_MANUAL.md`; test
suite; `TransferProvider.ConfirmResult.new_balance` (additive optional — master's
live providers still satisfy the interface).

**From `go-live-prep`:** `resolveExecutionMode()` / `toExecutionMode()`; execution
mode persisted at intent creation and re-read at review/confirm;
`GO_LIVE_RUNBOOK.md`.

**From `kyc-sandbox-verify`:** nothing — redundant.

---

## 6. Sandbox Money-Loop Verification

Traced through code. **The build passing is not treated as evidence.**

| Stage | Route | Service / Provider | DB operation | Settlement behavior | Status |
|---|---|---|---|---|---|
| Register | `POST /api/auth/register` | — | `INSERT users` | `balance_cad=100` if CA, `balance_usd=100` if US (`register/route.ts:46-47`) | ✅ |
| KYC | `POST /api/kyc/create-session` | `isStripeLive()` | `UPDATE users SET kyc_status='verified', kyc_provider='sandbox'` | Auto-verify **only** when not live; live key → real Stripe Identity | ✅ |
| Link bank | `POST /api/plaid/exchange-token` | Plaid + `encryptToken` | `INSERT bank_accounts` (`is_token_encrypted=true`) | AES-256-GCM at rest; ACSS path via `PlaidLinkButton` | ✅ |
| Add money — intent | `POST /api/transfers/intent` | `resolveExecutionMode` → `getTransferProvider` | `INSERT transfer_intents` (persists `execution_mode`) | Requires `kyc_status='verified'` + encrypted bank account | ✅ |
| Add money — review | `GET /api/transfers/[id]/review` | provider re-selected from stored `execution_mode` | `SELECT` | Region-correct consent language | ✅ |
| Add money — confirm | `POST /api/transfers/[id]/confirm` | `Sandbox{US,CA}Provider.confirmTransfer` → `settleSandboxTransfer` | `sql.begin` → `SELECT … FOR UPDATE` → `UPDATE users` → `INSERT ledger_entries` → `UPDATE transfer_intents status='settled'` | Credits balance; single atomic transaction | ✅ |
| Send (domestic) | `POST /api/transactions` | `createLedgerPair` | `sql.begin`: guarded debit → credit → `INSERT transactions` | Instant, fee-free, same currency | ✅ |
| Send (cross-border) | `POST /api/transactions` | `buildFxQuote` → `createCrossBorderLedgerPair` | same transaction | Live Wise rate + 0.5% fee; recipient credited in own currency | ✅ |
| Wise FX | `lib/fx.ts` | Wise API + 5-min DB cache | `fx_rates` upsert | Falls back to static rates if Wise unreachable | ✅ |
| Receive / request-accept | `PATCH /api/transactions/[id]` | ledger pair helpers | `sql.begin`: guarded debit → credit → conditional status update | `ALREADY_PROCESSED` guard prevents double-pay | ✅ |
| Cash out | `POST /api/transfers/[id]/confirm` | `settleSandboxTransfer` | same as add money, debit direction | Overdraw-guarded; `INSUFFICIENT_BALANCE` → HTTP 400 | ✅ |
| Ledger | `lib/ledger.ts` | — | `INSERT ledger_entries` | Every movement recorded; `ON CONFLICT DO NOTHING` on `(transfer_intent_id, provider_event_id, entry_type)` | ✅ |

**Invariant 2 (complete sandbox loop): SATISFIED.**

---

## 7. Financial Invariants Reviewed

| # | Invariant | Verification | Result |
|---|---|---|---|
| 1 | ACSS intact | `git diff` empty for ACSS files | ✅ |
| 2 | Sandbox loop intact | §6 code trace | ✅ |
| 3 | Sandbox never invokes live providers | `executeTransfer()` throws in both sandbox providers; `settleSandboxTransfer` referenced only by sandbox providers (grep: zero other callers) | ✅ |
| 4 | Live flags off by default | `resolveExecutionMode` returns `live` only on literal `'true'`; `getTransferProvider` independently re-checks; no assignment/default anywhere | ✅ |
| 5 | KYC auto-verify only in sandbox | `isStripeLive()` requires `sk_live_` prefix | ⚠️ **See Blocker B4** |
| 6 | Monetary changes atomic | `sql.begin` in `sandbox-settlement.ts`, `transactions/route.ts`, `transactions/[id]/route.ts` | ✅ |
| 7 | Ledger integrity | `lib/ledger.ts` unmodified by either branch; all paths write entries | ✅ |
| 8 | Idempotency intact | `FOR UPDATE` + `status !== 'ready'` guard; `ON CONFLICT DO NOTHING`; `ALREADY_PROCESSED`; provider-event dedup untouched | ✅ |
| 9 | Webhook signature verification | Stripe: `stripe-signature` + `STRIPE_WEBHOOK_SECRET`; Plaid: `jose` JWKS `jwtVerify` — both unmodified | ✅ |
| 10 | US Plaid settlement intact | `TRANSFER/STATUS_UPDATE` → `SettlementOrchestrator` → `SettlementExecutor` present | ✅ |
| 11 | No live transaction initiated | No network call to any provider made during this phase | ✅ |
| 12 | Vercel config untouched | No `vercel.json`/env change | ✅ |
| 13 | Not merged to master | `master` unchanged at `62b4e15` | ✅ |

Live providers were additionally confirmed never to mutate balances
(`grep "UPDATE users SET balance"` → zero matches in both live providers).

---

## 8. Build, Lint, Typecheck, Test Results

| Check | Command | Result |
|---|---|---|
| Clean install | `npm ci` | ✅ **PASS** (was broken on master — see B1) |
| Typecheck | `npm run typecheck` | ⚠️ 22 errors — **0 outside `lib/__tests__`** |
| Lint | `npm run lint` | ❌ 111 errors, 34 warnings (master baseline: **0 errors**, 6 warnings) |
| Production build | `npm run build` | ✅ **PASS** — compiled + TypeScript clean, 30 admin routes emitted |
| Tests | `npm test` | ⚠️ 136 tests: **83 pass, 53 fail** |
| Merge markers | grep | ✅ none |
| Live flags enabled | grep | ✅ none (reads only) |
| Hard-coded secrets | grep | ✅ none (only `sk_live_…` doc placeholders) |
| Destructive migrations | grep | ✅ zero `DROP`/`TRUNCATE`/`DELETE FROM` |

**Test failures are pre-existing, not integration-caused** — proven by
`git diff origin/claude/cool-cerf-ErxD3 HEAD -- lib/rbac lib/repositories lib/__tests__ lib/correlation.ts`
returning empty. They had never run before because no runner was installed. All 53
are in RBAC / audit / repository / correlation code. **No money-loop test fails.**

---

## 9. Remaining Blockers

**B1 — Lockfile desync (FIXED this phase).** `package.json` on master listed
`@stripe/*` deps absent from `package-lock.json`, so `npm ci` failed with EUSAGE —
any CI would have been unable to install. Lockfile regenerated.

**B2 — Lint regression: 111 errors.** Master is lint-clean; every error arrives with
the imported admin layer (`lib/services` 7 files, `lib/rbac` 5, `lib/repositories` 3,
`app/api/admin/*`, `app/admin/components`), overwhelmingly
`@typescript-eslint/no-explicit-any`. Deliberately **not** masked: suppressing the
rule or adding `any` casts would defeat the purpose. No money-loop file is affected.

**B3 — 53 failing tests / 22 type errors inside test files.** Pre-existing feature-branch
defects: assertions against exports that do not exist (`maskSensitiveFields`,
`maskArray`), a non-existent `toHaveSize` matcher, `null` passed to non-nullable
params, and a CJS `require()` of a `.ts` module. One notable behavioral gap —
`sanitizeCorrelationId` permits `--`, which its own test rejects. Not exploitable
(correlation IDs only reach the DB through postgres.js parameterized tagged
templates), but the implementation does not meet its documented contract.

**B4 — KYC fail-open if `STRIPE_SECRET_KEY` is unset (design risk).**
`isStripeLive()` infers sandbox from the *absence* of a live key, so a production
deployment missing the variable would silently auto-verify every user — a compliance
failure. Current behavior satisfies invariant 5 as written (a real live key never
bypasses KYC), so this is recorded rather than changed: altering it is a business-logic
decision. Recommended hardening: require an explicit positive signal (e.g.
`MANNA_SANDBOX_MODE=true`) instead of inferring from a missing credential.

**B5 — Admin console unreachable but pages unguarded.** `withAdminAuth` fails
closed (401 with no `admin_session`), so no admin data is exposed. However `/admin`
is absent from `proxy.ts` `AUTH_PATHS`, so anonymous visitors can load the admin
shell HTML (empty of data). Cosmetic information disclosure; no customer financial
data at risk. No login route or admin bootstrap exists, so the console cannot be used.

### Documented known issues (inspected, intentionally not built this phase)

| Issue | Finding |
|---|---|
| No `POST /api/transfers/[id]/execute` | Confirmed absent. Live transfers would stall at `ready` and never submit. Sandbox unaffected (settles at confirm). |
| Stripe webhook does not run CA settlement | Confirmed. `isFinancialEvent()` records the event then immediately calls `markProviderEventProcessed()` with a literal `// Phase B2` placeholder. CA live settlement is a no-op; the US Plaid path is fully wired. |
| Stripe webhook returns 200 after handler failure | Confirmed at `route.ts:91-95` — the `catch` returns `{received:true}` so Stripe never retries. Genuine risk of permanently losing a retriable financial event. |
| Admin login / bootstrap missing | Confirmed (B5). |
| No test script | Fixed this phase. |
| No CI workflow | Confirmed absent. Deferred — enabling CI now would immediately red-build on B2/B3. |
| Stripe API version differs between branches | Resolved (§3.5). |

---

## 10. Exact Next Recommended Phase

**Phase 2 — Quality gate and admin lifecycle closure.** Rationale: the baseline is
functionally sound but not *enforceably* sound; adding CI before B2/B3 are fixed
produces a permanently red pipeline, and settlement work should land on a branch
whose regressions are caught automatically.

1. Clear B2 — replace `any` in `lib/services`, `lib/rbac`, `lib/repositories`,
   `app/api/admin` with real interfaces (no rule suppression).
2. Clear B3 — fix the 53 failing tests and 22 test-file type errors, including the
   `sanitizeCorrelationId` contract mismatch.
3. Add CI (`.github/workflows/ci.yml`): `npm ci` → `typecheck` → `lint` → `test` →
   `build`, required on PRs to `master`.
4. Resolve B4 by decision: explicit sandbox flag vs. documented deployment control.
5. Build admin login + bootstrap; add `/admin` to `proxy.ts` (closes B5).
6. Only then open a reviewed PR of `integration/release-0.95` → `master`.

**Phase 3** (after a green gate): Canadian Stripe settlement + webhook retry
semantics + the execute endpoint.

---

## 11. Commits Created This Phase

| Commit | Description |
|---|---|
| `0c1abaf` | Integrate `claude/cool-cerf-ErxD3` — sandbox loop, admin/RBAC/audit, correlation IDs, Operations Console; ACSS-preserving conflict resolution |
| `d4dade2` | Integrate `go-live-prep` — env-gated live provider routing; confirm-route union |
| `6e3a595` | Build stabilization — lockfile sync + `stripe ~22.3.2` pin |
| `4e69146` | Test stabilization — vitest runner, `npm test`/`typecheck` scripts, no test semantics changed |
| _(this commit)_ | Documentation reconciliation — `CLAUDE.md` corrections + this report |

### Recovery points (created before any modification)

Backup **branches** pushed to origin (tag pushes are rejected by the git proxy with
HTTP 403, so branches are the durable recovery mechanism; local tags of the same
names also exist):

| Backup branch | SHA |
|---|---|
| `backup/pre-0.95/master` | `62b4e15` |
| `backup/pre-0.95/claude-cool-cerf-ErxD3` | `170d8fb` |
| `backup/pre-0.95/kyc-sandbox-verify` | `0410082` |
| `backup/pre-0.95/go-live-prep` | `3d87e84` |

---

## 12. Live-Money Confirmation

**Explicitly confirmed:**

- **No live provider flag was enabled.** `PLAID_TRANSFER_LIVE` and `CA_EFT_LIVE`
  appear only as `process.env` reads compared against `'true'`. Neither is set,
  defaulted, or assigned anywhere in code, config, or environment.
- **No live-money transaction was executed.** No request was made to Plaid, Stripe,
  or any banking rail during this phase. Verification was limited to install,
  typecheck, lint, build, unit tests, and static inspection.
- **No Vercel production configuration was changed.**
- **`master` was not modified** and remains at `62b4e15`.
- **`integration/release-0.95` was not merged into `master`.**
- **No secrets are present in the repository**; matches are documentation
  placeholders only.
