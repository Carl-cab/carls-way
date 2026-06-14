'use client';
import { useEffect, useState } from 'react';

interface Transaction {
  id: number;
  sender_name: string;
  sender_username: string;
  sender_avatar_color: string;
  receiver_name: string;
  receiver_username: string;
  receiver_avatar_color: string;
  amount: number;
  currency: string;
  note: string;
  created_at: string;
}

function Avatar({ name, color, size = 'md' }: { name: string; color: string; size?: 'sm' | 'md' }) {
  const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  const cls = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
  return (
    <div className={`${cls} rounded-full flex items-center justify-center text-white font-bold flex-shrink-0`} style={{ backgroundColor: color }}>
      {initials}
    </div>
  );
}

function formatAmount(amount: number, currency: string) {
  const locale = currency === 'USD' ? 'en-US' : 'en-CA';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function timeAgo(dateStr: string) {
  // Avoid appending 'Z' if the string already ends with 'Z'
  const normalized = dateStr.endsWith('Z') ? dateStr : dateStr + 'Z';
  const diff = Date.now() - new Date(normalized).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function FeedPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/transactions?feed=true')
      .then(r => r.json())
      .then(data => {
        setTransactions(Array.isArray(data) ? data : []);
        setLoading(false);
      });
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">Public Feed</h2>
        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">🇨🇦 CAD · 🇺🇸 USD</span>
      </div>

      {loading && (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">🍁</div>
          <p>Loading feed…</p>
        </div>
      )}

      {!loading && transactions.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-5xl mb-4">💸</div>
          <p className="font-medium text-gray-600 mb-1">No public transactions yet</p>
          <p className="text-sm">Be the first to pay a friend!</p>
        </div>
      )}

      <div className="space-y-3">
        {transactions.map(tx => (
          <div key={tx.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="flex items-start gap-3">
              <Avatar name={tx.sender_name} color={tx.sender_avatar_color} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800">
                  <span className="font-semibold">{tx.sender_name}</span>
                  <span className="text-gray-500"> paid </span>
                  <span className="font-semibold">{tx.receiver_name}</span>
                </p>
                {tx.note && (
                  <p className="text-gray-600 text-sm mt-0.5 truncate">{tx.note}</p>
                )}
                <p className="text-xs text-gray-400 mt-1">{timeAgo(tx.created_at)}</p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-bold text-green-600">{formatAmount(tx.amount, tx.currency || 'CAD')}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
