'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin-client';
import { DataTable } from '../components/DataTable';

interface AuditLog {
  id: number;
  admin_user_id: number;
  action: string;
  resource_type: string;
  status: 'success' | 'failed';
  correlation_id?: string;
  created_at: string;
  request_duration_ms?: number;
}

/** Summary shape returned by /api/admin/audit-logs/stats?type=summary. */
interface AuditSummaryStats {
  total_events?: number;
  success_rate?: number;
  by_status?: { success?: number; failed?: number };
}

export default function AuditPage() {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [stats, setStats] = useState<AuditSummaryStats | null>(null);

  const [filters, setFilters] = useState({
    action: '',
    resourceType: '',
    status: '',
  });

  useEffect(() => {
    async function loadAuditLogs() {
      try {
        setLoading(true);
        setError(null);

        const filterObj = {
          action: filters.action || undefined,
          resource_type: filters.resourceType || undefined,
          status: filters.status || undefined,
        };

        const [result, statsResult] = await Promise.all([
          adminApi.searchAuditLogs(filterObj, page, 50),
          adminApi.getAuditStats('summary'),
        ]);

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setAuditLogs(result.data.data || []);
          setTotalCount(result.data.total_count || 0);
        }

        if (statsResult.data) {
          setStats(statsResult.data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadAuditLogs();
  }, [page, filters]);

  const columns = [
    {
      header: 'Admin',
      accessor: (log: AuditLog) => `Admin ${log.admin_user_id}`,
    },
    {
      header: 'Action',
      accessor: (log: AuditLog) => log.action,
      className: 'font-medium',
    },
    {
      header: 'Resource',
      accessor: (log: AuditLog) => log.resource_type,
    },
    {
      header: 'Status',
      accessor: (log: AuditLog) => (
        <span
          className={`rounded px-2 py-1 text-xs font-medium ${
            log.status === 'success'
              ? 'bg-green-100 text-green-800'
              : 'bg-red-100 text-red-800'
          }`}
        >
          {log.status === 'success' ? '✓' : '✗'} {log.status}
        </span>
      ),
    },
    {
      header: 'Duration (ms)',
      accessor: (log: AuditLog) => log.request_duration_ms || '-',
      className: 'text-right',
    },
    {
      header: 'Timestamp',
      accessor: (log: AuditLog) =>
        new Date(log.created_at).toLocaleString(),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Audit Logs</h1>

      {/* Stats */}
      {stats && (
        <div className="rounded border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Summary</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <p className="text-sm text-gray-600">Total Events</p>
              <p className="text-2xl font-bold text-gray-900">
                {stats.total_events || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Success Rate</p>
              <p className="text-2xl font-bold text-green-600">
                {(stats.success_rate || 0).toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Successful</p>
              <p className="text-2xl font-bold text-gray-900">
                {stats.by_status?.success || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Failed</p>
              <p className="text-2xl font-bold text-blue-600">
                {stats.by_status?.failed || 0}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="rounded border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Filter</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Action
            </label>
            <input
              type="text"
              value={filters.action}
              onChange={(e) => {
                setFilters({ ...filters, action: e.target.value });
                setPage(1);
              }}
              placeholder="e.g., list_admins"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Resource Type
            </label>
            <input
              type="text"
              value={filters.resourceType}
              onChange={(e) => {
                setFilters({ ...filters, resourceType: e.target.value });
                setPage(1);
              }}
              placeholder="e.g., admin_user"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Status
            </label>
            <select
              value={filters.status}
              onChange={(e) => {
                setFilters({ ...filters, status: e.target.value });
                setPage(1);
              }}
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
            >
              <option value="">All Statuses</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
      </div>

      {/* Data Table */}
      <DataTable<AuditLog>
        columns={columns}
        rows={auditLogs}
        isLoading={loading}
        error={error}
        totalCount={totalCount}
        page={page}
        pageSize={50}
        onPageChange={setPage}
      />
    </div>
  );
}
