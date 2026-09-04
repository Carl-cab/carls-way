# Audit Retention Policy

Policy for audit log retention, archival, compliance, and long-term storage.

## Current Policy (Milestone 5)

### Retention Duration

| Category | Duration | Justification |
|----------|----------|---|
| **Active Audit Logs** | Indefinite | All logs retained in production database |
| **Backup/Archive** | Not yet implemented | Planned for Milestone 6+ |
| **Compliance Hold** | 7 years (future) | SOC2, GDPR, financial regulations |

**Status**: Audit logs are currently retained indefinitely in the operational database. Archival and purging strategies are planned for future milestones.

### Storage Impact

At current growth rate:
- **1 year of logs**: ~6GB (assuming 1M actions/month)
- **5 years of logs**: ~30GB
- **7 years of logs**: ~42GB (compliance minimum)

## Compliance Requirements

### SOC2 Compliance

**Requirement**: Maintain audit logs for minimum 1 year
**Current Status**: ✅ Met (indefinite retention)

SOC2 CC6.1 requires:
- Logical access monitoring ✅
- User activity tracking ✅
- System configuration changes ✅
- Security-relevant events ✅

### GDPR Compliance

**Requirement**: Keep personal data only as long as necessary
**Risk**: Audit logs may contain personal data (emails, IPs)

**Mitigation**:
- Implement anonymization/pseudonymization (future)
- Provide audit log exports for data subjects (future)
- Implement right-to-erasure for non-essential logs (future)

### HIPAA Compliance

If handling health information (currently not):
- Minimum 6 years retention
- Encryption required
- Access logs required

## Archival Strategy (Milestone 6+)

### Tiered Storage

```
Tier 1: Operational Database (HOT)
├─ Data: Current month + 6 months
├─ Speed: < 20ms queries
├─ Cost: $$$$ (frequent access)
└─ Access: Online, indexed

Tier 2: Cold Storage (WARM)
├─ Data: 6 months - 2 years old
├─ Speed: Minutes to hours
├─ Cost: $$ (infrequent access)
└─ Access: Requires restore, indexed archive

Tier 3: Glacier/Archive (COLD)
├─ Data: 2+ years old
├─ Speed: Hours to days
├─ Cost: $ (rare access)
└─ Access: Requires restore, unindexed
```

### Implementation Timeline

**Milestone 5** (Current):
- ✅ Immutable audit logs
- ✅ Query and export
- ❌ Archival not implemented

**Milestone 6** (Planned):
- Archive logs > 6 months to cold storage
- Implement data retention policies
- Add compliance holds
- Export older logs on demand

**Milestone 7+** (Future):
- Implement GDPR right-to-erasure (anonymization)
- Add data classification
- Implement purge policies
- Add archival validation

## Purge Policy (Future)

### When Can Logs Be Purged?

Audit logs can be purged after:
1. **Compliance period expires**: Default 7 years (configurable)
2. **Explicit purge request**: SuperAdmin authorization required
3. **Legal hold expires**: After litigation/investigation complete
4. **Data subject erasure**: GDPR article 17 (future)

### Logs That Cannot Be Purged

- ❌ Logs related to active investigations
- ❌ Logs under legal hold
- ❌ Logs during active litigation
- ❌ Logs needed for compliance

### Purge Procedure (Future)

```typescript
interface PurgeRequest {
  reason: 'policy_expiry' | 'legal_hold_expired' | 'investigation_complete';
  startDate: Date;
  endDate: Date;
  minAge: number; // days (prevent accidental purge)
  approvedBy: number; // SuperAdmin ID
}

async function purgeAuditLogs(request: PurgeRequest) {
  // 1. Verify authorization
  requireSuperAdmin();

  // 2. Backup before purge
  await backupAuditLogsInRange(request.startDate, request.endDate);

  // 3. Verify not under hold
  const holds = await checkLegalHolds(request.startDate, request.endDate);
  if (holds.length > 0) {
    throw new Error('Cannot purge: legal hold active');
  }

  // 4. Archive before deleting
  await archiveAuditLogs(request.startDate, request.endDate);

  // 5. Soft delete (mark as archived)
  await markAsArchived(request.startDate, request.endDate);

  // 6. Log the purge action
  await auditLogAction({
    action: 'audit_logs_purged',
    resource_type: 'audit_log',
    changes: {
      count: holdCount,
      reason: request.reason,
      date_range: { old: null, new: [request.startDate, request.endDate] }
    }
  });
}
```

