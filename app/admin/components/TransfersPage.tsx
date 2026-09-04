'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { adminApi } from '@/lib/admin-client';
import { DataTable } from './DataTable';
import { CorrelationIdLink } from './CorrelationIdLink';

interface Transfer {
  id: number;
  user_id: number;
  amount: string;
  currency: string;
  status: string;
  provider: string;
  correlation_id?: string;
  created_at: string;
}

export function TransfersPage() {
  const searchParams = useSearchParams();
  const initialId = searchParams.get('id');

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedTransfer, setSelectedTransfer] = useState<Transfer | null>(null);

  const [filters, setFilters] = useState({
    status: '',
    provider: '',
    correlationId: '',
  });

  useEffect(() => {
    async function loadTransfers() {
      try {
        setLoading(true);
        setError(null);

        const filterObj = {
          status: filters.status || undefined,
          provider: filters.provider || undefined,
          correlation_id: filters.correlationId || undefined,
        };

        const result = await adminApi.searchTransfers(filterObj, page, 50);

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setTransfers(result.data.data || []);
          setTotalCount(result.data.total_count || 0);

          // If looking for specific ID, find and select it
          if (initialId) {
            const found = result.data.data?.find(
              (t: Transfer) => t.id === parseInt(initialId)
            );
            if (found) {
              setSelectedTransfer(found);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadTransfers();
  }, [page, filters, initialId]);

  const columns = [
    {
      header: 'ID',
      accessor: (t: Transfer) => `#${t.id}`,
      className: 'font-medium',
    },
    {
      header: 'User',
      accessor: (t: Transfer) => `User ${t.user_id}`,
    },
    {
      header: 'Amount',
      accessor: (t: Transfer) => `${t.amount} ${t.currency}`,
      className: 'font-medium text-right',
    },
    {
      header: 'Status',
      accessor: (t: Transfer) => (
        <span
          className={`rounded px-2 py-1 text-xs font-medium ${
            t.status === 'settled'
              ? 'bg-green-100 text-green-800'
              : t.status === 'failed'
                ? 'bg-red-100 text-red-800'
                : 'bg-yellow-100 text-yellow-800'
          }`}
        >
          {t.status}
        </span>
      ),
    },
    {
      header: 'Provider',
      accessor: (t: Transfer) => t.provider,
    },
    {
      header: 'Correlation ID',
      accessor: (t: Transfer) => (
        <CorrelationIdLink correlationId={t.correlation_id} showIcon={true} />
      ),
    },
    {
      header: 'Date',
      accessor: (t: Transfer) =>
        new Date(t.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Transfers</h1>

      {/* Filters */}
      <div className="rounded border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Search & Filter</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="processing">Processing</option>
              <option value="settled">Settled</option>
              <option value="failed">Failed</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Provider
            </label>
            <input
              type="text"
              value={filters.provider}
              onChange={(e) => {
                setFilters({ ...filters, provider: e.target.value });
                setPage(1);
              }}
              placeholder="e.g., Plaid"
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Correlation ID
            </label>
            <input
              type="text"
              value={filters.correlationId}
              onChange={(e) => {
                setFilters({ ...filters, correlationId: e.target.value });
                setPage(1);
              }}
              placeholder="Trace by correlation..."
              className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
            />
          </div>
        </div>
      </div>

      {/* Data Table */}
      <DataTable<Transfer>
        columns={columns}
        rows={transfers}
        isLoading={loading}
        error={error}
        totalCount={totalCount}
        page={page}
        pageSize={50}
        onPageChange={setPage}
      />

      {/* Detail View */}
      {selectedTransfer && (
        <div className="rounded border border-gray-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">
            Transfer Details
          </h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <p className="text-sm text-gray-600">Transfer ID</p>
              <p className="font-medium text-gray-900">{selectedTransfer.id}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">User ID</p>
              <p className="font-medium text-gray-900">{selectedTransfer.user_id}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Amount</p>
              <p className="font-medium text-gray-900">
                {selectedTransfer.amount} {selectedTransfer.currency}
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Status</p>
              <p className="font-medium text-gray-900">{selectedTransfer.status}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Provider</p>
              <p className="font-medium text-gray-900">{selectedTransfer.provider}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Created</p>
              <p className="font-medium text-gray-900">
                {new Date(selectedTransfer.created_at).toLocaleString()}
              </p>
            </div>
            <div className="md:col-span-2">
              <p className="text-sm text-gray-600">Correlation ID</p>
              <p className="font-medium text-gray-900">
                {selectedTransfer.correlation_id || 'N/A'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
