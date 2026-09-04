'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface FeedItem {
  id: number;
  sender_name: string;
  sender_username: string;
  sender_avatar_color: string;
  receiver_name: string;
  receiver_username: string;
  receiver_avatar_color: string;
  sender_amount: number;
  sender_currency: string;
  receiver_amount: number;
  receiver_currency: string;
  note: string | null;
  created_at: string;
}

interface MyTransaction extends FeedItem {
  sender_id: number;
  receiver_id: number;
  type: string;
  status: string;
}

interface Me {
  id: number;
  name: string;
  country: string;
  balance_cad: number;
  balance_usd: number;
  avatar_color: string;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning,';
  if (h < 18) return 'Good afternoon,';
  return 'Good evening,';
}

function initials(name: string) {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function formatAmount(amount: number, currency: string) {
  const locale = currency === 'USD' ? 'en-US' : 'en-CA';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function timeAgo(dateStr: string) {
  const normalized = dateStr.endsWith('Z') ? dateStr : dateStr + 'Z';
  const diff = Date.now() - new Date(normalized).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Avatar({ name, color, size = 40 }: { name: string; color: string; size?: number }) {
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
      style={{ backgroundColor: color || '#1d4ed8', width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials(name)}
    </div>
  );
}

const QUICK_ACTIONS = [
  { label: 'Send', icon: '💸', href: '/send' },
  { label: 'Request', icon: '📩', href: '/request' },
  { label: 'Friends', icon: '👥', href: '/friends' },
  { label: 'History', icon: '🧾', href: '/history' },
];

export default function FeedPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<'friends' | 'mine'>('friends');
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [mine, setMine] = useState<MyTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/me').then(r => r.json()).catch(() => null),
      fetch('/api/feed').then(r => r.json()).catch(() => []),
      fetch('/api/transactions').then(r => r.json()).catch(() => []),
    ]).then(([meData, feedData, txData]) => {
      if (meData?.id) setMe(meData);
      setFeed(Array.isArray(feedData) ? feedData : []);
      setMine(Array.isArray(txData) ? txData : []);
      setLoading(false);
    });
  }, []);

  const currency = me?.country === 'US' ? 'USD' : 'CAD';
  const balance = me ? (me.country === 'US' ? me.balance_usd : me.balance_cad) : 0;
  const items = tab === 'friends' ? feed : mine;

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500">{greeting()}</p>
          <h1 className="text-2xl font-bold text-gray-900">{me?.name ?? '…'}</h1>
        </div>
        <Link href="/profile" aria-label="Profile">
          {me ? <Avatar name={me.name} color={me.avatar_color} size={48} /> : <div className="w-12 h-12 rounded-full bg-gray-200" />}
        </Link>
      </div>

      {/* Balance card */}
      <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 text-white p-6 shadow-lg">
        <p className="text-sm text-blue-100">Manna Balance</p>
        <p className="text-4xl font-bold mt-1">{formatAmount(balance, currency)}</p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Link
            href="/transfers?type=add_money"
            className="text-center bg-white/20 hover:bg-white/30 rounded-xl py-2.5 text-sm font-semibold transition"
          >
            Add Money
          </Link>
          <Link
            href="/transfers?type=cash_out"
            className="text-center bg-white/20 hover:bg-white/30 rounded-xl py-2.5 text-sm font-semibold transition"
          >
            Transfer Out
          </Link>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-4 gap-3">
        {QUICK_ACTIONS.map(a => (
          <Link
            key={a.label}
            href={a.href}
            className="bg-white border border-gray-200 rounded-2xl py-4 flex flex-col items-center gap-1.5 shadow-sm hover:border-blue-400 hover:shadow transition"
          >
            <span className="text-2xl leading-none">{a.icon}</span>
            <span className="text-xs font-medium text-gray-700">{a.label}</span>
          </Link>
        ))}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 flex gap-6">
        {([['friends', 'Friends Activity'], ['mine', 'My Transactions']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`pb-3 text-sm font-semibold border-b-2 -mb-px transition ${
              tab === key
                ? 'text-blue-600 border-blue-600'
                : 'text-gray-500 border-transparent hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Activity list */}
      {loading && <p className="text-center py-12 text-gray-400">Loading…</p>}

      {!loading && items.length === 0 && (
        <div className="text-center py-14 text-gray-400">
          <div className="text-4xl mb-3">💸</div>
          <p className="font-medium text-gray-600 mb-1">
            {tab === 'friends' ? 'No public transactions yet' : 'No transactions yet'}
          </p>
          <p className="text-sm">Send or request money to get started.</p>
        </div>
      )}

      <div className="space-y-3">
        {items.map(tx => {
          const outgoing = tab === 'mine' && me ? (tx as MyTransaction).sender_id === me.id : true;
          const amount = outgoing ? tx.sender_amount : tx.receiver_amount;
          const amountCurrency = outgoing ? tx.sender_currency : tx.receiver_currency;
          return (
            <button
              key={tx.id}
              onClick={() => router.push(`/transactions/${tx.id}`)}
              className="w-full text-left bg-white rounded-2xl border border-gray-200 shadow-sm hover:border-gray-300 transition"
            >
              <div className="p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={tx.sender_name} color={tx.sender_avatar_color} />
                  <p className="text-sm text-gray-900">
                    <span className="font-semibold">{tx.sender_name}</span>
                    <span className="text-gray-500"> paid </span>
                    <span className="font-semibold">{tx.receiver_name}</span>
                  </p>
                </div>
                <div className="mt-3 pl-[52px]">
                  <p className={`text-xl font-bold ${outgoing ? 'text-gray-900' : 'text-green-600'}`}>
                    {outgoing ? '-' : '+'}{formatAmount(Number(amount ?? 0), amountCurrency || 'CAD')}
                  </p>
                  {tx.note && <p className="text-sm text-gray-500 mt-0.5">{tx.note}</p>}
                </div>
              </div>
              <div className="border-t border-gray-100 px-4 py-2.5 flex justify-end">
                <span className="text-xs text-gray-400">{timeAgo(tx.created_at)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
