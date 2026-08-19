'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { adminApi } from '@/lib/admin-client';
import { DataTable } from '../components/DataTable';
import { CorrelationIdBadge } from '../components/CorrelationIdLink';

interface Stats {
  totalTransfers: number;
  totalWebhooks: number;
  totalAuditLogs: number;
  recentTransfers: RecentTransfer[];
  recentActivity: RecentActivity[];
  auditStats: AuditStats | null;
  webhookStats: unknown;
}

/** Fields of a transfer rendered by the "Recent Transfers" card. */
interface RecentTransfer {
  id: number;
  status: string;
  amount: string | number;
  currency: string;
  correlation_id?: string;
  created_at: string;
}

/** Fields of an audit entry rendered by the "Your Activity" card. */
interface RecentActivity {
  action?: string;
  resource_type?: string;
  status?: string;
  created_at: string;
}

/** Summary shape returned by /api/admin/audit-logs/stats?type=summary. */
interface AuditStats {
  total_events?: number;
  success_rate?: number;
  by_status?: { success?: number; failed?: number };
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadStats() {
      try {
        setLoading(true);
        const [transfers, audit, webhooks, myActivity] = await Promise.all([
          adminApi.searchTransfers({}, 1, 5),
          adminApi.getAuditStats('summary'),
          adminApi.searchWebhooks({}, 1, 5),
          adminApi.getMyActivity(5),
        ]);

        if (!transfers.data || !audit.data || !webhooks.data) {
          setError('Failed to load dashboard data');
          return;
        }

        setStats({
          totalTransfers: transfers.data.total_count || 0,
          totalWebhooks: webhooks.data.total_count || 0,
          totalAuditLogs: audit.data.total_events || 0,
          recentTransfers: transfers.data.data || [],
          recentActivity: myActivity.data?.audit_logs || [],
          auditStats: audit.data,
          webhookStats: webhooks.data,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadStats();
  }, []);

  if (loading) {
    return <div className="text-center py-8">Loading dashboard...</div>;
  }

  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        Error: {error}
      </div>
    );
  }

  if (!stats) {
    return <div className="text-center py-8">No data available</div>;
  }

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold text-gray-900">Operations Dashboard</h1>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <StatCard title="Total Transfers" value={stats.totalTransfers} href="/admin/transfers" />
        <StatCard title="Total Webhooks" value={stats.totalWebhooks} href="/admin/webhooks" />
        <StatCard title="Audit Events" value={stats.totalAuditLogs} href="/admin/audit" />
        <StatCard
          title="Success Rate"
          value={
            stats.auditStats?.success_rate
              ? `${(stats.auditStats.success_rate as number).toFixed(1)}%`
              : 'N/A'
          }
        />
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recent Transfers */}
        <div className="rounded border border-gray-200 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Recent Transfers</h2>
            <Link href="/admin/transfers" className="text-sm text-red-700 hover:underline">
              View all →
            </Link>
          </div>
          {stats.recentTransfers.length > 0 ? (
            <div className="space-y-3">
              {stats.recentTransfers.map((t) => (
                <Link
                  key={t.id}
                  href={`/admin/transfers?id=${t.id}`}
                  className="block rounded border border-gray-100 p-3 hover:bg-gray-50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-gray-900">ID {t.id}</p>
                      <p className="text-xs text-gray-600">Status: {t.status}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">{t.amount} {t.currency}</p>
                      <p className="text-xs text-gray-600">
                        {new Date(t.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  {t.correlation_id && (
                    <div className="mt-2">
                      <CorrelationIdBadge correlationId={t.correlation_id} />
                    </div>
                  )}
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-gray-600">No recent transfers</p>
          )}
        </div>

        {/* Recent Activity */}
        <div className="rounded border border-gray-200 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">Your Activity</h2>
            <Link href="/admin/audit" className="text-sm text-red-700 hover:underline">
              View all →
            </Link>
          </div>
          {stats.recentActivity.length > 0 ? (
            <div className="space-y-3">
              {stats.recentActivity.map((activity, idx) => (
                <div
                  key={idx}
                  className="rounded border border-gray-100 p-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-gray-900">
                        {activity.action || 'Unknown Action'}
                      </p>
                      <p className="text-xs text-gray-600">
                        {activity.resource_type || 'N/A'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-medium text-gray-600">
                        {activity.status === 'success' ? '✓' : '✗'} {activity.status}
                      </p>
                      <p className="text-xs text-gray-600">
                        {new Date(activity.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-600">No recent activity</p>
          )}
        </div>
      </div>

      {/* Audit Summary */}
      <div className="rounded border border-gray-200 p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Audit Summary</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <p className="text-sm text-gray-600">Total Actions</p>
            <p className="text-2xl font-bold text-gray-900">
              {stats.auditStats?.total_events || 0}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Successful</p>
            <p className="text-2xl font-bold text-green-600">
              {stats.auditStats?.by_status?.success || 0}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Failed</p>
            <p className="text-2xl font-bold text-red-600">
              {stats.auditStats?.by_status?.failed || 0}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Success Rate</p>
            <p className="text-2xl font-bold text-blue-600">
              {stats.auditStats?.success_rate
                ? `${(stats.auditStats.success_rate as number).toFixed(1)}%`
                : 'N/A'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  href,
}: {
  title: string;
  value: string | number;
  href?: string;
}) {
  const content = (
    <div className="rounded border border-gray-200 bg-white p-6">
      <p className="text-sm font-medium text-gray-600">{title}</p>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
    </div>
  );

  if (href) {
    return <Link href={href} className="hover:shadow-md transition-shadow">{content}</Link>;
  }

  return content;
}
