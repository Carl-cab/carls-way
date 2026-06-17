'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface User {
  id: number; name: string; username: string; email: string; phone: string;
  balance: number; balance_cad: number; balance_usd: number;
  province: string; country: string; avatar_color: string;
  kyc_status: string; kyc_rejection_reason?: string; created_at: string;
}

interface BankAccount {
  id: number; institution_name: string; account_name: string;
  account_type: string; account_mask: string; currency: string;
  country: string; is_primary: boolean; is_token_encrypted: boolean;
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

function KycReturnBanners({ kycStatus }: { kycStatus: string }) {
  const searchParams = useSearchParams();
  const kycReturn = searchParams.get('kyc') === 'complete';
  if (!kycReturn) return null;
  if (kycStatus === 'verified') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-800">
        <strong>Identity verified!</strong> Your higher transfer limits are now active.
      </div>
    );
  }
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800">
      <strong>Verification submitted.</strong> We&apos;ll update your status once Stripe processes your documents. This usually takes a few minutes.
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [pageLoaded, setPageLoaded] = useState(false);
  const [kycLoading, setKycLoading] = useState(false);
  const [kycError, setKycError] = useState('');

  const loadProfile = useCallback(() => {
    Promise.all([
      fetch('/api/me').then(r => r.json()),
      fetch('/api/bank-accounts').then(r => r.json()),
    ]).then(([userData, accountsData]: [User, BankAccount[]]) => {
      setUser(userData);
      setBankAccounts(Array.isArray(accountsData) ? accountsData : []);
      setPageLoaded(true);
    });
  }, []);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  async function handleStartKyc() {
    setKycLoading(true);
    setKycError('');
    try {
      const res = await fetch('/api/kyc/create-session', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setKycError(data.error || 'Failed to start verification');
        return;
      }
      // Redirect to Stripe hosted Identity flow
      window.location.href = data.url;
    } catch {
      setKycError('Network error — please try again');
    } finally {
      setKycLoading(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  if (!pageLoaded) return <div className="text-center py-12 text-gray-400">Loading…</div>;
  if (!user) return <div className="text-center py-12 text-gray-400">Error loading profile</div>;

  const initials = user.name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
  const isCA = user.country !== 'US';
  const primaryCurrency = isCA ? 'CAD' : 'USD';
  const secondaryCurrency = isCA ? 'USD' : 'CAD';
  const countryFlag = isCA ? '🇨🇦' : '🇺🇸';
  const regionLabel = isCA ? 'Province' : 'State';

  // Transfer readiness — drives Add Money / Cash Out button states
  const kycVerified = user.kyc_status === 'verified';
  const hasEncryptedAccount = bankAccounts.some(a => a.is_token_encrypted);
  const transferHint =
    !kycVerified
      ? 'Verify your identity before using transfers.'
      : !hasEncryptedAccount
      ? 'Re-link your bank account before using transfers.'
      : 'Transfers available (sandbox simulation only).'
  const canTransfer = kycVerified && hasEncryptedAccount;

  const kycConfig: Record<string, { label: string; badge: string; badgeBg: string; avatarColor: string }> = {
    pending:        { label: 'Verification Pending',  badge: 'Pending',       badgeBg: 'bg-amber-100 text-amber-700',  avatarColor: 'text-amber-600' },
    verified:       { label: 'Identity Verified ✓',   badge: 'Verified',      badgeBg: 'bg-green-100 text-green-700',  avatarColor: 'text-green-600' },
    requires_input: { label: 'Action Required',       badge: 'Action Needed', badgeBg: 'bg-red-100 text-red-700',     avatarColor: 'text-red-600'   },
    unverified:     { label: 'Not Verified',           badge: 'Unverified',    badgeBg: 'bg-gray-100 text-gray-600',   avatarColor: 'text-gray-500'  },
  };
  const kycInfo = kycConfig[user.kyc_status] ?? kycConfig.unverified;
  const canStartKyc = !['verified'].includes(user.kyc_status);

  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <KycReturnBanners kycStatus={user.kyc_status} />
      </Suspense>

      {/* Avatar & Name */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 flex items-center gap-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold flex-shrink-0"
          style={{ backgroundColor: user.avatar_color || '#dc2626' }}>
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold text-gray-900 truncate">{user.name}</h2>
          <p className="text-sm text-gray-500">@{user.username}</p>
          <p className={`text-xs mt-0.5 ${kycInfo.avatarColor}`}>{kycInfo.label}</p>
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
        <div className="mt-4 space-y-2">
          <div className="flex gap-2">
            {canTransfer ? (
              <Link
                href="/transfers?type=add_money"
                className="flex-1 py-2 bg-red-700 text-white text-sm font-semibold rounded-lg hover:bg-red-800 transition text-center"
              >
                + Add Money
              </Link>
            ) : (
              <button
                disabled
                className="flex-1 py-2 bg-gray-200 text-gray-400 text-sm font-semibold rounded-lg cursor-not-allowed"
                title={transferHint}
              >
                + Add Money
              </button>
            )}
            <button
              disabled={!kycVerified || !hasEncryptedAccount}
              className="flex-1 py-2 border border-gray-200 text-gray-400 text-sm font-semibold rounded-lg cursor-not-allowed"
              title={transferHint}
            >
              Cash Out
            </button>
          </div>
          <p className="text-xs text-center text-gray-400">{transferHint}</p>
        </div>
      </div>

      {/* Identity Verification */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Identity Verification</h3>
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${kycInfo.badgeBg}`}>
            {kycInfo.badge}
          </span>
        </div>

        {user.kyc_status === 'verified' && (
          <p className="text-sm text-gray-600">Your identity has been verified. Higher transfer limits are active.</p>
        )}

        {user.kyc_status === 'pending' && (
          <p className="text-sm text-gray-600">Your verification is being reviewed. We&apos;ll update your status automatically — no action needed.</p>
        )}

        {user.kyc_status === 'requires_input' && (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">Your verification needs attention.</p>
            {user.kyc_rejection_reason && (
              <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{user.kyc_rejection_reason}</p>
            )}
          </div>
        )}

        {(user.kyc_status === 'unverified' || user.kyc_status === 'none') && (
          <p className="text-sm text-gray-600">Verify your identity to unlock higher transfer limits and cross-border payments.</p>
        )}

        {kycError && (
          <p className="text-xs text-red-600 mt-2 bg-red-50 rounded-lg px-3 py-2">{kycError}</p>
        )}

        {canStartKyc && (
          <button
            onClick={handleStartKyc}
            disabled={kycLoading}
            className="mt-3 w-full py-2.5 bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition"
          >
            {kycLoading ? 'Starting…' : user.kyc_status === 'requires_input' ? 'Retry Verification →' : 'Verify Identity →'}
          </button>
        )}
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
