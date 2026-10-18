// JSONB parameter and row helpers.
//
// Why this file exists: passing `JSON.stringify(value)` as a parameter bound to
// a `jsonb` column does NOT store an object. It stores a jsonb **string
// scalar** — the serialised text, quoted and escaped, as a single JSON string.
// Every SQL-side accessor then returns NULL, silently:
//
//   INSERT ... VALUES (${JSON.stringify({ ip: '1.2.3.4' })})
//     → jsonb_typeof = 'string'
//     → m->>'ip'     = NULL
//     → m::text      = '"{\"ip\":\"1.2.3.4\"}"'
//
//   INSERT ... VALUES (${sql.json({ ip: '1.2.3.4' })})
//     → jsonb_typeof = 'object'
//     → m->>'ip'     = '1.2.3.4'
//
// Measured, both rows, against a real jsonb column. Two details are worth
// recording because they are the traps:
//
//   - Adding an explicit `::jsonb` cast to the stringified form does NOT fix
//     it. The cast is applied to text that is already a complete JSON
//     document, so the result is still a string scalar.
//   - `sql.json(null)` stores SQL NULL, not the jsonb `null` literal, so a
//     nullable column needs no special casing.
//
// See docs/decisions/0002-normalize-audit-jsonb-additively.md.

import type { Sql } from 'postgres';

/**
 * Bind a value to a `jsonb` column as a JSON **document**.
 *
 * Use this instead of `JSON.stringify(value)` for every `jsonb` parameter.
 * `null` and `undefined` both bind as SQL NULL, so the common
 * `value ? ... : null` ternary at the call site is unnecessary.
 */
export function jsonbParam(sql: Sql, value: unknown) {
  if (value === null || value === undefined) return null;
  return sql.json(value as never);
}

/**
 * Read a `jsonb` column that may hold either shape.
 *
 * Rows written before the writers were fixed hold a string scalar, which
 * `postgres.js` hands back as a JS string. Rows written after hold an object.
 * Historical audit rows are evidence and are not rewritten, so every reader
 * has to accept both for as long as those rows are retained.
 *
 * A string that does not parse is returned as `{ raw: <text> }` rather than
 * thrown away or raised: this is an audit path, and losing a record because
 * its metadata is malformed is worse than surfacing the text verbatim.
 */
export function readJsonbRecord<T = Record<string, unknown>>(
  value: unknown,
): T | undefined {
  if (value === null || value === undefined) return undefined;

  // Already a document — the shape every row written from now on has.
  if (typeof value === 'object') return value as T;

  if (typeof value === 'string') {
    // Legacy double-encoded row.
    try {
      const parsed = JSON.parse(value);
      // A legacy row could itself hold a bare scalar; only an object is a
      // meaningful metadata record, so anything else is reported as raw text.
      if (parsed !== null && typeof parsed === 'object') return parsed as T;
      return { raw: value } as unknown as T;
    } catch {
      return { raw: value } as unknown as T;
    }
  }

  return { raw: String(value) } as unknown as T;
}
