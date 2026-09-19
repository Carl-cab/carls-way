# Validation Probes

These files are small, local-only engineering probes retained to document the evidence behind financial-safety decisions. They are **not** application migrations, deployment scripts, or production operational tools.

| File | Purpose | Safety boundary |
| --- | --- | --- |
| `bcrypt_dummy_hash_timing_probe.cjs` | Measures a valid bcrypt comparison against an intentionally malformed dummy hash to demonstrate why a valid precomputed dummy hash is required for login timing normalization. | Uses example strings only; no database or network access. |
| `unsafe_postgres_numeric_parser_probe.cjs` | Demonstrates why globally parsing PostgreSQL `NUMERIC` values with JavaScript `parseFloat` is unsafe, especially for high-precision FX rates. | Uses a local disposable `manna_test` table named `numeric_parser_probe`, then removes it. It deliberately demonstrates the unsafe parser and must never be copied into app configuration. |
| `float4_money_precision_probe.sql` | Illustrates REAL/float4 representation loss in stored currency values and repeated arithmetic. | Creates and removes a temporary/local probe table. |
| `float4_numeric_cast_probe.sql` | Compares REAL text and numeric casts to show why conversion guards must use float4 round-trip semantics. | Read-only expression query. |
| `nonfinite_float_probe.sql` | Demonstrates PostgreSQL `isfinite` behavior for finite, infinite, and NaN floating values. | Read-only expression query. |

Run probes only against a disposable local database. Do not use them as migrations or run them against production.
