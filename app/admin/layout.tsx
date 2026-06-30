'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const adminLinks = [
  { href: '/admin/dashboard', label: 'Dashboard', icon: '📊' },
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/transfers', label: 'Transfers', icon: '💸' },
  { href: '/admin/ledger', label: 'Ledger', icon: '📖' },
  { href: '/admin/events', label: 'Events', icon: '📡' },
  { href: '/admin/webhooks', label: 'Webhooks', icon: '🔗' },
  { href: '/admin/audit', label: 'Audit Logs', icon: '🔍' },
  { href: '/admin/search', label: 'Global Search', icon: '🔎' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="rounded p-1 hover:bg-gray-100 lg:hidden"
              aria-label="Toggle sidebar"
            >
              ☰
            </button>
            <h1 className="text-2xl font-bold text-gray-900">Manna Operations Console</h1>
          </div>
          <div className="text-sm text-gray-600">v0.95C</div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="fixed left-0 top-16 z-30 h-[calc(100vh-64px)] w-64 overflow-y-auto border-r border-gray-200 bg-white p-4 lg:relative lg:top-0">
            <nav className="space-y-2">
              {adminLinks.map((link) => {
                const isActive = pathname === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`flex items-center gap-3 rounded px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-red-100 text-red-700'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <span>{link.icon}</span>
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </aside>
        )}

        {/* Main content */}
        <main className="flex-1 lg:ml-0">
          <div className="px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
