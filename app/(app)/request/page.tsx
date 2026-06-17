'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function RequestPage() {
  const router = useRouter();
  const [currency, setCurrency] = useState('CAD');
  const [form, setForm] = useState({
    receiverUsername: '',
    amount: '',
    note: '',
    privacy: 'private',
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(data => {
      setCurrency(data.country === 'US' ? 'USD' : 'CAD');
    });
  }, []);

  function update(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receiverUsername: form.receiverUsername.replace('@', ''),
          amount: parseFloat(form.amount),
          note: form.note,
          privacy: form.privacy,
          type: 'request',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Request failed');
      } else {
        setSuccess('Payment request sent! 💸');
        setTimeout(() => router.push('/history'), 1500);
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-4">Request Money</h2>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              From (username)
            </label>
            <input
              type="text"
              value={form.receiverUsername}
              onChange={e => update('receiverUsername', e.target.value)}
              required
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-500"
              placeholder="@username"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Amount ({currency})
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 font-medium">$</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                max="10000"
                value={form.amount}
                onChange={e => update('amount', e.target.value)}
                required
                className="w-full border border-gray-300 rounded-lg pl-8 pr-16 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-500"
                placeholder="0.00"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs text-gray-400 font-medium">{currency}</span>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              What&apos;s it for?
            </label>
            <input
              type="text"
              value={form.note}
              onChange={e => update('note', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-500"
              placeholder="🏠 Rent, 🍺 Drinks, 🚗 Gas…"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Privacy</label>
            <div className="flex gap-2">
              {['public', 'friends', 'private'].map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => update('privacy', p)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                    form.privacy === p
                      ? 'bg-red-700 text-white border-red-700'
                      : 'border-gray-300 text-gray-600 hover:border-red-400'
                  }`}
                >
                  {p === 'public' ? '🌍 Public' : p === 'friends' ? '👥 Friends' : '🔒 Private'}
                </button>
              ))}
            </div>
          </div>

          {error && <div className="bg-red-50 text-red-700 px-4 py-2 rounded-lg text-sm">{error}</div>}
          {success && <div className="bg-green-50 text-green-700 px-4 py-2 rounded-lg text-sm">{success}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-700 hover:bg-red-800 text-white font-semibold py-3 rounded-lg transition disabled:opacity-60 text-lg"
          >
            {loading ? 'Sending request…' : 'Request Money 💸'}
          </button>
        </form>
      </div>
    </div>
  );
}
