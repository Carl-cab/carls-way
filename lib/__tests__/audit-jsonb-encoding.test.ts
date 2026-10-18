/**
 * Audit metadata is stored as a JSONB **document**, not a JSON string scalar.
 *
 * Both audit writers passed `JSON.stringify(value)` as the parameter bound to
 * a `jsonb` column. That does not store an object; it stores the serialised
 * text as a single jsonb string scalar, and every SQL-side accessor then
 * returns NULL without erroring:
 *
 *   jsonb_typeof(metadata) = 'string'   (not 'object')
 *   metadata->>'ip'        = NULL
 *   metadata::text         = '"{\"ip\":\"1.2.3.4\"}"'
 *
 * The defect was invisible from the application because the paired reader did
 * `JSON.parse(row.changes)`, which decoded the scalar back into an object and
 * exactly compensated the writer. So JS reads looked correct while the column
 * was unqueryable — which is the half that matters for compliance evidence,
 * since an auditor's `WHERE changes->>'field' = ...` silently matched nothing.
 *
 * That compensation is also why the writer could not be fixed alone: with a
 * corrected writer the row comes back as an object, `JSON.parse(object)`
 * stringifies it to "[object Object]" and throws SyntaxError, which
 * createAuditLog's catch reports as AUDIT_CREATE_FAILED. Writer and reader had
 * to move together, and these tests pin both halves.
 *
 * Historical rows are NOT rewritten — they are audit evidence, and altering
 * production history needs separate authorization. The reader therefore has to
 * accept both shapes for as long as those rows are retained, so the legacy
 * case below is a permanent requirement rather than a transitional one. See
 * docs/decisions/0002-normalize-audit-jsonb-additively.md.
 *
 * These tests call the real `auditLog()` and the real `AuditLogRepository`
 * against a real database. A mock cannot catch this class of defect at all:
 * the bug is in what PostgreSQL stores, and a hand-written fake would be
 * written against the same wrong assumption as the code.
 */
import { getSql } from '../db';
import { auditLog } from '../auth';
import { getAuditLogRepository } from '../rbac/AuditLogRepository';
import { jsonbParam, readJsonbRecord } from '../jsonb';

const sql = getSql();

// Distinct per-run marker so assertions select only this file's rows and the
// shared test database's existing contents are left alone.
const RUN = `jsonb-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let adminUserId: number;
let userId: number;

beforeAll(async () => {
  // audit_logs.user_id REFERENCES users(id), and auditLog() swallows every
  // error, so a non-existent id produces no row and no complaint. Use a real
  // user so a missing row means the encoding path failed, not the FK.
  const userRows = await sql`
    INSERT INTO users (name, username, email, password_hash, country)
    VALUES ('JSONB Probe', ${RUN}, ${`${RUN}@example.test`}, 'not-a-real-hash', 'CA')
    RETURNING id
  `;
  userId = userRows[0].id as number;

  // admin_audit_logs.admin_user_id is NOT NULL REFERENCES admin_users(id), so
  // the repository path needs a real admin row to point at.
  const rows = await sql`
    INSERT INTO admin_users (email, name, password_hash, role, status)
    VALUES (${`${RUN}@example.test`}, 'jsonb probe', 'not-a-real-hash', 'super_admin', 'active')
    RETURNING id
  `;
  adminUserId = rows[0].id as number;
}, 60000);

afterAll(async () => {
  await sql`DELETE FROM admin_audit_logs WHERE admin_user_id = ${adminUserId}`;
  await sql`DELETE FROM admin_users WHERE id = ${adminUserId}`;
  await sql`DELETE FROM audit_logs WHERE action LIKE ${`${RUN}%`}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}, 60000);

describe('auditLog() writes a jsonb document to audit_logs.metadata', () => {
  it('stores an object, and SQL accessors resolve', async () => {
    const action = `${RUN}:auth-writer`;
    await auditLog(userId, action, { ip: '1.2.3.4', amount: 500, nested: { k: 'v' } });

    const rows = await sql`
      SELECT
        jsonb_typeof(metadata)       AS typ,
        metadata->>'ip'              AS ip,
        (metadata->>'amount')::int   AS amount,
        metadata#>>'{nested,k}'      AS nested_k
      FROM audit_logs
      WHERE action = ${action}
    `;

    expect(rows).toHaveLength(1);
    // The assertion that fails on the old writer: it produced 'string'.
    expect(rows[0].typ).toBe('object');
    // These were all NULL before the fix.
    expect(rows[0].ip).toBe('1.2.3.4');
    expect(rows[0].amount).toBe(500);
    expect(rows[0].nested_k).toBe('v');
  });

  it('a jsonb containment query matches, which is how audit search filters', async () => {
    const action = `${RUN}:auth-containment`;
    await auditLog(userId, action, { reason: 'velocity_exceeded', currency: 'CAD' });

    // @> cannot match a string scalar against an object operand, so this
    // returned zero rows before the fix regardless of the data.
    const rows = await sql`
      SELECT id FROM audit_logs
      WHERE action = ${action}
        AND metadata @> ${sql.json({ reason: 'velocity_exceeded' })}
    `;
    expect(rows).toHaveLength(1);
  });

  it('omitted metadata is SQL NULL, not the jsonb null literal', async () => {
    const action = `${RUN}:auth-null`;
    await auditLog(userId, action);

    const rows = await sql`
      SELECT metadata IS NULL AS is_null, jsonb_typeof(metadata) AS typ
      FROM audit_logs WHERE action = ${action}
    `;
    expect(rows[0].is_null).toBe(true);
    expect(rows[0].typ).toBeNull();
  });
});

