'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  related_entity_type: string | null;
  related_entity_id: number | null;
  read_at: string | null;
  created_at: string;
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

function notifIcon(type: string) {
  switch (type) {
    case 'friend_request': return '👤';
    case 'friend_request_accepted': return '✅';
    case 'payment_received': return '💸';
    case 'payment_request': return '📥';
    default: return '🔔';
  }
}

function notifDestination(notif: Notification): string | null {
  if (notif.related_entity_type === 'transaction' && notif.related_entity_id) {
    return `/transactions/${notif.related_entity_id}`;
  }
  if (notif.related_entity_type === 'friendship') {
    return '/friends';
  }
  return null;
}

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(() => {
    fetch('/api/notifications')
      .then(r => r.json())
      .then(data => setNotifications(Array.isArray(data) ? data : []));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function markRead(id: number) {
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    setNotifications(prev =>
      prev ? prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n) : prev
    );
  }

  async function markAllRead() {
    setMarkingAll(true);
    await fetch('/api/notifications/read-all', { method: 'POST' });
    const now = new Date().toISOString();
    setNotifications(prev =>
      prev ? prev.map(n => ({ ...n, read_at: n.read_at ?? now })) : prev
    );
    setMarkingAll(false);
  }

  async function handleClick(notif: Notification) {
    if (!notif.read_at) await markRead(notif.id);
    const dest = notifDestination(notif);
    if (dest) router.push(dest);
  }

  const notifList = notifications ?? [];
  const unreadCount = notifList.filter(n => !n.read_at).length;
  const loading = notifications === null;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">Notifications</h2>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            disabled={markingAll}
            className="text-sm text-red-700 font-medium hover:underline disabled:opacity-50"
          >
            Mark all read
          </button>
        )}
      </div>

      {loading && <p className="text-sm text-gray-400 text-center py-12">Loading…</p>}

      {!loading && notifList.length === 0 && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-5xl mb-4">🔔</div>
          <p className="text-sm">No notifications yet.</p>
        </div>
      )}

      <div className="space-y-2">
        {notifList.map(notif => {
          const isUnread = !notif.read_at;
          const dest = notifDestination(notif);
          return (
            <div
              key={notif.id}
              onClick={() => handleClick(notif)}
              className={`flex items-start gap-3 p-4 rounded-xl border transition ${
                isUnread
                  ? 'bg-white border-red-100 shadow-sm cursor-pointer hover:border-red-300'
                  : 'bg-gray-50 border-gray-100 cursor-pointer hover:border-gray-200'
              } ${dest ? 'cursor-pointer' : 'cursor-default'}`}
            >
              <span className="text-2xl flex-shrink-0 mt-0.5">{notifIcon(notif.type)}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className={`text-sm ${isUnread ? 'font-semibold text-gray-900' : 'font-medium text-gray-700'}`}>
                    {notif.title}
                  </p>
                  {isUnread && (
                    <span className="flex-shrink-0 w-2 h-2 rounded-full bg-red-600 mt-1.5" />
                  )}
                </div>
                <p className="text-sm text-gray-500 mt-0.5">{notif.message}</p>
                <p className="text-xs text-gray-400 mt-1">{timeAgo(notif.created_at)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
