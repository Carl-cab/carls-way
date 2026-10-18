# 0004 — Append-only and tamper-evident audit architecture

**Date:** 2026-10-18
**Status:** **Proposed** — not implemented. Layer 1 changes the database role the
application connects as, which is a production change requiring separate
authorization and rehearsal.
**Relates to:** 0002 (which established that nothing enforces immutability today)

## Current state, measured

From 0002, on a database built from the schema sources:

| Control | Present |
|---|---|
| `BEFORE UPDATE`/`DELETE` trigger on either audit table | No |
| `BEFORE TRUNCATE` trigger | No |
| Rewrite rule | No |
| Row-level security | No (`relrowsecurity = f` on both) |
| `REVOKE UPDATE, DELETE` from the application role | No — no `REVOKE` in any schema source |
| Hash chaining or signatures | No |

The application connects with a single role that performs all DML **and** all
DDL (`/api/migrate`). That role can update or delete audit rows and leaves no
residue. `audit_logs` was described in `CLAUDE.md` as an "Immutable system audit
trail"; that wording has been corrected.

## Threat model

Naming who each layer defends against, because "immutable" on its own means
nothing:

- **T1 — Application defect.** A future `UPDATE audit_logs SET ...`, or a
  careless cleanup script, run with the app's own credential.
- **T2 — Compromised application.** SQL injection or RCE in the app, giving an
  attacker the app's credential and nothing more. Note that this splits in two:
  *altering* existing audit rows, which the layers below do address, and
  *appending fabricated* ones, which none of them do — the app must keep
  `INSERT` for auditing to work at all.
- **T3 — Privileged operator.** Someone holding the owner credential: a rogue
  insider, a stolen `DATABASE_URL`, or a compromised CI secret. **This is the
  threat that "immutable audit log" claims usually quietly exclude.**
- **T4 — Infrastructure access.** Filesystem, snapshot or backup access
  beneath the database.

## The layers, and what each one actually buys

### Layer 1 — Privilege separation. The real control against T1 and T2.

The application connects as a role that is **not** the owner of the audit
tables, holding `INSERT, SELECT` on them and no `UPDATE`, `DELETE` or
`TRUNCATE`.

Measured, as a non-owner role against a table owned by `postgres`:

| Attempt | Result |
|---|---|
| `INSERT` | **succeeds** — append still works |
| `UPDATE` | refused |
| `DELETE` | refused |
| `ALTER TABLE ... DISABLE TRIGGER` | `ERROR: must be owner of table` |
| `DROP TRIGGER` | `ERROR: must be owner of relation` |
| `TRUNCATE` | `ERROR: permission denied for table` |

This is the layer that carries the weight, and its guarantee is precisely:
**existing audit rows cannot be modified, deleted or truncated using the
application's credential.**

It is **not** a guarantee that the rows are authentic. The app role keeps
`INSERT` — it has to, or auditing stops — so under T2 a compromised
application can still call `auditLog()` with a fabricated `userId`, `action` or
`metadata` and have it stored like any other row. Layer 1 protects the
*integrity of the record*, not the *truthfulness of what was appended*. An
earlier draft of this document said it "defeats T1 and T2 completely", which
was wrong in exactly that respect.

Defending against forged entries is a different problem — it needs the writer
to be authenticated to something the app cannot impersonate (a signing key held
elsewhere, or a trusted ingestion path), and no layer below addresses it
either. It is recorded here as out of scope rather than quietly covered.

Layer 1 also does **not** defeat T3, and nothing in this layer pretends to.

### Layer 2 — Triggers. Defence in depth, and two are needed.

```sql
CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit is append-only: % refused', TG_OP; END $$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only();
```

One function serves both triggers: it raises for every `TG_OP`, and `TG_OP`
reports `TRUNCATE` in the statement-level case. Verified by executing the block
above — `UPDATE`, `DELETE` and `TRUNCATE` were each refused and the row
survived.

**The `TRUNCATE` trigger is not optional, and this is the easy thing to get
wrong.** Measured: with only the row trigger in place, the owner's `TRUNCATE`
succeeded and emptied the table silently — row-level triggers do not fire on
`TRUNCATE`. An "append-only" implementation consisting of one row trigger is
defeated by a single statement.

Measured limit: the row trigger refuses `UPDATE`/`DELETE` even for the table
owner — but the owner can `ALTER TABLE ... DISABLE TRIGGER` and then modify
rows freely, then re-enable it. So Layer 2 catches mistakes, including the
owner's own, and is **not** a control against a determined T3.

### Layer 3 — Hash chaining. Tamper-*evidence*, and only with an external anchor.

Each row carries `prev_hash` and `row_hash = H(prev_hash || canonical content)`.
Any alteration or removal of an interior row breaks verification from that point
on, which is what the existing `verifyImmutability()` cannot do — it compares
`COUNT(*)` to `MAX(id)`, so it detects gaps from deletes and cannot detect an
update at all.

**The cutover has to be decided explicitly, because both audit tables already
hold rows.** Two options, and they differ in what can honestly be claimed:

- **Chain from deployment.** New rows are chained from a genesis anchor; rows
  written before it are outside the chain. Verification then covers only rows
  from the cutover forward, and must say so — a clean verification result
  proves nothing about earlier rows.
- **Backfill the existing rows.** The chain covers everything, but the backfill
  computes hashes from rows *as they are now*, so it anchors their current
  state and **cannot attest that they were not already altered**. It converts
  "unverifiable" into "unverifiable before the backfill, verified after", which
  is worth having but must not be presented as retrospective assurance.

