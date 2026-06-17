'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface TransferIntent {
  id: number;
  type: string;
  amount: number;
  currency: string;
  status: string;
  provider: string;
  created_at: string;
}

export default function TransfersPage() {
  const [transfers, setTransfers] = useState<TransferIntent[]>([]);
  const [amount, setAmount] = useState('');
  const [transferType, setTransferType] = useState<'add_money' | 'cash_out'>('add_money');
  const [currency, setCurrency] = useState('CAD');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetch('/api/transfers')
      .then(r => r.json())
      .then(data => setTransfers(Array.isArray(data) ? data : []))
      .catch((_err) => console.error('Failed to load transfers'));
  }, []);

  async function handleCreateTransfer(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const res = await fetch('/api/transfers/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: transferType,
          amount: parseFloat(amount),
          currency
        })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to create transfer intent');
      } else {
        setSuccess(`Transfer intent created! ID: ${data.id}`);
        setAmount('');
        setTransfers([data, ...transfers]);
        setTimeout(() => setSuccess(''), 5000);
      }
    } catch (_err) {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/profile" className="text-sm text-red-700 hover:underline mb-4 inline-block">
          ← Back to Profile
        </Link>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <p className="text-sm text-blue-900">
          <strong>Sandbox Mode:</strong> This is a transfer simulation environment. No money will actually move.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-4">Initiate Transfer (Simulation)</h2>

        <form onSubmit={handleCreateTransfer} className="space-y-4">
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
          {success && <div className="bg-green-50 text-green-700 p-3 rounded-lg text-sm">{success}</div>}

          <button
            type="submit"
            disabled={loading || !amount}
            className="w-full bg-red-700 text-white font-semibold py-2 rounded-lg hover:bg-red-800 disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create Transfer Intent'}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Transfer History</h3>

        {transfers.length === 0 ? (
          <p className="text-sm text-gray-500">No transfer intents yet</p>
        ) : (
          <div className="space-y-3">
            {transfers.map(t => (
              <div key={t.id} className="border border-gray-200 rounded-lg p-3 flex justify-between items-start">
                <div>
                  <p className="font-medium text-gray-900 capitalize">{t.type.replace('_', ' ')}</p>
                  <p className="text-sm text-gray-600">{t.amount} {t.currency}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {new Date(t.created_at).toLocaleString()}
                  </p>
                </div>
                <span className={`text-xs font-semibold px-2 py-1 rounded ${
                  t.status === 'draft' ? 'bg-gray-100 text-gray-700' : 'bg-blue-100 text-blue-700'
                }`}>
                  {t.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
