'use client';
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface TransferIntent {
  id: number;
  type: string;
  amount: number;
  currency: string;
  status: string;
  provider_region: string;
  provider_name: string;
  execution_mode: string;
  consent_confirmed_at: string | null;
  created_at: string;
}

interface ReviewDetails {
  amount: number;
  currency: string;
  type: string;
  bank_account: {
    institution_name: string;
    account_name: string;
    account_mask: string | null;
    currency: string;
  };
  provider_name: string;
  provider_region: string;
  execution_mode: string;
  settlement_estimate: string;
  consent_language: string;
}

type Step = 'form' | 'review' | 'confirmed';

function statusBadge(status: string) {
  const map: Record<string, string> = {
    draft:      'bg-gray-100 text-gray-700',
    reviewed:   'bg-blue-100 text-blue-700',
    ready:      'bg-green-100 text-green-700',
    processing: 'bg-amber-100 text-amber-700',
    settled:    'bg-green-100 text-green-800',
    failed:     'bg-red-100 text-red-700',
    returned:   'bg-red-100 text-red-700',
    cancelled:  'bg-gray-100 text-gray-500',
    blocked:    'bg-red-100 text-red-700',
  };
  return map[status] ?? 'bg-gray-100 text-gray-600';
}

function regionLabel(providerName: string, providerRegion: string) {
  if (providerRegion === 'CA') return 'Canadian transfer simulation';
  if (providerRegion === 'US') return 'US transfer simulation';
  return providerName;
}

export default function TransfersPage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-gray-400">Loading…</div>}>
      <TransfersPageInner />
    </Suspense>
  );
}

