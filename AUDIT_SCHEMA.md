# Audit Schema

Complete documentation of the admin_audit_logs table schema and related database structures.

## admin_audit_logs Table

Primary immutable audit log table for recording all administrative actions.

### Schema Definition

```sql
CREATE TABLE admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
  session_id TEXT REFERENCES admin_sessions(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  changes JSONB,
  correlation_id VARCHAR(255),
  ip_address TEXT,
  user_agent TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  request_duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Column Definitions

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| id | SERIAL | PRIMARY KEY | Unique audit log identifier, auto-incrementing |
| admin_user_id | INTEGER | NOT NULL, FK | Which admin performed the action |
| session_id | TEXT | FK to admin_sessions | Session token (for linking to auth) |
| action | TEXT | NOT NULL | Action performed (e.g., 'transfer_retry', 'admin_created') |
| resource_type | TEXT | NOT NULL | Type of resource affected (e.g., 'transfer_intent', 'admin_user') |
| resource_id | TEXT | (optional) | ID of specific resource (e.g., transfer ID, user ID) |
| changes | JSONB | (optional) | State changes: {field: {old: value, new: value}} |
| correlation_id | VARCHAR(255) | (optional) | HTTP request correlation ID for tracing |
| ip_address | TEXT | (optional) | Source IP address of admin |
| user_agent | TEXT | (optional) | Client user-agent string |
| role | TEXT | (optional) | Admin role at time of action (SuperAdmin, etc.) |
| status | TEXT | NOT NULL, DEFAULT 'success' | 'success' or 'failed' |
| error_message | TEXT | (optional) | If failed, the error message |
| request_duration_ms | INTEGER | (optional) | How long the request took in milliseconds |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Timestamp of the action (immutable) |

### Immutability Constraints

The table enforces append-only semantics:

```sql
-- No updates allowed on audit logs
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_no_update ON admin_audit_logs
  FOR UPDATE USING (FALSE);

CREATE POLICY audit_no_delete ON admin_audit_logs
  FOR DELETE USING (FALSE);

-- Only INSERT and SELECT allowed
CREATE POLICY audit_insert ON admin_audit_logs
  FOR INSERT WITH CHECK (TRUE);

CREATE POLICY audit_select ON admin_audit_logs
  FOR SELECT USING (TRUE);
```

## Indexes

Query performance indexes for common access patterns:

```sql
-- Who: Query by admin user
CREATE INDEX idx_audit_logs_admin_user_id 
ON admin_audit_logs(admin_user_id);

-- Trace: Query by correlation ID
CREATE INDEX idx_audit_logs_correlation_id 
ON admin_audit_logs(correlation_id);

-- When: Query by date range
CREATE INDEX idx_audit_logs_created_at 
ON admin_audit_logs(created_at DESC);

-- What: Query by action type
CREATE INDEX idx_audit_logs_action 
ON admin_audit_logs(action);

-- Where: Query by resource type
CREATE INDEX idx_audit_logs_resource_type 
ON admin_audit_logs(resource_type);

-- Combined index for common queries
CREATE INDEX idx_audit_logs_admin_created 
ON admin_audit_logs(admin_user_id, created_at DESC);

CREATE INDEX idx_audit_logs_status_created 
ON admin_audit_logs(status, created_at DESC);
```

### Index Performance

| Index | Query Pattern | Estimated Rows Returned |
|-------|---|---|
| idx_audit_logs_admin_user_id | "All actions by user X" | 100-1000 |
| idx_audit_logs_correlation_id | "Trace request flow" | 1-100 |
| idx_audit_logs_created_at | "Actions in date range" | 1000-100000 |
| idx_audit_logs_action | "All 'transfer_retry' actions" | 1000-100000 |
| idx_audit_logs_resource_type | "All actions on 'transfer_intent'" | 10000-1000000 |

## Sample Data

### Successful Action

```sql
INSERT INTO admin_audit_logs (
  admin_user_id, session_id, action, resource_type, resource_id,
  changes, correlation_id, ip_address, user_agent, role,
  status, request_duration_ms
) VALUES (
  1,
  'sess_abc123xyz',
  'transfer_retry',
  'transfer_intent',
  '567890',
  '{"status": {"old": "failed", "new": "processing"}, "retried_at": {"old": null, "new": "2024-01-15T10:30:45Z"}}',
  'corr_req_12345',
  '203.0.113.42',
  'Mozilla/5.0 (X11; Linux x86_64)',
  'OperationsAdmin',
  'success',
  145
);

