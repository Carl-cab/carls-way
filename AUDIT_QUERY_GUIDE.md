# Audit Query Guide

Practical guide for querying, analyzing, and exporting audit logs.

## Quick Start

### Get Recent Actions

```typescript
import { getAuditQueryService } from '@/lib/rbac';

const queryService = getAuditQueryService();

// Get recent actions (page 1, 50 per page)
const result = await queryService.queryPage(1, 50);

console.log(`Total: ${result.total_count}`);
console.log(`Actions: ${result.records.map(r => r.action).join(', ')}`);
```

### Get My Recent Activity

```typescript
const logs = await queryService.getMyActivity(20);

logs.forEach(log => {
  console.log(`${log.created_at} - ${log.action} on ${log.resource_type} - ${log.status}`);
});
```

### Trace a Specific Request

```typescript
const correlationId = req.headers.get('x-correlation-id');

const trace = await queryService.traceByCorrelationId(correlationId);

console.log('Request flow:');
trace.forEach(log => {
  console.log(`  [${log.created_at.toISOString()}] ${log.action} - ${log.status}`);
});
```

## Common Queries

### Find Failed Actions in Last 24 Hours

```typescript
const failures = await queryService.queryPage(1, 100, {
  status: 'failed',
  startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
});

console.log(`${failures.total_count} failed actions in last 24h`);
failures.records.forEach(log => {
  console.log(`  ${log.action}: ${log.error_message}`);
});
```

### Get Admin Activity

```typescript
const adminId = 1;
const activity = await queryService.getAdminActivity(adminId, 100);

console.log(`Admin ${adminId} performed ${activity.length} actions`);
activity.forEach(log => {
  console.log(`  ${log.created_at} - ${log.action}`);
});
```

### Find All Transfer Retries

```typescript
const retries = await queryService.queryPage(1, 1000, {
  action: 'transfer_retry',
});

console.log(`${retries.total_count} transfer retry actions`);

const successCount = retries.records.filter(r => r.status === 'success').length;
const failureCount = retries.records.filter(r => r.status === 'failed').length;

console.log(`Success: ${successCount}, Failed: ${failureCount}`);
```

### Get Actions on Specific Resource

```typescript
const transferId = '12345';

const logs = await queryService.queryPage(1, 50, {
  resourceType: 'transfer_intent',
});

const relevant = logs.records.filter(r => r.resource_id === transferId);

console.log(`${relevant.length} actions on transfer ${transferId}:`);
relevant.forEach(log => {
  console.log(`  ${log.action} - ${log.status}`);
});
```

## Analysis

### Get Audit Summary

```typescript
const summary = await queryService.getSummary(
  new Date('2024-01-01'),
  new Date('2024-01-31')
);

console.log(`January Summary:`);
console.log(`  Total Actions: ${summary.total_actions}`);
console.log(`  Successful: ${summary.successful_actions}`);
console.log(`  Failed: ${summary.failed_actions}`);
console.log(`  Failure Rate: ${summary.failure_rate}%`);

console.log(`\nTop Actions:`);
summary.most_common_actions.slice(0, 5).forEach(({ action, count }) => {
  console.log(`  ${action}: ${count}`);
});

console.log(`\nMost Active Admins:`);
summary.most_active_admins.slice(0, 5).forEach(({ admin_id, count }) => {
  console.log(`  Admin ${admin_id}: ${count} actions`);
});
```

### Get Performance Metrics

```typescript
const perf = await queryService.getPerformanceStats(
  new Date('2024-01-01'),
  new Date('2024-01-31')
);

console.log(`Performance (January):`);
console.log(`  Average: ${perf.average_request_duration_ms}ms`);
console.log(`  Median: ${perf.median_request_duration_ms}ms`);
console.log(`  P95: ${perf.p95_request_duration_ms}ms`);
console.log(`  P99: ${perf.p99_request_duration_ms}ms`);
console.log(`  Min: ${perf.min_request_duration_ms}ms`);
console.log(`  Max: ${perf.max_request_duration_ms}ms`);
```

### Find Suspicious Activity

```typescript
const suspicious = await queryService.findSuspiciousActivity(
  new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
  new Date()
);

if (suspicious.length === 0) {
  console.log('No suspicious activity detected');
} else {
  console.log(`${suspicious.length} suspicious activities found:\n`);

  suspicious.forEach(activity => {
    console.log(`${activity.type} (${activity.severity}):`);
    console.log(`  ${activity.description}`);
    console.log(`  Evidence:`);
    activity.evidence.slice(0, 3).forEach(log => {
      console.log(`    - ${log.created_at}: ${log.action} - ${log.error_message}`);
    });
  });
}
```