function TransfersPageInner() {
  const searchParams = useSearchParams();
  const defaultType = (searchParams.get('type') === 'cash_out' ? 'cash_out' : 'add_money') as 'add_money' | 'cash_out';

  const [step, setStep] = useState<Step>('form');
  const [transfers, setTransfers] = useState<TransferIntent[]>([]);
  const [amount, setAmount] = useState('');
  const [transferType, setTransferType] = useState<'add_money' | 'cash_out'>(defaultType);
  const [currency, setCurrency] = useState('CAD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Active intent going through the review flow
  const [activeIntentId, setActiveIntentId] = useState<number | null>(null);
  const [review, setReview] = useState<ReviewDetails | null>(null);
  const [confirmedMessage, setConfirmedMessage] = useState('');

  const loadTransfers = useCallback(() => {
    fetch('/api/transfers')
      .then(r => r.json())
      .then(data => setTransfers(Array.isArray(data) ? data : []))
      .catch((_err) => console.error('Failed to load transfers'));
  }, []);

  useEffect(() => { loadTransfers(); }, [loadTransfers]);

  // Step 1: Create draft intent
  async function handleCreateIntent(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/transfers/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: transferType, amount: parseFloat(amount), currency }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create transfer');
        return;
      }
      setActiveIntentId(data.intent_id);
      // Load review details
      const reviewRes = await fetch(`/api/transfers/${data.intent_id}/review`);
      const reviewData = await reviewRes.json();
      if (!reviewRes.ok) {
        setError(reviewData.error || 'Failed to load review');
        return;
      }
      setReview(reviewData.review);
      setStep('review');
    } catch (_err) {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  // Step 2: User confirms after reading consent language
  async function handleConfirm() {
    if (!activeIntentId) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/transfers/${activeIntentId}/confirm`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to confirm transfer');
        return;
      }
      setConfirmedMessage(data.message || 'Transfer confirmed.');
      setStep('confirmed');
      loadTransfers();
    } catch (_err) {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  function handleStartOver() {
    setStep('form');
    setAmount('');
    setActiveIntentId(null);
    setReview(null);
    setConfirmedMessage('');
    setError('');
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/profile" className="text-sm text-red-700 hover:underline inline-block">
          ← Back to Profile
        </Link>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <p className="text-sm font-semibold text-blue-900 mb-0.5">Sandbox Mode</p>
        <p className="text-sm text-blue-800">
          This is a transfer simulation environment. No money will actually move. US users see US transfer simulation; Canadian users see Canadian transfer simulation.
        </p>
      </div>

      {/* Step 1: Form */}
      {step === 'form' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-bold text-gray-900 mb-4">Initiate Transfer</h2>
          <form onSubmit={handleCreateIntent} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Transfer Type</label>
              <select
                value={transferType}
                onChange={e => setTransferType(e.target.value as 'add_money' | 'cash_out')}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                <option value="add_money">Add Money (from bank)</option>
                <option value="cash_out">Cash Out (to bank)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Amount</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="Enter amount"
                required
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                <option value="CAD">CAD</option>
                <option value="USD">USD</option>
              </select>
            </div>
            {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm">{error}</div>}
            <button
              type="submit"
              disabled={loading || !amount}
              className="w-full bg-red-700 text-white font-semibold py-2.5 rounded-lg hover:bg-red-800 disabled:opacity-50 transition"
            >
              {loading ? 'Loading…' : 'Continue to Review →'}
            </button>
          </form>
        </div>
      )}

      {/* Step 2: Review */}
      {step === 'review' && review && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
          <h2 className="text-lg font-bold text-gray-900">Review Transfer</h2>

          <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Type</span>
              <span className="font-medium text-gray-900 capitalize">{review.type.replace('_', ' ')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Amount</span>
              <span className="font-bold text-gray-900">{review.currency} {Number(review.amount).toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Bank account</span>
              <span className="font-medium text-gray-900">
                {review.bank_account.institution_name} ••••{review.bank_account.account_mask || 'XXXX'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Rail</span>
              <span className="font-medium text-gray-900">{regionLabel(review.provider_name, review.provider_region)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Settlement</span>
              <span className="font-medium text-gray-900">{review.settlement_estimate}</span>
            </div>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            <p className="font-semibold mb-1">Authorization</p>
            <p>{review.consent_language}</p>
          </div>

          {error && <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm">{error}</div>}

          <div className="flex gap-3">
            <button
              onClick={handleStartOver}
              disabled={loading}
              className="flex-1 py-2.5 border border-gray-300 text-gray-700 font-semibold rounded-lg hover:bg-gray-50 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex-1 py-2.5 bg-red-700 text-white font-semibold rounded-lg hover:bg-red-800 disabled:opacity-50 transition"
            >
              {loading ? 'Confirming…' : 'Confirm Transfer'}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Confirmed */}
      {step === 'confirmed' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mx-auto text-green-700 text-2xl">✓</div>
          <h2 className="text-lg font-bold text-gray-900">Transfer Confirmed</h2>
          <p className="text-sm text-gray-600">{confirmedMessage}</p>
          <button
            onClick={handleStartOver}
            className="w-full py-2.5 border border-gray-300 text-gray-700 font-semibold rounded-lg hover:bg-gray-50 transition"
          >
            New Transfer
          </button>
        </div>
      )}

      {/* History */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Transfer History</h3>
        {transfers.length === 0 ? (
          <p className="text-sm text-gray-500">No transfers yet.</p>
        ) : (
          <div className="space-y-3">
            {transfers.map(t => (
              <div key={t.id} className="border border-gray-100 rounded-lg p-3">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-medium text-gray-900 capitalize text-sm">{t.type.replace('_', ' ')}</p>
                    <p className="text-sm text-gray-600">{t.currency} {Number(t.amount).toFixed(2)}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{regionLabel(t.provider_name, t.provider_region)}</p>
                    <p className="text-xs text-gray-400">{new Date(t.created_at).toLocaleString()}</p>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ${statusBadge(t.status)}`}>
                    {t.status}
                  </span>
                </div>
                {t.consent_confirmed_at && (
                  <p className="text-xs text-green-700 mt-1">Confirmed at {new Date(t.consent_confirmed_at).toLocaleString()}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