-- Result:
-- id: 1
-- created_at: 2024-01-15T10:30:45.123456+00:00
```

### Failed Action (Permission Denied)

```sql
INSERT INTO admin_audit_logs (
  admin_user_id, session_id, action, resource_type, resource_id,
  correlation_id, ip_address, user_agent, role,
  status, error_message, request_duration_ms
) VALUES (
  2,
  'sess_def456uvw',
  'transfer_retry',
  'transfer_intent',
  '567890',
  'corr_req_12346',
  '203.0.113.43',
  'Mozilla/5.0 (X11; Linux x86_64)',
  'FinancialInvestigator',
  'failed',
  'Permission denied: transfers:retry',
  23
);

-- Result:
-- id: 2
-- created_at: 2024-01-15T10:30:48.456789+00:00
```

### Failed Action (Resource Not Found)

```sql
INSERT INTO admin_audit_logs (
  admin_user_id, session_id, action, resource_type, resource_id,
  correlation_id, ip_address, role,
  status, error_message, request_duration_ms
) VALUES (
  1,
  'sess_abc123xyz',
  'transfer_retry',
  'transfer_intent',
  '999999',
  'corr_req_12347',
  '203.0.113.42',
  'OperationsAdmin',
  'failed',
  'Transfer not found: 999999',
  42
);

-- Result:
-- id: 3
-- created_at: 2024-01-15T10:31:10.789123+00:00
```

## Changes Column (JSONB)

The `changes` column stores before/after state using JSONB format.

### Format

```json
{
  "field_name": {
    "old": "previous_value",
    "new": "new_value"
  },
  "another_field": {
    "old": null,
    "new": "newly_set"
  }
}
```

### Examples

**Transfer Status Change**
```json
{
  "status": {
    "old": "failed",
    "new": "processing"
  },
  "updated_at": {
    "old": "2024-01-14T15:00:00Z",
    "new": "2024-01-15T10:30:45Z"
  }
}
```

**Admin Role Change**
```json
{
  "role": {
    "old": "FinancialInvestigator",
    "new": "OperationsAdmin"
  },
  "updated_by": {
    "old": null,
    "new": 1
  }
}
```

**Multiple Field Update**
```json
{
  "name": {
    "old": "John Doe",
    "new": "John Smith"
  },
  "email": {
    "old": "john.doe@example.com",
    "new": "john.smith@example.com"
  },
  "updated_at": {
    "old": "2024-01-14T12:00:00Z",
    "new": "2024-01-15T09:15:30Z"
  }
}
```

## Querying Examples

### Get All Actions by Admin

```sql
SELECT id, action, resource_type, status, created_at
FROM admin_audit_logs
WHERE admin_user_id = 1
ORDER BY created_at DESC
LIMIT 50;
```

### Trace Full Request Flow

```sql
SELECT action, resource_type, resource_id, status, error_message, 
       created_at, request_duration_ms
FROM admin_audit_logs
WHERE correlation_id = 'corr_req_12345'
ORDER BY created_at ASC;
```

### Find Failed Actions

```sql
SELECT admin_user_id, action, resource_type, error_message, 
       ip_address, created_at
FROM admin_audit_logs
WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

### Get Actions in Date Range

```sql
SELECT admin_user_id, action, resource_type, status, created_at
FROM admin_audit_logs
WHERE created_at >= '2024-01-01'
  AND created_at < '2024-02-01'
ORDER BY created_at DESC;
```

### Count Actions by Type

```sql
SELECT action, COUNT(*) as count, COUNT(CASE WHEN status = 'failed' THEN 1 END) as failures
FROM admin_audit_logs
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY action
ORDER BY count DESC;
```

### Find Suspicious Activity (Failed Streaks)

```sql
SELECT admin_user_id, COUNT(*) as failed_count
FROM admin_audit_logs
WHERE status = 'failed'
  AND created_at > NOW() - INTERVAL '1 hour'
GROUP BY admin_user_id
HAVING COUNT(*) >= 5
ORDER BY failed_count DESC;
```

### Performance Analysis (Request Duration)

```sql
SELECT 
  action,
  COUNT(*) as total,
  AVG(request_duration_ms) as avg_duration,
  MIN(request_duration_ms) as min_duration,
  MAX(request_duration_ms) as max_duration,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY request_duration_ms) as p95
FROM admin_audit_logs
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY action
ORDER BY avg_duration DESC;
```

## Data Size Estimates

### Per Record