## Data Retention by Event Type

### High-Risk Events (Keep Longest)

```
✓ Failed Login Attempts    → 2 years (security)
✓ Permission Denials       → 2 years (access control)
✓ Admin Creations/Deletions → 7 years (compliance)
✓ Role Changes             → 7 years (compliance)
✓ System Configuration     → 7 years (SOC2)
```

### Standard Events (Keep Standard Period)

```
✓ Transfer Retries         → 1 year (operational)
✓ Event Replays            → 1 year (operational)
✓ Query/Export             → 90 days (operational)
✓ Admin Logins (Success)   → 90 days (audit)
```

### Low-Risk Events (Can Purge Sooner)

```
✓ View Operations          → 30 days (audit)
✓ Read-Only Queries        → 30 days (audit)
```

## Export & Compliance

### Annual Compliance Export

```typescript
// Generate annual audit export for compliance
async function generateAnnualComplianceReport(year: number) {
  const service = getAuditExportService();

  const startDate = new Date(year, 0, 1);
  const endDate = new Date(year + 1, 0, 1);

  // Export all actions
  const json = await service.exportAsJSON({
    startDate,
    endDate,
  });

  // Sign export
  const hash = crypto.createHash('sha256').update(json).digest('hex');

  // Store with signature
  const report = {
    year,
    export_date: new Date().toISOString(),
    exported_by: getCurrentAdmin().email,
    record_count: JSON.parse(json).audit_logs.length,
    sha256_hash: hash,
    file_path: `compliance/audit_export_${year}.json.gz`,
  };

  // Persist report metadata
  await storeComplianceReport(report);

  return report;
}
```

### Audit Log Certificate

```typescript
interface AuditCertificate {
  start_date: Date;
  end_date: Date;
  record_count: number;
  sha256_hash: string;
  signed_by: string; // SuperAdmin email
  signature: string; // Digital signature
  certificate_date: Date;
}

// Generate certificate for audit period
async function generateAuditCertificate(
  startDate: Date,
  endDate: Date
): Promise<AuditCertificate> {
  const service = getAuditExportService();

  const csv = await service.exportAsCSV({ startDate, endDate });

  const hash = crypto.createHash('sha256').update(csv).digest('hex');
  const admin = getCurrentAdmin();

  // Sign with private key (future: implement)
  const signature = await signWithPrivateKey(hash);

  const certificate: AuditCertificate = {
    start_date: startDate,
    end_date: endDate,
    record_count: csv.split('\n').length - 1,
    sha256_hash: hash,
    signed_by: admin.email,
    signature,
    certificate_date: new Date(),
  };

  return certificate;
}
```

## Disaster Recovery

### Backup Strategy

**Frequency**: Daily full backup
**Retention**: 30 days

```bash
# Daily backup script
pg_dump -Fc manna_db | gzip > backups/manna_$(date +%Y%m%d).sql.gz

# Verify backup
pg_restore -l backups/manna_20240115.sql.gz | head

# Test restore quarterly
pg_restore -d test_manna backups/manna_20240101.sql.gz
```

### Recovery Procedure

1. **Detect Audit Corruption** (e.g., unauthorized deletion)
2. **Isolate System** (stop new writes)
3. **Determine Recovery Point** (choose backup date)
4. **Restore to Point-in-Time** (use WAL if available)
5. **Verify Integrity** (run immutability check)
6. **Bring Online** (resume operations)

### Testing

