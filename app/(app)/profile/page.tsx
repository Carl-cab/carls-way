'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: number; name: string; username: string; email: string; phone: string;
  balance: number; balance_cad: number; balance_usd: number;
  province: string; country: string; avatar_color: string;
  kyc_status: string; created_at: string;
}

interface BankAccount {
  id: number; institution_name: string; account_name: string;
  account_type: string; account_mask: string; currency: string;
  country: string; is_primary: boolean;
}

function formatCurrency(amount: number, currency: string) {
  const locale = currency === 'USD' ? 'en-US' : 'en-CA';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount || 0);
}

function formatDate(dateStr: string) {
  if (!dateStr) return 'Unknown';
  const d = new Date(dateStr.includes('Z') ? dateStr : dateStr + 'Z');
  if (isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
}

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [kycBanner, setKycBanner] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/me').then(r => r.json()),
      fetch('/api/bank-accounts').then(r => r.json()),
    ]).then(([userData, accountsData]: [User, BankAccount[]]) => {
      setUser(userData);
      setBankAccounts(Array.isArray(accountsData) ? accountsData : []);
      setKycBanner(userData.kyc_status === 'none' || userData.kyc_status === 'pending');
      setLoading(false);
    });
  }, []);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  if (loading) return <div className="text-center py-12 text-gray-400">Loading…</div>;
  if (!user) return <div className="text-center py-12 text-gray-400">Error loading profile</div>;

  const initials = user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
  const isCA = user.country !== 'US';
  const primaryCurrency = isCA ? 'CAD' : 'USD';
  const secondaryCurrency = isCA ? 'USD' : 'CAD';
  const countryFlag = isCA ? '🇨🇦' : '🇺🇸';
  const regionLabel = isCA ? 'Province' : 'State';

  const kycLabels: Record<string, { label: string; color: string }> = {
    none: { label: 'Not Verified', color: 'text-gray-500' },
    pending: { label: 'Verification Pending', color: 'text-amber-600' },
    verified: { label: 'Verified ✓', color: 'text-green-600' },
    rejected: { label: 'Verification Failed', color: 'text-red-600' },
  };
  const kycInfo = kycLabels[user.kyc_status] || kycLabels.none;

  return (
    <div className="space-y-4">
      {/* KYC Banner */}
      {kycBanner && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <span className="text-2xl">🪪</span>
          <div>
            <p className="font-semibold text-amber-800 text-sm">Verify your identity</p>
            <p className="text-amber-700 text-xs mt-0.5">Verify your ID to unlock higher transfer limits and cross-border payments.</p>
            <button className="mt-2 text-xs font-semibold text-amber-800 underline">Start verification →</button>
          </div>
        </div>
      )}

      {/* Avatar & Name */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex items-center gap-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold flex-shrink-0"
          style={{ backgroundColor: user.avatar_color || '#dc2626' }}>
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-gray-900 truncate">{user.name}</h2>
          <p className="text-sm text-gray-500">@{user.username}</p>
          <p className={`text-xs mt-0.5 ${kycInfo.color}`}>{kycInfo.label}</p>
        </div>
        <span className="text-2xl">{countryFlag}</span>
      </div>

      {/* Multi-currency Balances */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Balances</h3>
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span className="text-base">{isCA ? '🇨🇦' : '🇺🇸'}</span>
              <span className="text-sm font-medium text-gray-700">{primaryCurrency} Balance</span>
              <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium">Primary</span>
            </div>
            <span className="text-lg font-bold text-gray-900">
              {formatCurrency(isCA ? user.balance_cad : user.balance_usd, primaryCurrency)}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span className="text-base">{isCA ? '🇺🇸' : '🇨🇦'}</span>
              <span className="text-sm font-medium text-gray-700">{secondaryCurrency} Balance</span>
            </div>
            <span className="text-base font-semibold text-gray-600">
              {formatCurrency(isCA ? user.balance_usd : user.balance_cad, secondaryCurrency)}
            </span>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button className="flex-1 py-2 bg-red-700 text-white text-sm font-semibold rounded-lg hover:bg-red-800 transition">+ Add Money</button>
          <button className="flex-1 py-2 border border-gray-300 text-gray-700 text-sm font-semibold rounded-lg hover:border-red-400 transition">Cash Out</button>
        </div>
      </div>

      {/* Bank Accounts */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Linked Banks</h3>
          <button className="text-xs text-red-700 font-semibold hover:text-red-800">+ Link Account</button>
        </div>
        {bankAccounts.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-sm text-gray-400">No bank accounts linked yet.</p>
            <p className="text-xs text-gray-400 mt-1">Link a bank to add money or cash out.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {bankAccounts.map(acct => (
              <div key={acct.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center text-sm">🏦</div>
                  <div>
                    <p className="text-sm font-medium text-gray-800">{acct.institution_name}</p>
                    <p className="text-xs text-gray-500">{acct.account_name} ••••{acct.account_mask} · {acct.currency}</p>
                  </div>
                </div>
                {acct.is_primary && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Primary</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Account Details */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-3">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Account Details</h3>
        {[
          { label: 'Email', value: user.email },
          { label: 'Phone', value: user.phone },
          { label: regionLabel, value: user.province },
          { label: 'Username', value: `@${user.username}` },
          { label: 'Member since', value: formatDate(user.created_at) },
        ].map(({ label, value }) => (
          <div key={label} className="flex justify-between items-center py-1 border-b border-gray-50 last:border-0">
            <span className="text-sm text-gray-500">{label}</span>
            <span className="text-sm font-medium text-gray-800">{value}</span>
          </div>
        ))}
      </div>

      {/* Logout */}
      <button onClick={handleLogout}
        className="w-full py-3 border border-red-200 text-red-700 font-semibold rounded-xl hover:bg-red-50 transition text-sm">
        Sign Out
      </button>
    </div>
  );
}