| Component | Size |
|-----------|------|
| Fixed fields | ~150 bytes |
| action | 20-50 bytes |
| resource_id | 10-30 bytes |
| changes (JSON) | 100-500 bytes |
| correlation_id | 30-40 bytes |
| ip_address | 15 bytes |
| user_agent | 100-200 bytes |
| error_message | 0-500 bytes |
| **Total average** | **~500 bytes** |

### Storage Scaling

| Records | Storage (uncompressed) | Index Size | Total |
|---------|---|---|---|
| 100K | ~50 MB | ~10 MB | ~60 MB |
| 1M | ~500 MB | ~100 MB | ~600 MB |
| 10M | ~5 GB | ~1 GB | ~6 GB |
| 100M | ~50 GB | ~10 GB | ~60 GB |
| 1B | ~500 GB | ~100 GB | ~600 GB |

## Backup & Recovery

### Regular Backups

```bash
# Full table backup
pg_dump -U admin -d manna_db -t admin_audit_logs > audit_logs.sql

# Compressed backup
pg_dump -U admin -d manna_db -t admin_audit_logs | gzip > audit_logs.sql.gz

# Daily incremental (with WAL archiving)
pg_basebackup -U admin -D /backup/daily -Ft -z
```

### Recovery

```bash
# Restore from SQL backup
psql -U admin -d manna_db < audit_logs.sql

# Restore from compressed backup
gunzip -c audit_logs.sql.gz | psql -U admin -d manna_db

# Point-in-time recovery (PITR)
pg_restore -U admin -d manna_db -t admin_audit_logs audit_logs.tar
```

## Maintenance

### Table Maintenance

```sql
-- Analyze table for query planner
ANALYZE admin_audit_logs;

-- Reindex if fragmented (rare)
REINDEX TABLE admin_audit_logs;

-- Vacuum (reclaim space from deletes - should be none)
VACUUM ANALYZE admin_audit_logs;
```

### Index Maintenance

```sql
-- Rebuild specific index
REINDEX INDEX idx_audit_logs_created_at;

-- Find unused indexes
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE tablename = 'admin_audit_logs'
  AND indexname NOT IN (SELECT indexname FROM pg_stat_user_indexes WHERE idx_scan > 0);
```

### Monitoring

```sql
-- Table size
SELECT pg_size_pretty(pg_total_relation_size('admin_audit_logs'));

-- Index sizes
SELECT indexname, pg_size_pretty(pg_relation_size(indexrelid)) as size
FROM pg_indexes
JOIN pg_stat_user_indexes ON indexname = indexrelname
WHERE tablename = 'admin_audit_logs'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Row count
SELECT COUNT(*) FROM admin_audit_logs;

-- Oldest record
SELECT created_at FROM admin_audit_logs ORDER BY created_at LIMIT 1;

-- Newest record
SELECT created_at FROM admin_audit_logs ORDER BY created_at DESC LIMIT 1;
```

## Migration

### Adding to Existing Production Database

```sql
-- Step 1: Create table with constraint
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES admin_users(id),
  session_id TEXT REFERENCES admin_sessions(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  changes JSONB,
  correlation_id VARCHAR(255),
  ip_address TEXT,
  user_agent TEXT,
  role TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  error_message TEXT,
  request_duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Step 2: Add indexes
CREATE INDEX idx_audit_logs_admin_user_id ON admin_audit_logs(admin_user_id);
CREATE INDEX idx_audit_logs_correlation_id ON admin_audit_logs(correlation_id);
CREATE INDEX idx_audit_logs_created_at ON admin_audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_action ON admin_audit_logs(action);
CREATE INDEX idx_audit_logs_resource_type ON admin_audit_logs(resource_type);

-- Step 3: Enable RLS and audit-only policies
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_no_update ON admin_audit_logs
  FOR UPDATE USING (FALSE);

CREATE POLICY audit_no_delete ON admin_audit_logs
  FOR DELETE USING (FALSE);

-- Step 4: Verify table is ready
SELECT COUNT(*) FROM admin_audit_logs;
```

### Enhancing Existing Table (Milestone 4 → Milestone 5)

```sql
-- Add new columns
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS session_id TEXT REFERENCES admin_sessions(id);
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS request_duration_ms INTEGER;

-- Add missing indexes
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_user_id ON admin_audit_logs(admin_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id ON admin_audit_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON admin_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_type ON admin_audit_logs(resource_type);
```

## Summary

The admin_audit_logs table provides:
- ✅ Immutable, append-only design
- ✅ Complete action tracking
- ✅ Correlation ID tracing
- ✅ Performance indexed
- ✅ State change tracking
- ✅ Error logging
- ✅ Scalable to 1B+ records
- ✅ Ready for compliance/forensics
