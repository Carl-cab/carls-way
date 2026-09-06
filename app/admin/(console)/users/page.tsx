'use client';

import { useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin-client';
import { DataTable } from '../components/DataTable';

interface AdminUser {
  id: number;
  email: string;
  name: string;
  role: string;
  status: string;
  last_login_at?: string;
}

export default function UsersPage() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [roleFilter, setRoleFilter] = useState('');

  useEffect(() => {
    async function loadAdmins() {
      try {
        setLoading(true);
        const result = await adminApi.getUsers(page);

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setAdmins(result.data.data || []);
          setTotalCount(result.data.total_count || 0);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    loadAdmins();
  }, [page]);

  const columns = [
    { header: 'Name', accessor: (a: AdminUser) => a.name, className: 'font-medium' },
    { header: 'Email', accessor: (a: AdminUser) => a.email },
    { header: 'Role', accessor: (a: AdminUser) => a.role },
    {
      header: 'Status',
      accessor: (a: AdminUser) => (
        <span
          className={`rounded px-2 py-1 text-xs font-medium ${
            a.status === 'active'
              ? 'bg-green-100 text-green-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {a.status}
        </span>
      ),
    },
    {
      header: 'Last Login',
      accessor: (a: AdminUser) =>
        a.last_login_at
          ? new Date(a.last_login_at).toLocaleDateString()
          : 'Never',
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Admin Users</h1>

      <DataTable<AdminUser>
        columns={columns}
        rows={admins}
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
