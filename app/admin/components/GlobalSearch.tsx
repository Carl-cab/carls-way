'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { adminApi } from '@/lib/admin-client';

interface SearchResult {
  type: string;
  id: string | number;
  data: any;
  href: string;
}

export function GlobalSearch() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQuery = searchParams.get('q') || '';

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    async function search() {
      try {
        setLoading(true);
        setError(null);
        const searchResults: SearchResult[] = [];

        // Try searching by ID across different resource types
        const numericQuery = parseInt(query);
        const stringQuery = query.trim();

        // Search transfers
        if (!isNaN(numericQuery)) {
          const transfer = await adminApi.getTransferById(numericQuery);
          if (transfer.data) {
            searchResults.push({
              type: 'Transfer',
              id: numericQuery,
              data: transfer.data,
              href: `/admin/transfers?id=${numericQuery}`,
            });
          }
        }

        // Search by correlation ID across multiple resources
        if (stringQuery.length > 0) {
          const [transfers, events, webhooks, audit] = await Promise.all([
            adminApi.traceTransfer(stringQuery).catch(() => ({ data: null })),
            adminApi.traceProviderEvents(stringQuery).catch(() => ({ data: null })),
            adminApi.traceWebhooks(stringQuery).catch(() => ({ data: null })),
            adminApi.traceAuditLog(stringQuery).catch(() => ({ data: null })),
          ]);

          if (transfers.data?.transfers && transfers.data.transfers.length > 0) {
            transfers.data.transfers.forEach((t: any) => {
              searchResults.push({
                type: 'Transfer (by correlation)',
                id: t.id,
                data: t,
                href: `/admin/transfers?id=${t.id}`,
              });
            });
          }

          if (events.data?.events && Array.isArray(events.data.events) && events.data.events.length > 0) {
            events.data.events.forEach((e: any) => {
              searchResults.push({
                type: 'Provider Event',
                id: e.id,
                data: e,
                href: `/admin/events?id=${e.id}`,
              });
            });
          }

          if (webhooks.data?.webhooks && Array.isArray(webhooks.data.webhooks) && webhooks.data.webhooks.length > 0) {
            webhooks.data.webhooks.forEach((w: any) => {
              searchResults.push({
                type: 'Webhook',
                id: w.id,
                data: w,
                href: `/admin/webhooks?id=${w.id}`,
              });
            });
          }

          if (audit.data?.audit_logs && Array.isArray(audit.data.audit_logs) && audit.data.audit_logs.length > 0) {
            audit.data.audit_logs.forEach((a: any, idx: number) => {
              searchResults.push({
                type: 'Audit Log',
                id: `${a.id}-${idx}`,
                data: a,
                href: `/admin/audit?filter=${stringQuery}`,
              });
            });
          }
        }

        if (searchResults.length === 0) {
          setError(`No results found for "${query}"`);
        }

        setResults(searchResults);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setLoading(false);
      }
    }

    search();
  }, [query]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(`/admin/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold text-gray-900">Global Search</h1>

      {/* Search Box */}
      <form onSubmit={handleSearch} className="space-y-4">
        <div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ID, correlation ID, email, username..."
            className="w-full rounded border border-gray-300 px-4 py-3 text-lg"
            autoFocus
          />
          <p className="mt-2 text-sm text-gray-600">
            Supports: Transfer ID, Provider Event ID, Webhook ID, User ID, Correlation ID
          </p>
        </div>
      </form>

      {/* Results */}
      {loading && (
        <div className="text-center py-8">
          <p className="text-gray-600">Searching...</p>
        </div>
      )}

      {error && !loading && (
        <div className="rounded border border-yellow-200 bg-yellow-50 p-4">
          <p className="text-yellow-800">{error}</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Found {results.length} result{results.length !== 1 ? 's' : ''}
          </p>

          {results.map((result, idx) => (
            <Link
              key={idx}
              href={result.href}
              className="block rounded border border-gray-200 p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-red-700">{result.type}</p>
                  <p className="mt-1 font-medium text-gray-900">
                    ID: {result.id}
                  </p>
                  {result.data.status && (
                    <p className="mt-1 text-sm text-gray-600">
                      Status: {result.data.status}
                    </p>
                  )}
                  {result.data.amount && (
                    <p className="text-sm text-gray-600">
                      Amount: {result.data.amount}{' '}
                      {result.data.currency || result.data.sender_currency}
                    </p>
                  )}
                  {result.data.created_at && (
                    <p className="text-xs text-gray-500">
                      {new Date(result.data.created_at).toLocaleString()}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-red-700">View →</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {!query && (
        <div className="rounded border border-gray-200 bg-gray-50 p-8 text-center">
          <p className="text-gray-600">
            Enter a search term to find transfers, events, webhooks, or audit logs
          </p>
        </div>
      )}
    </div>
  );
}