describe('AuditLogRepository writes a jsonb document to admin_audit_logs.changes', () => {
  it('stores an object, and SQL accessors resolve', async () => {
    const repo = getAuditLogRepository();
    const created = await repo.createAuditLog({
      admin_user_id: adminUserId,
      action: 'role.update',
      resource_type: 'admin_user',
      resource_id: '42',
      changes: { before: { role: 'viewer' }, after: { role: 'admin' } },
    });

    const rows = await sql`
      SELECT
        jsonb_typeof(changes)         AS typ,
        changes#>>'{before,role}'     AS before_role,
        changes#>>'{after,role}'      AS after_role
      FROM admin_audit_logs
      WHERE id = ${created.id}
    `;

    expect(rows[0].typ).toBe('object');
    expect(rows[0].before_role).toBe('viewer');
    expect(rows[0].after_role).toBe('admin');
  });

  it('round-trips through the repository reader', async () => {
    // Guards the coupling directly: a reader still doing JSON.parse on the
    // corrected row throws SyntaxError here, surfacing as AUDIT_CREATE_FAILED.
    const repo = getAuditLogRepository();
    const changes = { before: { limit: 100 }, after: { limit: 250 } };
    const created = await repo.createAuditLog({
      admin_user_id: adminUserId,
      action: 'limit.update',
      resource_type: 'config',
      changes,
    });

    expect(created.changes).toEqual(changes);

    const fetched = await repo.findAuditLogById(created.id);
    expect(fetched?.changes).toEqual(changes);
  });

  it('reads a legacy double-encoded row without throwing', async () => {
    // A row in exactly the shape the old writer produced. Production holds
    // these and they are not rewritten, so the reader must stay tolerant.
    const legacy = { before: { role: 'viewer' }, after: { role: 'admin' } };
    const inserted = await sql`
      INSERT INTO admin_audit_logs (admin_user_id, action, resource_type, changes)
      VALUES (
        ${adminUserId}, 'legacy.row', 'admin_user',
        ${JSON.stringify(legacy)}
      )
      RETURNING id
    `;
    const id = inserted[0].id as number;

    // Confirm the fixture really is the broken shape, so this test cannot pass
    // by accidentally having written a correct row.
    const shape = await sql`
      SELECT jsonb_typeof(changes) AS typ FROM admin_audit_logs WHERE id = ${id}
    `;
    expect(shape[0].typ).toBe('string');

    const fetched = await getAuditLogRepository().findAuditLogById(id);
    expect(fetched?.changes).toEqual(legacy);
  });
});

describe('jsonbParam', () => {
  it('binds null and undefined as SQL NULL', async () => {
    const rows = await sql`
      SELECT ${jsonbParam(sql, null)}::jsonb AS a, ${jsonbParam(sql, undefined)}::jsonb AS b
    `;
    expect(rows[0].a).toBeNull();
    expect(rows[0].b).toBeNull();
  });

  it('an explicit ::jsonb cast on stringified text does NOT produce a document', async () => {
    // Recorded because it is the intuitive fix and it does not work: the cast
    // is applied to text that is already a complete JSON document, so the
    // result is still a string scalar.
    const rows = await sql`
      SELECT
        jsonb_typeof(${JSON.stringify({ a: 1 })}::jsonb)  AS cast_typ,
        jsonb_typeof(${jsonbParam(sql, { a: 1 })}::jsonb) AS param_typ
    `;
    expect(rows[0].cast_typ).toBe('string');
    expect(rows[0].param_typ).toBe('object');
  });
});

describe('readJsonbRecord', () => {
  it('passes an object through unchanged', () => {
    const o = { a: 1 };
    expect(readJsonbRecord(o)).toBe(o);
  });

  it('parses a legacy JSON string', () => {
    expect(readJsonbRecord('{"a":1}')).toEqual({ a: 1 });
  });

  it('maps null and undefined to undefined', () => {
    expect(readJsonbRecord(null)).toBeUndefined();
    expect(readJsonbRecord(undefined)).toBeUndefined();
  });

  it('surfaces unparseable text rather than discarding the record', () => {
    // An audit record must not vanish because its metadata is malformed.
    expect(readJsonbRecord('not json at all')).toEqual({ raw: 'not json at all' });
  });

  it('reports a legacy bare scalar as raw text', () => {
    expect(readJsonbRecord('"just a string"')).toEqual({ raw: '"just a string"' });
  });
});
