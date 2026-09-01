'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const POLL_INTERVAL_MS = 30_000;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    function fetchUnread() {
      fetch('/api/notifications')
        .then(r => r.json())
        .then(data => {
          if (Array.isArray(data)) {
            setUnreadCount(data.filter((n: { read_at: string | null }) => !n.read_at).length);
          }
        })
        .catch(() => {});
    }
    fetchUnread();
    const interval = setInterval(fetchUnread, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [pathname]);

  const navItems = [
    { href: '/feed', label: 'Home', icon: '🏠', badge: 0 },
    { href: '/send', label: 'Pay', icon: '💸', badge: 0 },
    { href: '/transfers', label: 'Wallet', icon: '💳', badge: 0 },
    { href: '/notifications', label: 'Activity', icon: '🔔', badge: unreadCount },
    { href: '/profile', label: 'Me', icon: '👤', badge: 0 },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 pb-24 pt-6">
        {children}
      </div>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40">
        <div className="max-w-md mx-auto flex">
          {navItems.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[11px] transition ${
                pathname === item.href ? 'text-blue-600 font-semibold' : 'text-gray-500 hover:text-blue-600'
              }`}
            >
              <span className="relative inline-block text-xl leading-none">
                {item.icon}
                {item.badge > 0 && (
                  <span className="absolute -top-1 -right-1.5 bg-blue-600 text-white text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-0.5 leading-none">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </span>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