### Get Request Timeline

```typescript
const timeline = await queryService.getTimeline('corr_req_abc123');

console.log('Request Timeline:');
console.log('┌─────────────────────┬──────────────┬──────────────┬─────────┐');
console.log('│ Timestamp           │ Admin Role   │ Action       │ Status  │');
console.log('├─────────────────────┼──────────────┼──────────────┼─────────┤');

timeline.forEach(event => {
  console.log(`│ ${event.timestamp.toISOString().slice(0, 19)} │ ${event.admin_role.padEnd(12)} │ ${event.action.padEnd(12)} │ ${event.status} │`);
});

console.log('└─────────────────────┴──────────────┴──────────────┴─────────┘');
```

## Export

### Export as JSON

```typescript
import { getAuditExportService } from '@/lib/rbac';

const exportService = getAuditExportService();

const json = await exportService.exportAsJSON({
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-01-31'),
});

// Save to file
fs.writeFileSync('audit_export_jan.json', json);

console.log('Exported to audit_export_jan.json');
```

### Export as CSV

```typescript
const csv = await exportService.exportAsCSV({
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-01-31'),
  action: 'transfer_retry',
});

// Save to file
fs.writeFileSync('transfer_retries_jan.csv', csv);

console.log('Exported to transfer_retries_jan.csv');
```

### Get Export Preview

```typescript
const summary = await exportService.getExportSummary({
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-01-31'),
});

console.log(`Export Preview:`);
console.log(`  Records: ${summary.record_count}`);
console.log(`  Date Range: ${summary.date_range.start} to ${summary.date_range.end}`);

console.log(`\n  Top Actions:`);
Object.entries(summary.actions)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .forEach(([action, count]) => {
    console.log(`    ${action}: ${count}`);
  });
```

## Forensics & Investigation

### Investigate User Access Pattern

```typescript
const adminId = 2;

// Get all their recent actions
const activity = await queryService.getAdminActivity(adminId, 500);

// Group by action
const actionGroups = {};
activity.forEach(log => {
  if (!actionGroups[log.action]) {
    actionGroups[log.action] = [];
  }
  actionGroups[log.action].push(log);
});

// Analyze
console.log(`Admin ${adminId} activity analysis:`);
Object.entries(actionGroups).forEach(([action, logs]) => {
  const failures = logs.filter(l => l.status === 'failed').length;
  console.log(`  ${action}: ${logs.length} total, ${failures} failed`);
});
```

### Investigate Failed Operation

```typescript
const correlationId = 'corr_req_xyz';

const trace = await queryService.traceByCorrelationId(correlationId);

const failed = trace.find(log => log.status === 'failed');

if (failed) {
  console.log(`Request failed at: ${failed.action}`);
  console.log(`Error: ${failed.error_message}`);
  console.log(`Duration: ${failed.duration_ms}ms`);
  console.log(`Admin: ${failed.admin_id} (${failed.admin_role})`);
  console.log(`IP: ${failed.ip_address}`);

  console.log(`\nFull trace:`);
  trace.forEach(log => {
    const arrow = log.status === 'failed' ? '❌' : '✅';
    console.log(`  ${arrow} ${log.action} (${log.duration_ms}ms)`);
  });
}
```

### Find Admin Abuse Pattern

```typescript
// Look for rapid failed attempts (brute force?)
const suspicious = await queryService.findSuspiciousActivity(
  new Date(Date.now() - 60 * 60 * 1000) // Last hour
);

const failedStreaks = suspicious.filter(s => s.type === 'failed_streak');

if (failedStreaks.length > 0) {
  console.log('⚠️  ALERT: Potential brute force or abuse detected\n');

  failedStreaks.forEach(streak => {
    console.log(`${streak.description}`);
    const firstLog = streak.evidence[0];
    const lastLog = streak.evidence[streak.evidence.length - 1];
    const durationMinutes = (
      (new Date(lastLog.created_at).getTime() - new Date(firstLog.created_at).getTime()) / 
      60000
    ).toFixed(1);
    console.log(`  Time window: ${durationMinutes} minutes`);
    console.log(`  From IP: ${firstLog.ip_address}\n`);
  });
} else {
  console.log('✅ No suspicious activity detected');
}
```

## Raw SQL Queries

For advanced analysis, use raw SQL:

### Complex Date Analysis

