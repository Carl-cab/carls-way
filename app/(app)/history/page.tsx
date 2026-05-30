'use client';
import { useEffect, useState } from 'react';

interface Transaction {
  id: number;
  sender_id: number;
  receiver_id: number;
  sender_name: string;
  sender_username: string;
  sender_avatar_color: string;
  receiver_name: string;
  receiver_username: string;
  receiver_avatar_color: string;
  amount: number;
  currency: string;
  note: string;
  type: string;
  status: string;
  privacy: string;
  created_at: string;
}

interface Me {
  id: number;
}

function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
  return (
    <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0" style={{ backgroundColor: color }}>
      {initials}
    </div>
  );
}

function formatAmount(amount: number, currency: string) {
  const locale = currency === 'USD' ? 'en-US' : 'en-CA';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function formatDate(dateStr: string) {
  return new Date(dateStr + 'Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function HistoryPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/me').then(r => r.json()).then(data => setMe(data));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/transactions?filter=${filter}`)
      .then(r => r.json())
      .then(data => {
        setTransactions(Array.isArray(data) ? data : []);
        setLoading(false);
      });
  }, [filter]);

  async function handleAction(id: number, action: 'accept' | 'decline') {
    const res = await fetch(`/api/transactions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      setTransactions(prev => prev.filter(tx => tx.id !== id));
    }
  }

  const filters = ['all', 'sent', 'received', 'pending'];

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-4">Activity</h2>

      <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
        {filters.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition ${
              filter === f
                ? 'bg-red-700 text-white'
                : 'bg-white text-gray-600 border border-gray-300 hover:border-red-400'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading && <div className="text-center py-12 text-gray-400">Loading…</div>}

      {!loading && transactions.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-5xl mb-4">📭</div>
          <p className="text-gray-600">No transactions found</p>
        </div>
      )}

      <div className="space-y-3">
        {transactions.map(tx => {
          const isSender = me && tx.sender_id === me.id;
          const isPendingRequest = tx.type === 'request' && tx.status === 'pending';
          const amReceiver = me && tx.receiver_id === me.id;

          let label = '';
          let amountColor = 'text-gray-800';
          let amountPrefix = '';

          if (tx.type === 'request' && tx.status === 'pending') {
            label = isSender ? `${tx.receiver_name} requested` : `You requested from ${tx.receiver_name}`;
            amountColor = 'text-yellow-600';
          } else if (tx.type === 'payment' && tx.status === 'completed') {
            if (isSender) {
              label = `You paid ${tx.receiver_name}`;
              amountColor = 'text-red-600';
              amountPrefix = '-';
            } else {
              label = `${tx.sender_name} paid you`;
              amountColor = 'text-green-600';
              amountPrefix = '+';
            }
          } else if (tx.status === 'declined') {
            label = 'Request declined';
            amountColor = 'text-gray-400';
          }

          return (
            <div key={tx.id} className={`bg-white rounded-xl shadow-sm border p-4 ${isPendingRequest && isSender ? 'border-yellow-300' : 'border-gray-100'}`}>
              <div className="flex items-start gap-3">
                <Avatar
                  name={isSender ? tx.receiver_name : tx.sender_name}
                  color={isSender ? tx.receiver_avatar_color : tx.sender_avatar_color}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{label}</p>
                  {tx.note && <p className="text-sm text-gray-500 truncate mt-0.5">{tx.note}</p>}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-gray-400">{formatDate(tx.created_at)}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      tx.status === 'completed' ? 'bg-green-100 text-green-700' :
                      tx.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-gray-100 text-gray-500'
                    }`}>{tx.status}</span>
                    <span className="text-xs text-gray-400">{tx.privacy === 'public' ? '🌍' : tx.privacy === 'friends' ? '👥' : '🔒'}</span>
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`font-bold ${amountColor}`}>{amountPrefix}{formatAmount(tx.amount, tx.currency || 'CAD')}</p>
                </div>
              </div>

              {/* Accept/Decline buttons for pending requests where current user is the payer */}
              {isPendingRequest && isSender && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => handleAction(tx.id, 'accept')}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-medium py-2 rounded-lg transition"
                  >
                    Accept ✓
                  </button>
                  <button
                    onClick={() => handleAction(tx.id, 'decline')}
                    className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg transition"
                  >
                    Decline ✗
                  </button>
                </div>
              )}

              {isPendingRequest && amReceiver && !isSender && (
                <div className="mt-2 text-xs text-gray-400 italic">Waiting for response…</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
