'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin-client';
import { DataTable } from '../components/DataTable';
import { CorrelationIdLink } from '../components/CorrelationIdLink';

interface ProviderEvent {
  id: number;
  provider: string;
  event_type: string;
  processing_status: string;
  correlation_id?: string;
  created_at: string;
}

export default function EventsPage() {
  const [events, setEvents] = useState<ProviderEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [provider, setProvider] = useState('');

  useEffect(() => {
    async function loadEvents() {
      try {
        setLoading(true);
        const result = await adminApi.searchProviderEvents(
          provider ? { provider } : {},
          page,
          50
        );

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setEvents(result.data.data || []);
          setTotalCount(result.data.total_count || 0);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadEvents();
  }, [page, provider]);

  const columns = [
    { header: 'ID', accessor: (e: ProviderEvent) => `#${e.id}` },
    { header: 'Provider', accessor: 'provider', className: 'font-medium' },
    { header: 'Event Type', accessor: 'event_type' },
    {
      header: 'Status',
      accessor: (e: ProviderEvent) => (
        <span
          className={`rounded px-2 py-1 text-xs font-medium ${
            e.processing_status === 'processed'
              ? 'bg-green-100 text-green-800'
              : e.processing_status === 'failed'
                ? 'bg-red-100 text-red-800'
                : 'bg-yellow-100 text-yellow-800'
          }`}
        >
          {e.processing_status}
        </span>
      ),
    },
    {
      header: 'Correlation ID',
      accessor: (e: ProviderEvent) => (
        <CorrelationIdLink correlationId={e.correlation_id} />
      ),
    },
    {
      header: 'Date',
      accessor: (e: ProviderEvent) =>
        new Date(e.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Provider Events</h1>

      <div className="rounded border border-gray-200 bg-white p-6">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Filter by Provider
          </label>
          <input
            type="text"
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setPage(1);
            }}
            placeholder="e.g., plaid, stripe"
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 md:w-64"
          />
        </div>
      </div>

      <DataTable<ProviderEvent>
        columns={columns}
        rows={events}
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
