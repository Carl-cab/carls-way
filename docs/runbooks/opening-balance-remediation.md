# Opening-balance remediation plan

**Status: PROPOSED. Not authorized, not executed, and no step below may be run
without the owner's explicit authorization for that step.**

No production balance or historical ledger entry has been modified. The only
thing implemented so far is the **read-only** assessment and the retirement of
the unsafe repair.

---

## What went wrong

`backfillOpeningBalances()` credited each user's **current** balance as an
`opening_balance` ledger entry. For an account that had transacted, that books
its entire history a second time.

| | wallet | ledger | discrepancy |
|---|---|---|---|
| before | 1370.00 | 1270.00 | **+100.00** |
| after | 1370.00 | 2640.00 | **−1270.00** |

**It looked like it helped.** Aggregate `user_wallets_exactly_match_ledger`
violations fell from **6 to 3**, because the three accounts with no activity
were corrected properly. An operator reading that count would have concluded
the repair worked while every active account it touched was corrupted.

Retired 2026-11-18 (owner decision 3). `backfillOpeningBalances()` now throws,
and `POST /api/admin/ledger/backfill-opening-balances` answers **410 Gone** and
writes nothing.

## The second, separate cause

Registration wrote the seed grant straight into `balance_cad`/`balance_usd`
with **no ledger entry**, so every registered account is out by its seed
amount. Owner decision 2 fixes that **going forward** — new sandbox accounts
book the grant atomically, and production accounts receive none. It does
nothing for accounts that already exist, which is what this plan is for.

---

## Step 1 — Assess (read-only, safe to run now)

```
GET /api/admin/ledger/backfill-opening-balances
```

Requires an admin session and `exceptions:manage`. Executes SELECTs only;
pinned by a test that compares a full ledger snapshot before and after.

Returns one row per (user, currency) with the wallet balance, ledger balance,
discrepancy, opening-entry count and total, whether the account has
**subsequent activity**, the **independently evidenced** original grant, and a
classification:

| Classification | Meaning | Repairable from this data? |
|---|---|---|
| `reconciled` | wallet equals ledger | nothing to do |
| `missing_opening_entry_no_activity` | seed never booked, no other entries | **only with evidence** |
| `discrepant_with_activity` | discrepant AND has other entries | **no** — the case the old backfill corrupted |
| `duplicate_opening_entries` | more than one opening entry | **no** — needs a decision on which is correct |
| `requires_manual_investigation` | none of the above | **no** |

`duplicate_opening_entries` is classified **before** the discrepancy is
considered, deliberately: two entries of 50.00 on a 100.00 wallet reconcile to
zero, and a discrepancy-only classifier would call that clean.

## Step 2 — Establish evidence (owner, no code)

`evidencedGrantMinorUnits` is read from the `user_registered` audit row's
`registration_grant` metadata, which registration only began writing under
decision 2. For accounts created before that it is **`null`**.

**`null` means "no evidence", not "no grant", and never "100.00".** The
assessment reports `withoutEvidencedGrant` so a repair cannot quietly cover
accounts whose correct amount nobody knows. An account discrepant by exactly
100.00 is precisely where guessing is tempting and forbidden — the historical
grant may have been a different amount, may have been adjusted, or the
discrepancy may have another cause entirely.

Acceptable independent evidence, for the owner to decide on:

- a production database backup predating the account's first transaction,
  showing the balance at creation;
- a deployment record establishing which grant amount was in force on the
  account's `created_at` date;
- for `duplicate_opening_entries`, a determination of which entry is correct.

Accounts for which none exists stay unrepaired and are reported as such. That
is a better outcome than a plausible number.

## Step 3 — Propose (engineering, needs authorization to write)

Only after step 2. A repair script would, per account:

- act **only** on `missing_opening_entry_no_activity` rows with an evidenced
  amount;
- write one `opening_balance` entry for the **evidenced original grant**,
  never the current balance;
- run inside a transaction, per account, so a partial run leaves no account
  half-repaired;
- be idempotent on `(user_id, currency, entry_type='opening_balance')`;
- write **nothing** for any other classification;
- produce a per-account before/after report.

**Explicitly out of scope:** touching `balance_cad` / `balance_usd`, altering
or deleting any existing ledger entry, and repairing any account with
subsequent activity. Historical entries are evidence and are preserved.

## Step 4 — Rehearse

Against a restored copy, never production. Required before any authorization:

1. restore a production backup into an isolated database;
2. run step 1 and record the counts;
3. run the proposed repair against the restore;
4. run `scripts/reconciliation-check.sql` and compare to the pre-repair
   baseline;
