'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin-client';
import { DataTable } from '../components/DataTable';

interface LedgerEntry {
  id: number;
  user_id: number;
  currency: string;
  entry_type: string;
  debit: string;
  credit: string;
  created_at: string;
}

export default function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [currency, setCurrency] = useState('');

  useEffect(() => {
    async function loadLedger() {
      try {
        setLoading(true);
        const result = await adminApi.searchLedger(
          currency ? { currency } : {},
          page,
          50
        );

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setEntries(result.data.data || []);
          setTotalCount(result.data.total_count || 0);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadLedger();
  }, [page, currency]);

  const columns = [
    { header: 'User ID', accessor: 'user_id' },
    { header: 'Type', accessor: 'entry_type', className: 'font-medium' },
    { header: 'Currency', accessor: 'currency' },
    {
      header: 'Debit',
      accessor: (e: LedgerEntry) => e.debit || '-',
      className: 'text-right',
    },
    {
      header: 'Credit',
      accessor: (e: LedgerEntry) => e.credit || '-',
      className: 'text-right',
    },
    { header: 'Date', accessor: (e: LedgerEntry) => new Date(e.created_at).toLocaleDateString() },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Ledger Explorer</h1>

      <div className="rounded border border-gray-200 bg-white p-6">
        <div className="flex items-end gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Filter by Currency
            </label>
            <select
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setPage(1);
              }}
              className="mt-1 rounded border border-gray-300 px-3 py-2"
            >
              <option value="">All Currencies</option>
              <option value="USD">USD</option>
              <option value="CAD">CAD</option>
            </select>
          </div>
        </div>
      </div>

      <DataTable<LedgerEntry>
        columns={columns}
        rows={entries}
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
