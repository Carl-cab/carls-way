'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  phone: string;
  balance: number;
  province: string;
  country: string;
  avatar_color: string;
  created_at: string;
}

function formatCurrency(amount: number, country: string) {
  const currency = country === 'US' ? 'USD' : 'CAD';
  const locale = country === 'US' ? 'en-US' : 'en-CA';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function formatDate(dateStr: string) {
  return new Date(dateStr + 'Z').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
}

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddMoney, setShowAddMoney] = useState(false);
  const [showCashOut, setShowCashOut] = useState(false);

  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(data => {
      setUser(data);
      setLoading(false);
    });
  }, []);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-400">Loading…</div>;
  }

  if (!user) {
    return <div className="text-center py-12 text-gray-400">Error loading profile</div>;
  }

  const initials = user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
  const isCA = user.country !== 'US';
  const currency = isCA ? 'CAD' : 'USD';
  const countryFlag = isCA ? '🇨🇦' : '🇺🇸';
  const regionLabel = isCA ? 'Province' : 'State';

  return (
    <div className="space-y-4">
      {/* Profile Header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 text-center">
        <div
          className="w-20 h-20 rounded-full flex items-center justify-center text-white font-bold text-2xl mx-auto mb-3"
          style={{ backgroundColor: user.avatar_color }}
        >
          {initials}
        </div>
        <h2 className="text-xl font-bold text-gray-800">{user.name}</h2>
        <p className="text-gray-500 text-sm">@{user.username}</p>
        {user.province && (
          <p className="text-xs text-gray-400 mt-1">
            {countryFlag} {user.province}, {isCA ? 'Canada' : 'United States'}
          </p>
        )}
        {!user.province && (
          <p className="text-xs text-gray-400 mt-1">{countryFlag} {isCA ? 'Canada' : 'United States'}</p>
        )}
        <p className="text-xs text-gray-400">Member since {formatDate(user.created_at)}</p>
      </div>

      {/* Balance Card */}
      <div className="bg-gradient-to-br from-red-700 to-red-900 rounded-xl text-white p-6">
        <p className="text-sm opacity-75 mb-1">{currency} Balance</p>
        <p className="text-4xl font-bold">{formatCurrency(user.balance, user.country)}</p>
        <p className="text-xs opacity-60 mt-1">{isCA ? 'Canadian Dollars' : 'US Dollars'}</p>
        <div className="flex gap-3 mt-4">
          <button
            onClick={() => setShowAddMoney(true)}
            className="flex-1 bg-white/20 hover:bg-white/30 text-white text-sm font-medium py-2.5 rounded-lg transition"
          >
            + Add Money
          </button>
          <button
            onClick={() => setShowCashOut(true)}
            className="flex-1 bg-white/20 hover:bg-white/30 text-white text-sm font-medium py-2.5 rounded-lg transition"
          >
            Cash Out
          </button>
        </div>
      </div>

      {/* Add Money Modal */}
      {showAddMoney && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            {isCA ? (
              <>
                <h3 className="text-lg font-bold mb-2">Add Money via Interac e-Transfer</h3>
                <p className="text-sm text-gray-600 mb-4">
                  Send an Interac e-Transfer to <strong>payments@carlsway.ca</strong> with your username <strong>@{user.username}</strong> in the message.
                  Funds typically arrive within 30 minutes.
                </p>
                <div className="bg-gray-50 rounded-lg p-3 text-sm mb-4">
                  <p className="text-gray-500">E-Transfer to:</p>
                  <p className="font-mono font-bold text-gray-800">payments@carlsway.ca</p>
                  <p className="text-gray-500 mt-2">Message/Note:</p>
                  <p className="font-mono font-bold text-gray-800">@{user.username}</p>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-bold mb-2">Add Money via ACH Transfer</h3>
                <p className="text-sm text-gray-600 mb-4">
                  Link your US bank account and transfer funds via ACH. Processing time: 1–3 business days.
                </p>
                <div className="bg-gray-50 rounded-lg p-3 text-sm mb-4">
                  <p className="text-gray-500">Routing Number:</p>
                  <p className="font-mono font-bold text-gray-800">021000089</p>
                  <p className="text-gray-500 mt-2">Reference:</p>
                  <p className="font-mono font-bold text-gray-800">@{user.username}</p>
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm mb-4 text-blue-800">
                  💡 You can also add money via debit card for instant transfers.
                </div>
              </>
            )}
            <button
              onClick={() => setShowAddMoney(false)}
              className="w-full bg-red-700 text-white font-semibold py-2.5 rounded-lg hover:bg-red-800 transition"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Cash Out Modal */}
      {showCashOut && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h3 className="text-lg font-bold mb-2">Cash Out to Bank</h3>
            {isCA ? (
              <p className="text-sm text-gray-600 mb-4">
                Withdraw funds to your Canadian bank account via Interac e-Transfer.
                Processing time: 1–2 business days.
              </p>
            ) : (
              <p className="text-sm text-gray-600 mb-4">
                Withdraw funds to your US bank account via ACH transfer.
                Processing time: 1–3 business days. Instant transfer available for eligible debit cards.
              </p>
            )}
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm mb-4 text-yellow-800">
              ⚠️ Bank integration coming soon. Contact support@carlsway.ca for manual withdrawals.
            </div>
            <button
              onClick={() => setShowCashOut(false)}
              className="w-full bg-red-700 text-white font-semibold py-2.5 rounded-lg hover:bg-red-800 transition"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Account Details */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 space-y-3">
        <h3 className="font-semibold text-gray-700">Account Details</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-gray-400 text-xs">Email</p>
            <p className="text-gray-800 font-medium truncate">{user.email}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs">Phone</p>
            <p className="text-gray-800 font-medium">{user.phone || '—'}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs">{regionLabel}</p>
            <p className="text-gray-800 font-medium">{user.province || '—'}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs">Username</p>
            <p className="text-gray-800 font-medium">@{user.username}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs">Country</p>
            <p className="text-gray-800 font-medium">{countryFlag} {isCA ? 'Canada' : 'United States'}</p>
          </div>
          <div>
            <p className="text-gray-400 text-xs">Currency</p>
            <p className="text-gray-800 font-medium">{currency}</p>
          </div>
        </div>
      </div>

      <button
        onClick={handleLogout}
        className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl transition"
      >
        Sign Out
      </button>
    </div>
  );
}
