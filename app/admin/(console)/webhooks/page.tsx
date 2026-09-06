'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin-client';
import { DataTable } from '../components/DataTable';
import { CorrelationIdLink } from '../components/CorrelationIdLink';

interface Webhook {
  id: number;
  provider: string;
  event_type: string;
  status: string;
  processing_attempts: number;
  correlation_id?: string;
  created_at: string;
}

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    async function loadWebhooks() {
      try {
        setLoading(true);
        const result = await adminApi.searchWebhooks(
          statusFilter ? { status: statusFilter } : {},
          page,
          50
        );

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setWebhooks(result.data.data || []);
          setTotalCount(result.data.total_count || 0);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadWebhooks();
  }, [page, statusFilter]);

  const columns = [
    { header: 'ID', accessor: (w: Webhook) => `#${w.id}` },
    { header: 'Provider', accessor: 'provider', className: 'font-medium' },
    { header: 'Event Type', accessor: 'event_type' },
    {
      header: 'Status',
      accessor: (w: Webhook) => (
        <span
          className={`rounded px-2 py-1 text-xs font-medium ${
            w.status === 'processed'
              ? 'bg-green-100 text-green-800'
              : w.status === 'failed'
                ? 'bg-red-100 text-red-800'
                : 'bg-yellow-100 text-yellow-800'
          }`}
        >
          {w.status}
        </span>
      ),
    },
    {
      header: 'Retries',
      accessor: 'processing_attempts',
      className: 'text-center',
    },
    {
      header: 'Correlation ID',
      accessor: (w: Webhook) => (
        <CorrelationIdLink correlationId={w.correlation_id} />
      ),
    },
    {
      header: 'Date',
      accessor: (w: Webhook) =>
        new Date(w.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Webhooks</h1>

      <div className="rounded border border-gray-200 bg-white p-6">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Filter by Status
          </label>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="mt-1 rounded border border-gray-300 px-3 py-2"
          >
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="processed">Processed</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>

      <DataTable<Webhook>
        columns={columns}
        rows={webhooks}
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