```typescript
// Quarterly restore test
async function testAuditLogRecovery() {
  const testDb = 'manna_test';

  // 1. Restore from backup
  exec(`pg_restore -d ${testDb} backups/manna_$(date -d "30 days ago" +%Y%m%d).sql.gz`);

  // 2. Verify table exists
  const rows = await sql`SELECT COUNT(*) FROM admin_audit_logs`;
  console.log(`Restored ${rows[0].count} audit logs`);

  // 3. Check immutability
  const immutable = await getAuditLogRepository().verifyImmutability();
  console.log(`Immutability check: ${immutable ? '✅' : '❌'}`);

  // 4. Cleanup
  exec(`dropdb ${testDb}`);
}
```

## Compliance Holds

Certain audit logs must be held indefinitely pending:
- Active investigations
- Litigation
- Regulatory inquiries
- Security incidents

### Implementation (Future)

```typescript
interface LegalHold {
  hold_id: string;
  reason: 'investigation' | 'litigation' | 'regulatory' | 'security';
  start_date: Date;
  end_date?: Date;
  description: string;
  authorized_by: number;
  created_at: Date;
}

async function placeLegalHold(hold: LegalHold) {
  requireSuperAdmin();

  // Log the hold
  await sql`
    INSERT INTO legal_holds (hold_id, reason, start_date, description, authorized_by)
    VALUES (${hold.hold_id}, ${hold.reason}, ${hold.start_date}, ${hold.description}, ${hold.authorized_by})
  `;

  // Prevent purge of affected logs
  // Purge function will check for active holds before deleting
}

async function releaseLegalHold(holdId: string) {
  requireSuperAdmin();

  await sql`
    UPDATE legal_holds SET end_date = NOW() WHERE hold_id = ${holdId}
  `;

  // Logs can now be purged after retention period
}
```

## Encryption & Sensitive Data

### Current (Milestone 5)
- ✅ Audit logs stored in encrypted PostgreSQL connection
- ✅ No plaintext passwords in logs
- ❌ Logs not encrypted at rest (future)

### Future (Milestone 6+)
- Encrypt logs at rest with customer-managed keys
- Implement field-level encryption for sensitive data
- Add HMAC for integrity verification

## Monitoring & Alerts

### Retention Policy Violation

Alert when:
```sql
-- Alert: Logs older than retention period not purged
SELECT COUNT(*) as old_logs
FROM admin_audit_logs
WHERE created_at < CURRENT_DATE - INTERVAL '7 years'
  AND status != 'archived';
-- If count > 0: ALERT!
```

### Storage Threshold

Alert when:
```sql
-- Alert: Database growing too fast
SELECT pg_size_pretty(pg_total_relation_size('admin_audit_logs'));
-- If > threshold: ALERT!
```

## Policy Configuration (Future)

```typescript
interface AuditRetentionPolicy {
  active_retention_days: number;      // Keep in hot storage
  archive_after_days: number;         // Move to cold storage
  compliance_retention_years: number; // Minimum legal retention
  default_purge_enabled: boolean;     // Allow auto-purge
  legal_hold_enabled: boolean;        // Support legal holds
  encryption_enabled: boolean;        // Encrypt at rest
}

const policy: AuditRetentionPolicy = {
  active_retention_days: 180,      // 6 months
  archive_after_days: 365,         // 1 year
  compliance_retention_years: 7,   // 7 years
  default_purge_enabled: false,    // Manual purge only
  legal_hold_enabled: true,
  encryption_enabled: false,       // Future
};
```

## Summary

**Current Status** (Milestone 5):
- ✅ Indefinite retention in operational database
- ✅ Export for compliance
- ❌ Archival not implemented
- ❌ Purge policies not implemented
- ❌ Legal holds not implemented

**Milestone 6+**:
- Archive logs > 6 months to cold storage
- Implement retention policies
- Add legal hold support
- Enable data purging
- Implement compliance exports

**Compliance Readiness**:
- ✅ SOC2 (indefinite retention)
- ⚠️ GDPR (future: erasure support)
- ⚠️ HIPAA (future: 6-year retention)
- ⚠️ PCI-DSS (future: encryption + retention)

This policy ensures audit logs are retained appropriately for compliance while optimizing storage and managing data lifecycle over time.
