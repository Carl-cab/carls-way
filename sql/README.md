# SQL Operational Artifacts

This directory contains database artifacts that must be handled according to their stated operating status. They are not executed by application startup, Vercel deployment, or the daily reconciliation cron.

| File | Status | Purpose |
| --- | --- | --- |
| `reconcile_internal_transactions.sql` | **Approved read-only diagnostic** | Reconciles completed internal `pay` and `payment` transactions against their wallet-ledger postings and user wallet balances. It contains `SELECT` statements only. |
| `archive/20260907_money_real_to_numeric__superseded.sql` | **Historical; do not execute** | The **original draft** of the REAL-to-NUMERIC conversion, with the fixed `0.00001` tolerance described below. Retained for auditability only. |

> **The conversion itself is not superseded — only this draft is.**
>
> A corrected script lives at [`migrations/20260907_money_real_to_numeric.sql`](../migrations/20260907_money_real_to_numeric.sql).
> It replaces the fixed tolerance with a magnitude-independent round-trip
> identity, and `lib/db.ts` names it in two places as the procedure to run when
> the automatic boot-time upgrade declines a column. It is still subject to the
> production guidance below: reviewed procedure, verified backup, write drain,
> explicit authorization. "Do not run the archived draft" and "do not convert"
> are different statements, and only the first is intended.

## Production guidance

A financial schema conversion requires a separately reviewed maintenance procedure, verified backup/recovery plan, an application write drain, preflight reconciliation, and explicit authorization. Do not run archived SQL against any environment. The deployed daily reconciliation service is the operational monitor for completed internal-payment records; the reusable read-only SQL remains available for an independent operator-led investigation.

### Open item: money may still be stored as FLOAT4

Until the conversion is carried out, any column still typed `real` cannot
represent a cent exactly. Measured against PostgreSQL 16:

```
9999999.99 stored in REAL   ->  1e+07      a cent created from nothing
100.00 - 7 x 0.10 in REAL   ->  99.30001   correct answer is 99.30
```

`scripts/validation/float4_money_precision_probe.sql` reproduces this. To check
what a given environment actually holds:

```sql
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name) IN (
    ('users','balance'), ('users','balance_cad'), ('users','balance_usd'),
    ('transactions','amount'), ('transfer_intents','amount'));
```

Every row reading `numeric` means the conversion is done there. Any row reading
`real` means that environment is still losing cents on every write, and the
maintenance procedure above is outstanding — not optional.
