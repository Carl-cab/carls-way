'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface FxQuote {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  feeAmount: number;
  receiverAmount: number;
  isCrossBorder: boolean;
}

interface Me {
  country: string;
  balance_cad: number;
  balance_usd: number;
}

export default function SendPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [form, setForm] = useState({ receiverUsername: '', amount: '', note: '', type: 'pay', privacy: 'public' });
  const [fxQuote, setFxQuote] = useState<FxQuote | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then((d: Me) => setMe(d));
  }, []);

  const currency = me?.country === 'US' ? 'USD' : 'CAD';
  const balance = me ? (currency === 'USD' ? (me.balance_usd || 0) : (me.balance_cad || 0)) : 0;

  const fetchFxQuote = useCallback(async (amount: string, username: string) => {
    if (!amount || !username || parseFloat(amount) <= 0) { setFxQuote(null); return; }
    setFxLoading(true);
    try {
      const userRes = await fetch(`/api/users?search=${encodeURIComponent(username)}`);
      const users = await userRes.json() as Array<{ username: string; country: string }>;
      const receiver = Array.isArray(users) ? users.find(u => u.username === username) : null;
      if (!receiver) { setFxQuote(null); setFxLoading(false); return; }
      const toCurrency = receiver.country === 'US' ? 'USD' : 'CAD';
      if (toCurrency === currency) { setFxQuote(null); setFxLoading(false); return; }
      const res = await fetch('/api/fx/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: parseFloat(amount), fromCurrency: currency, toCurrency }),
      });
      if (res.ok) setFxQuote(await res.json() as FxQuote);
    } catch { setFxQuote(null); }
    setFxLoading(false);
  }, [currency]);

  useEffect(() => {
    const t = setTimeout(() => { if (form.type === 'pay') fetchFxQuote(form.amount, form.receiverUsername); }, 600);
    return () => clearTimeout(t);
  }, [form.amount, form.receiverUsername, form.type, fetchFxQuote]);

  function update(field: string, value: string) { setForm(prev => ({ ...prev, [field]: value })); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receiverUsername: form.receiverUsername, amount: parseFloat(form.amount), note: form.note, type: form.type, privacy: form.privacy }),
      });
      const data = await res.json() as { error?: string; isCrossBorder?: boolean; receiverAmount?: number; receiverCurrency?: string };
      if (!res.ok) { setError(data.error || 'Transaction failed'); }
      else {
        setSuccess(data.isCrossBorder
          ? `Sent! ${data.receiverAmount} ${data.receiverCurrency} arrives in 1-2 business days. 🌎`
          : `${form.type === 'pay' ? 'Payment sent' : 'Request sent'}! ${currency === 'CAD' ? '🍁' : '🦅'}`);
        setTimeout(() => router.push('/history'), 2000);
      }
    } catch { setError('Network error. Please try again.'); }
    finally { setLoading(false); }
  }

  const numAmount = parseFloat(form.amount) || 0;
  const insufficient = form.type === 'pay' && numAmount > balance;

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-4">{form.type === 'pay' ? 'Send Money' : 'Request Money'}</h2>
      <div className="flex gap-2 mb-4">
        {['pay', 'request'].map(t => (
          <button key={t} type="button" onClick={() => { update('type', t); setFxQuote(null); }}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border transition ${form.type === t ? 'bg-red-700 text-white border-red-700' : 'border-gray-300 text-gray-600 hover:border-red-400'}`}>
            {t === 'pay' ? '💸 Send' : '📥 Request'}
          </button>
        ))}
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        {me && form.type === 'pay' && (
          <div className="mb-4 text-sm text-gray-500 flex justify-between">
            <span>Available balance</span>
            <span className={`font-semibold ${insufficient ? 'text-red-600' : 'text-gray-800'}`}>
              {new Intl.NumberFormat(currency === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency }).format(balance)}
            </span>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{form.type === 'pay' ? 'To' : 'From'} (username)</label>
            <input type="text" value={form.receiverUsername} onChange={e => update('receiverUsername', e.target.value.replace('@', ''))} required
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-500" placeholder="@username" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Amount ({currency})</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-medium">$</span>
              <input type="number" step="0.01" min="0.01" max="10000" value={form.amount} onChange={e => update('amount', e.target.value)} required
                className="w-full border border-gray-300 rounded-lg pl-8 pr-16 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-500" placeholder="0.00" />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">{currency}</span>
            </div>
          </div>
          {form.type === 'pay' && (fxLoading || fxQuote) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              {fxLoading ? <p className="text-amber-700">Fetching exchange rate…</p> : fxQuote ? (
                <div className="space-y-1">
                  <p className="font-semibold text-amber-800">🌎 Cross-border Transfer</p>
                  <div className="flex justify-between text-amber-700"><span>Exchange rate</span><span>1 {fxQuote.fromCurrency} = {fxQuote.rate.toFixed(4)} {fxQuote.toCurrency}</span></div>
                  <div className="flex justify-between text-amber-700"><span>Transfer fee (0.5%)</span><span>−{fxQuote.feeAmount.toFixed(2)} {fxQuote.fromCurrency}</span></div>
                  <div className="flex justify-between font-semibold text-amber-900 border-t border-amber-200 pt-1 mt-1"><span>Recipient receives</span><span>{fxQuote.receiverAmount.toFixed(2)} {fxQuote.toCurrency}</span></div>
                  <p className="text-amber-600 text-xs">⏱ Estimated arrival: 1–2 business days</p>
                </div>
              ) : null}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note / Emoji</label>
            <input type="text" value={form.note} onChange={e => update('note', e.target.value)} maxLength={200}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-500" placeholder="🍕 Pizza night, ☕ Coffee, 🏒 Game tickets…" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Privacy</label>
            <div className="flex gap-2">
              {['public', 'friends', 'private'].map(p => (
                <button key={p} type="button" onClick={() => update('privacy', p)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${form.privacy === p ? 'bg-red-700 text-white border-red-700' : 'border-gray-300 text-gray-600 hover:border-red-400'}`}>
                  {p === 'public' ? '🌍 Public' : p === 'friends' ? '👥 Friends' : '🔒 Private'}
                </button>
              ))}
            </div>
          </div>
          {insufficient && <div className="bg-red-50 text-red-700 px-4 py-2 rounded-lg text-sm">Insufficient balance. Add money first.</div>}
          {error && <div className="bg-red-50 text-red-700 px-4 py-2 rounded-lg text-sm">{error}</div>}
          {success && <div className="bg-green-50 text-green-700 px-4 py-2 rounded-lg text-sm">{success}</div>}
          <button type="submit" disabled={loading || insufficient}
            className="w-full bg-red-700 hover:bg-red-800 text-white font-semibold py-3 rounded-lg transition disabled:opacity-60 text-lg">
            {loading ? (form.type === 'pay' ? 'Sending…' : 'Requesting…') : form.type === 'pay' ? `Send ${currency === 'CAD' ? '🍁' : '🦅'}` : `Request ${currency === 'CAD' ? '🍁' : '🦅'}`}
          </button>
        </form>
      </div>
    </div>
  );
}