```sql
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_actions,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_actions,
  ROUND(100.0 * COUNT(CASE WHEN status = 'failed' THEN 1 END) / COUNT(*), 2) as failure_rate
FROM admin_audit_logs
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

### Admin Comparison

```sql
SELECT 
  au.email,
  au.role,
  COUNT(*) as total_actions,
  COUNT(CASE WHEN aal.status = 'success' THEN 1 END) as successful,
  COUNT(CASE WHEN aal.status = 'failed' THEN 1 END) as failed,
  AVG(aal.request_duration_ms) as avg_duration_ms
FROM admin_audit_logs aal
JOIN admin_users au ON au.id = aal.admin_user_id
WHERE aal.created_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY au.id, au.email, au.role
ORDER BY total_actions DESC;
```

### Action Trend

```sql
SELECT 
  action,
  DATE(created_at) as date,
  COUNT(*) as count,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failures
FROM admin_audit_logs
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY action, DATE(created_at)
ORDER BY date DESC, count DESC;
```

### Error Analysis

```sql
SELECT 
  action,
  error_message,
  COUNT(*) as occurrences,
  COUNT(DISTINCT admin_user_id) as affected_admins
FROM admin_audit_logs
WHERE status = 'failed'
  AND created_at >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY action, error_message
ORDER BY occurrences DESC;
```

## Scheduled Reports

### Daily Audit Summary

```typescript
// Scheduled job: Run daily at midnight
async function generateDailyAuditReport() {
  const queryService = getAuditQueryService();

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const summary = await queryService.getSummary(yesterday, today);
  const perf = await queryService.getPerformanceStats(yesterday, today);

  const report = `
Daily Audit Report - ${yesterday.toISOString().split('T')[0]}

Actions Summary:
- Total: ${summary.total_actions}
- Successful: ${summary.successful_actions}
- Failed: ${summary.failed_actions}
- Failure Rate: ${summary.failure_rate}%

Performance:
- Average Duration: ${perf.average_request_duration_ms}ms
- P95 Duration: ${perf.p95_request_duration_ms}ms
- Max Duration: ${perf.max_request_duration_ms}ms

Top Actions:
${summary.most_common_actions.slice(0, 5).map(a => `- ${a.action}: ${a.count}`).join('\n')}

Most Active Admins:
${summary.most_active_admins.slice(0, 5).map(a => `- Admin ${a.admin_id}: ${a.count} actions`).join('\n')}
`;

  // Send report
  await sendEmailReport('audit@example.com', report);
}
```

## Compliance Export

### SOC2 Audit Export

```typescript
async function exportSOC2Audit(year: number, month: number) {
  const exportService = getAuditExportService();

  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);

  const csv = await exportService.exportAsCSV({
    startDate,
    endDate,
  });

  // Save with compliance naming
  const filename = `SOC2_Audit_${year}_${String(month).padStart(2, '0')}.csv`;
  fs.writeFileSync(filename, csv);

  // Sign with hash
  const hash = crypto.createHash('sha256').update(csv).digest('hex');
  fs.writeFileSync(`${filename}.sha256`, hash);

  console.log(`Generated ${filename} (hash: ${hash})`);
}
```

## Tips & Best Practices

1. **Use Indexes**: Query with indexed columns first (admin_user_id, created_at, action)
2. **Limit Results**: Always paginate or use LIMIT to avoid memory issues
3. **Filter Date Ranges**: Narrow to specific dates when possible for performance
4. **Correlation IDs**: Always include correlation ID when logging for traceability
5. **Export Format**: Use JSON for parsing, CSV for spreadsheets
6. **Archive Old Logs**: Consider archiving logs older than 1 year to S3
7. **Alert on Failures**: Set up alerts for suspicious patterns
8. **Regular Reports**: Generate weekly/monthly reports for compliance

## Troubleshooting

### Query Timeout

If queries timeout:
1. Narrow the date range
2. Reduce page size
3. Add more specific filters
4. Check if indexes are present

### Missing Logs

If expected logs aren't appearing:
1. Verify correlation ID is set
2. Check that audit middleware is applied
3. Ensure admin is authenticated
4. Check admin permissions

### Performance Issues

If analysis is slow:
1. Increase page size for fewer requests
2. Use raw SQL for complex queries
3. Filter by date first
4. Consider archiving old data

## Summary

This guide covers:
- ✅ Basic queries
- ✅ Analysis and metrics
- ✅ Export and compliance
- ✅ Forensics and investigation
- ✅ Scheduled reports
- ✅ SQL examples
- ✅ Troubleshooting

For API reference, see AUDIT_ARCHITECTURE.md
