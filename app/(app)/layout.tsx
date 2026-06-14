'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

interface User {
  id: number;
  name: string;
  username: string;
  balance: number;
  balance_cad: number;
  balance_usd: number;
  country: string;
  avatar_color: string;
}

function getInitials(name: string) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function formatBalance(amount: number, country: string) {
  const currency = country === 'US' ? 'USD' : 'CAD';
  const locale = country === 'US' ? 'en-US' : 'en-CA';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function getDisplayBalance(user: User) {
  if (user.country === 'US') {
    return user.balance_usd ?? user.balance;
  }
  return user.balance_cad ?? user.balance;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(data => {
      if (data.id) setUser(data);
    });
  }, [pathname]);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  const navItems = [
    { href: '/feed', label: 'Feed', icon: '🏠' },
    { href: '/history', label: 'Activity', icon: '📋' },
    { href: '/friends', label: 'Friends', icon: '👥' },
    { href: '/profile', label: 'Profile', icon: '👤' },
  ];

  const countryFlag = user?.country === 'US' ? '🇺🇸' : '🍁';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Header */}
      <header className="bg-red-700 text-white sticky top-0 z-40 shadow-lg">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/feed" className="flex items-center gap-2">
            <span className="text-2xl">🍁</span>
            <span className="font-bold text-lg">manna</span>
          </Link>
          {user && (
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <div className="text-xs opacity-75">Balance</div>
                <div className="font-bold text-sm">{formatBalance(getDisplayBalance(user), user.country || 'CA')}</div>
              </div>
              <button
                onClick={handleLogout}
                className="bg-white/20 hover:bg-white/30 text-white text-xs px-3 py-1.5 rounded-full transition"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Balance bar (mobile) */}
      {user && (
        <div className="bg-red-800 text-white text-center py-2 text-sm sm:hidden">
          {countryFlag} Balance: <strong>{formatBalance(getDisplayBalance(user), user.country || 'CA')}</strong>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 pb-24 pt-4">
        {children}
      </div>

      {/* Floating Pay/Request Button */}
      <div className="fixed bottom-20 right-4 flex flex-col gap-2 z-50 sm:bottom-8">
        <Link
          href="/request"
          className="bg-white border-2 border-red-700 text-red-700 font-bold text-sm px-4 py-2.5 rounded-full shadow-lg hover:bg-red-50 transition text-center"
        >
          Request
        </Link>
        <Link
          href="/send"
          className="bg-red-700 text-white font-bold text-sm px-4 py-2.5 rounded-full shadow-lg hover:bg-red-800 transition text-center"
        >
          Pay {countryFlag}
        </Link>
      </div>

      {/* Bottom Nav */}
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40">
        <div className="max-w-2xl mx-auto flex">
          {navItems.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex-1 flex flex-col items-center py-2 text-xs transition ${
                pathname === item.href ? 'text-red-700 font-semibold' : 'text-gray-500 hover:text-red-700'
              }`}
            >
              <span className="text-xl">{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
