'use client';
import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';

interface Transaction {
  id: number;
  type: string;
  status: string;
  amount: number;
  currency: string;
  note: string;
  sender_username: string;
  sender_name: string;
  sender_avatar_color: string;
  receiver_username: string;
  receiver_name: string;
  receiver_avatar_color: string;
  sender_currency: string;
  receiver_currency: string;
  fx_rate: number | null;
  fx_fee: number | null;
  sender_amount: number | null;
  receiver_amount: number | null;
  is_cross_border: boolean;
  payment_rail: string;
  estimated_settlement: string | null;
  privacy: string;
  created_at: string;
}

function formatAmount(amount: number, currency: string) {
  const locale = currency === 'USD' ? 'en-US' : 'en-CA';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

function formatDateTime(dateStr: string) {
  const normalized = dateStr.endsWith('Z') ? dateStr : dateStr + 'Z';
  return new Date(normalized).toLocaleString('en-CA', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDate(dateStr: string) {
  const normalized = dateStr.endsWith('Z') ? dateStr : dateStr + 'Z';
  return new Date(normalized).toLocaleDateString('en-CA', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: 'bg-green-100 text-green-700',
    pending:   'bg-yellow-100 text-yellow-700',
    declined:  'bg-red-100 text-red-600',
  };
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold ${styles[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between items-start py-3 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500 shrink-0 mr-4">{label}</span>
      <span className={`text-sm text-gray-800 text-right ${mono ? 'font-mono' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

export default function TransactionReceiptPage() {
  const params = useParams();
  const router = useRouter();
  const [tx, setTx] = useState<Transaction | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = params?.id;
    if (!id) return;
    fetch(`/api/transactions/${id}`)
      .then(r => {
        if (r.status === 404 || r.status === 403) { setNotFound(true); setLoading(false); return null; }
        return r.json();
      })
      .then(data => {
        if (data) { setTx(data); setLoading(false); }
      });
  }, [params?.id]);

  function copyId() {
    if (!tx) return;
    navigator.clipboard.writeText(String(tx.id)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (loading) {
    return (
      <div className="text-center py-20 text-gray-400">
        <p>Loading receipt…</p>
      </div>
    );
  }

  if (notFound || !tx) {
    return (
      <div className="text-center py-20 text-gray-400">
        <div className="text-5xl mb-4">🔒</div>
        <p className="font-medium text-gray-600 mb-1">Transaction not found</p>
        <p className="text-sm mb-6">You may not have permission to view this receipt.</p>
        <button onClick={() => router.back()} className="text-red-700 text-sm font-medium hover:underline">
          ← Go back
        </button>
      </div>
    );
  }

  const isCrossBorder = tx.is_cross_border;
  const senderAmount = tx.sender_amount ?? tx.amount;
  const receiverAmount = tx.receiver_amount ?? tx.amount;
  const senderCurrency = tx.sender_currency || tx.currency;
  const receiverCurrency = tx.receiver_currency || tx.currency;

  const railLabels: Record<string, string> = {
    internal: 'Internal (instant)',
    wire: 'International Wire',
    ach: 'ACH',
  };

  return (
    <div className="max-w-lg mx-auto">
      <button onClick={() => router.back()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4 transition">
        ← Back
      </button>

      {/* Header card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-800">Receipt</h2>
          <StatusBadge status={tx.status} />
        </div>

        {/* Amount display */}
        <div className="text-center py-4">
          {isCrossBorder ? (
            <>
              <p className="text-3xl font-bold text-gray-900">
                {formatAmount(senderAmount, senderCurrency)}
              </p>
              <p className="text-sm text-gray-400 mt-1">
                → {formatAmount(receiverAmount, receiverCurrency)} received
              </p>
            </>
          ) : (
            <p className="text-3xl font-bold text-gray-900">
              {formatAmount(senderAmount, senderCurrency)}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2 uppercase tracking-wide">{tx.type}</p>
        </div>

        {/* Note */}
        {tx.note && (
          <div className="mt-2 p-3 bg-gray-50 rounded-lg text-sm text-gray-600 text-center italic">
            &ldquo;{tx.note}&rdquo;
          </div>
        )}
      </div>

      {/* Details card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 px-5 py-2 mb-4">
        <Row label="Date" value={formatDateTime(tx.created_at)} />
        <Row label="From" value={`@${tx.sender_username}`} />
        <Row label="To" value={`@${tx.receiver_username}`} />
        <Row label="Amount sent" value={formatAmount(senderAmount, senderCurrency)} />
        {isCrossBorder && (
          <>
            <Row label="Amount received" value={formatAmount(receiverAmount, receiverCurrency)} />
            <Row label="FX rate" value={`1 ${senderCurrency} = ${Number(tx.fx_rate).toFixed(6)} ${receiverCurrency}`} />
            <Row label="FX fee" value={formatAmount(Number(tx.fx_fee), senderCurrency)} />
          </>
        )}
        <Row label="Payment rail" value={railLabels[tx.payment_rail] ?? tx.payment_rail} />
        {tx.estimated_settlement && (
          <Row label="Est. settlement" value={formatDate(tx.estimated_settlement)} />
        )}
        <Row label="Privacy" value={tx.privacy === 'public' ? '🌍 Public' : tx.privacy === 'friends' ? '👥 Friends' : '🔒 Private'} />
      </div>

      {/* Transaction ID card */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
        <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Transaction ID</p>
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-sm text-gray-700 break-all">#{tx.id}</span>
          <button
            onClick={copyId}
            className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border border-gray-300 hover:border-red-400 hover:text-red-700 transition"
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