Either way, the verification API must report the range it covers rather than a
bare pass or fail. A verifier that answers "clean" without naming its scope is
the same failure as the hardcoded `'clean'` it replaces.

Two hard constraints:

**It does not by itself defend against T3.** A chain stored entirely inside the
database can be recomputed by whoever can rewrite the rows. Hash chaining
becomes meaningful only when the chain head is **anchored outside the
tamperer's control** — periodically exported to storage with an object-lock or
retention policy, in a different account, or to a third party. Without that
anchor it raises the effort of tampering and nothing more, and must not be
described as tamper-proof.

**A naive implementation forks under concurrency.** Measured: 8 concurrent
appends that each read the current head then inserted produced a fork **6 rows
wide** — six rows claiming the same predecessor, so the chain was not a single
line and verification is meaningless. A chain needs serialization: an advisory
lock, a single-writer path, or `SERIALIZABLE` with retry.

That serialization collides with an existing property. `auditLog()` is
deliberately non-blocking — a failed audit write must not fail the action being
audited — and audit writes sit on hot paths. Adding a serialized chain either
introduces contention there or breaks the chain silently when it is skipped. The
honest resolutions are a separate asynchronous chaining pass over already-stored
rows, or chaining only the admin audit table, whose write volume is far lower.

### Layer 4 — External evidence storage. The only real answer to T3 and T4.

Append-only export to storage the database operator does not control: periodic
signed batches to object storage with a retention lock, or a managed WORM/log
service. Whoever can rewrite the database cannot rewrite what has already left
it.

This is the only layer that makes a defensible claim against a privileged
operator, and it is an infrastructure and commercial decision, not a schema
change.

## What may and may not be claimed

With Layers 1 and 2: **"existing audit rows cannot be modified, deleted or
truncated using the application's credential, and accidental modification by an
operator is refused."** That is true, useful, and provable.

Not claimable, even with Layers 1 and 2 in place:

- that stored entries are **authentic** — the app keeps `INSERT`, so a
  compromised application can append fabricated rows
- anything about rows outside the hash chain's covered range, once Layer 3
  exists

Not claimable without Layer 4, whatever is built in the database:

- tamper-proof against a privileged operator
- cryptographic non-repudiation
- regulatory-grade immutable retention

**No claim of cryptographic tamper resistance is made by this document.**

## Implementation consequences, including one that bites

**`/api/migrate` runs DDL on the same connection the app uses for DML.** If the
app role stops being the owner, the migrate route can no longer create tables or
add columns — it would fail with `must be owner`. So Layer 1 cannot land on its
own: it requires either a second, owner-credentialed connection used only by
migrations, or moving migrations off the HTTP endpoint entirely. That is the
same question the directive raises separately about migration endpoint security,
and it should be settled first, because Layer 1 depends on the answer.

Other consequences:

- The restricted role needs full DML on business tables and `INSERT, SELECT` on
  audit tables, plus sequence usage. A missed `GRANT` breaks writes at runtime,
  so this needs rehearsal against a copy of production, not a fresh test
  database — a fresh database is built by `initializeSchema()` and would not
  reproduce a missing grant on an existing object.
- `DATABASE_URL` changes, which is a production secret change.
- `default_privileges` must be set, or tables created later come back owned and
  granted wrongly.
- Reversibility: Layer 1 is reversible, but **granting DML privileges back is
  not sufficient**. `ALTER TABLE`, `DISABLE TRIGGER` and the rest are
  owner-only, so a rollback must also restore the original owner — either by
  reassigning ownership (`ALTER TABLE ... OWNER TO`) or by pointing
  `DATABASE_URL` back at the owning role. A rollback that restores grants
  alone leaves `/api/migrate` still failing with `must be owner`, which would
  look like a new fault rather than an incomplete rollback. The rollback
  procedure must name both steps.
- Layer 3 adds columns and is additive. Nothing here rewrites an existing audit
  row.

## Recommended sequence

1. Settle the migration-privilege question (owner connection vs. moving
   migrations off HTTP). **Blocks Layer 1.**
2. Layer 2 triggers, both of them, on both audit tables. Cheapest, reversible,
   and independent of the role change — it can land before Layer 1.
3. Layer 1 privilege separation, rehearsed against a production copy.
4. Replace `verifyImmutability()` with something that verifies what is actually
   enforced, or delete it. Today one implementation returns a hardcoded
   `'clean'` and the other detects only deletes; both are worse than nothing
   because they imply a check that does not happen.
5. Layer 3 only once Layer 4's anchor exists, since a chain without an external
   anchor does not answer the threat it appears to answer.

## Alternatives considered

**Row-level security.** Rejected as the primary mechanism: RLS filters rows, it
does not make them immutable, and it is bypassed by the table owner and by
`BYPASSRLS`. Privilege separation is the direct expression of the intent.

**Rewrite rules (`CREATE RULE ... DO INSTEAD NOTHING`).** Rejected: they
silently discard the statement rather than refusing it, so a buggy `UPDATE`
appears to succeed. A trigger that raises is strictly better for a control
whose job is to be noticed.

**Writing audit rows to a separate database.** A real option, and stronger than
Layer 1 for T3, but it gives up transactional consistency between the audited
action and its audit row, and the loss of atomicity is its own correctness
problem on a money path. Not recommended without a durable outbox.

**Doing nothing and documenting it.** This is the current state after 0002, and
it is honest, but it leaves T1 and T2 open when Layers 1 and 2 are cheap and
reversible.