5. confirm every `discrepant_with_activity` account is **untouched** — this is
   the regression that matters, since it is what the old backfill got wrong;
6. re-run the repair to show idempotence.

## Step 5 — Execute

Owner-authorized only, with the step-4 evidence attached. Back up first, run
once, re-run the assessment, and record the result in a dated audit document.

---

## What is decided and what is not

**Decided and implemented:** the unsafe mutation paths no longer write; the
read-only assessment exists; registration books new grants atomically and
grants nothing in production.

**Not decided:** whether to repair historical accounts at all. Leaving them
discrepant and documented is a legitimate outcome — the discrepancy is in an
audit ledger rather than in customer balances, no customer's wallet is wrong,
and a repair built on guessed amounts would put a fabricated number into the
record the ledger exists to be.

---

## DECIDED 2026-11-18 — QUARANTINE, outside the beta environment

**The owner chose quarantine.** This section is no longer a menu: the
decision is recorded, and the repair steps above (3–5) are retained as the
shape any FUTURE evidence-based proposal must take, not as work authorized
now.

What the decision means, in the owner's terms:

- Historical discrepancies stay **documented and visible**.
- **No historical ledger entry or wallet balance is modified.** Not now, not
  as a side effect of anything else.
- Historical accounts are **not excluded from production reconciliation
  merely to produce a passing result.** This is the part most easily got
  wrong: quarantine is a label on a known set, not a filter that makes the
  report green. If the production reconciliation reports failures caused by
  these accounts, that output is **correct** and must stay visible.
- A separate, **evidence-based** historical remediation proposal is to be
  prepared for future authorization.
- The retired backfill is **never** executed.

**Quarantine is outside the beta environment.** The beta runs on its own
database, provisioned from `initializeSchema()` plus the authorized Preview
migration and containing only accounts created through the application — so
it holds none of these historical rows and reports 7/7 PASS. Production keeps
its discrepancies, labelled.

## Appendix — QUARANTINE, the reasoning behind the decision

Added 2026-11-18 at the owner's request: "prepare a separately authorized
remediation **or quarantine** plan". Quarantine is the better option for most
of these accounts, and saying so plainly is the point of this appendix.

### Why quarantine rather than repair

A repair writes a number into the ledger. For any account whose original grant
is not independently evidenced, that number is a guess — and the ledger is the
record a guess should never enter. The read-only assessment already separates
the accounts where this is decidable from the ones where it is not, and
`withoutEvidencedGrant` counts the latter.

Quarantine keeps the discrepancy visible and labelled instead of papering over
it. Nothing about these accounts is wrong from a customer's point of view:
**no customer wallet holds an incorrect balance.** The discrepancy is between
the wallet and an audit ledger that was never written at registration.

### What quarantine means concretely

1. **Freeze the set.** Snapshot the assessment output — every account,
   classification, discrepancy and evidence status — into a dated audit
   document. That snapshot is the quarantine list, and it is evidence rather
   than a worklist.
2. **Exclude it from the invariant, explicitly and visibly.** If
   `user_wallets_exactly_match_ledger` is ever scoped to exclude quarantined
   accounts, the scope counter must report how many were excluded, so the
   exclusion cannot be mistaken for a clean result. An invariant that silently
   skips rows is the failure this repository has corrected twice.
3. **Do not re-admit silently.** A quarantined account that later transacts
   stays quarantined: its new entries reconcile among themselves, and its
   opening gap is a permanent, documented fact about an account created before
   the grant was booked.
4. **Repair only the decidable subset**, per steps 3–5 above — accounts
   classified `missing_opening_entry_no_activity` **with** an evidenced grant.

### What is NOT acceptable under either option

- Writing an opening entry for the account's **current** balance. That is the
  retired backfill, and it is what made a +100.00 discrepancy into −1270.00.
- Assuming an unevidenced grant was 100.00 because the discrepancy happens to
  be 100.00.
- Adjusting a customer's wallet balance to match the ledger. The wallet is
  correct; the ledger is the incomplete record.
- Narrowing the reconciliation invariant without reporting the exclusion.

**Superseded by the decision above.** This appendix set out the options when
the choice was still open; the owner chose quarantine on 2026-11-18. It is
kept because it records why — a repair writes a number into the ledger, and
for any account whose original grant is not independently evidenced that
number is a guess.

One line in it is now binding rather than advisory: **if
`user_wallets_exactly_match_ledger` is ever scoped to exclude quarantined
accounts, the scope counter must report how many were excluded.** The owner's
instruction is stronger still — do not exclude them merely to generate a
passing result.
