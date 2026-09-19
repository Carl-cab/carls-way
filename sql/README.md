# SQL Operational Artifacts

This directory contains database artifacts that must be handled according to their stated operating status. They are not executed by application startup, Vercel deployment, or the daily reconciliation cron.

| File | Status | Purpose |
| --- | --- | --- |
| `reconcile_internal_transactions.sql` | **Approved read-only diagnostic** | Reconciles completed internal `pay` and `payment` transactions against their wallet-ledger postings and user wallet balances. It contains `SELECT` statements only. |
| `archive/20260907_money_real_to_numeric__superseded.sql` | **Historical; do not execute** | Original draft of the REAL-to-NUMERIC conversion. It remains only for auditability and must not be used as a production migration. |

## Production guidance

A financial schema conversion requires a separately reviewed maintenance procedure, verified backup/recovery plan, an application write drain, preflight reconciliation, and explicit authorization. Do not run archived SQL against any environment. The deployed daily reconciliation service is the operational monitor for completed internal-payment records; the reusable read-only SQL remains available for an independent operator-led investigation.
