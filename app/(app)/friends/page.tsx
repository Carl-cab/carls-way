'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  avatar_color: string;
  province?: string;
}

interface Friend extends User {
  friendship_id: number;
  status: string;
  requested_by: number;
  direction: string;
  friendship_date: string;
}

function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
  return (
    <div
      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
      style={{ backgroundColor: color }}
    >
      {initials}
    </div>
  );
}

export default function FriendsPage() {
  const router = useRouter();
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingActions, setPendingActions] = useState<Set<number>>(new Set());

  const loadFriends = useCallback(() => {
    fetch('/api/friends')
      .then(r => r.json())
      .then(data => setFriends(Array.isArray(data) ? data : []));
  }, []);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  const loading = friends === null;

  async function search(q: string) {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); return; }
    setSearching(true);
    const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    setSearchResults(Array.isArray(data) ? data : []);
    setSearching(false);
  }

  async function sendRequest(friendId: number) {
    setPendingActions(s => new Set(s).add(friendId));
    const res = await fetch('/api/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId }),
    });
    setPendingActions(s => { const n = new Set(s); n.delete(friendId); return n; });
    if (res.ok) {
      loadFriends();
      setSearchQuery('');
      setSearchResults([]);
    }
  }

  async function acceptRequest(friendshipId: number) {
    setPendingActions(s => new Set(s).add(friendshipId));
    await fetch(`/api/friends/${friendshipId}/accept`, { method: 'POST' });
    setPendingActions(s => { const n = new Set(s); n.delete(friendshipId); return n; });
    loadFriends();
  }

  async function declineRequest(friendshipId: number) {
    setPendingActions(s => new Set(s).add(friendshipId));
    await fetch(`/api/friends/${friendshipId}/decline`, { method: 'POST' });
    setPendingActions(s => { const n = new Set(s); n.delete(friendshipId); return n; });
    loadFriends();
  }

  async function removeFriend(friendId: number) {
    await fetch('/api/friends', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId }),
    });
    loadFriends();
  }

  const friendList = friends ?? [];
  const knownIds = new Set(friendList.map(f => f.id));
  const acceptedFriends = friendList.filter(f => f.status === 'accepted');
  const incomingRequests = friendList.filter(f => f.status === 'pending' && f.direction === 'incoming');
  const outgoingRequests = friendList.filter(f => f.status === 'pending' && f.direction === 'outgoing');

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-gray-800">Friends</h2>

      {/* Search / Send Request */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <h3 className="font-semibold text-gray-700 mb-3">Find People</h3>
        <input
          type="text"
          value={searchQuery}
          onChange={e => search(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-500"
          placeholder="Search by name, username, or email…"
        />
        {searching && <p className="text-sm text-gray-400 mt-2">Searching…</p>}
        {searchResults.length > 0 && (
          <div className="mt-3 space-y-2">
            {searchResults.map(u => {
              const existing = friendList.find(f => f.id === u.id);
              return (
                <div key={u.id} className="flex items-center gap-3">
                  <Avatar name={u.name} color={u.avatar_color} />
                  <div className="flex-1">
                    <p className="font-medium text-sm text-gray-800">{u.name}</p>
                    <p className="text-xs text-gray-400">@{u.username}{u.province && ` · ${u.province}`}</p>
                  </div>
                  {knownIds.has(u.id) ? (
                    <span className="text-xs font-medium text-gray-500">
                      {existing?.status === 'accepted' ? 'Friends ✓' : existing?.direction === 'outgoing' ? 'Requested' : 'Incoming'}
                    </span>
                  ) : (
                    <button
                      onClick={() => sendRequest(u.id)}
                      disabled={pendingActions.has(u.id)}
                      className="bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-full transition"
                    >
                      + Add
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {searchQuery && !searching && searchResults.length === 0 && (
          <p className="text-sm text-gray-400 mt-2">No users found.</p>
        )}
      </div>

      {/* Incoming Requests */}
      {(incomingRequests.length > 0 || loading) && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">
            Friend Requests{' '}
            {incomingRequests.length > 0 && (
              <span className="ml-1 bg-red-600 text-white text-xs rounded-full px-1.5 py-0.5">
                {incomingRequests.length}
              </span>
            )}
          </h3>
          {loading && <p className="text-sm text-gray-400">Loading…</p>}
          <div className="space-y-3">
            {incomingRequests.map(f => (
              <div key={f.friendship_id} className="flex items-center gap-3">
                <Avatar name={f.name} color={f.avatar_color} />
                <div className="flex-1">
                  <p className="font-medium text-sm text-gray-800">{f.name}</p>
                  <p className="text-xs text-gray-400">@{f.username}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => acceptRequest(f.friendship_id)}
                    disabled={pendingActions.has(f.friendship_id)}
                    className="bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-full transition"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => declineRequest(f.friendship_id)}
                    disabled={pendingActions.has(f.friendship_id)}
                    className="border border-gray-300 text-gray-600 hover:text-red-600 hover:border-red-300 disabled:opacity-50 text-xs font-medium px-3 py-1.5 rounded-full transition"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outgoing Requests */}
      {outgoingRequests.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <h3 className="font-semibold text-gray-700 mb-3">Sent Requests</h3>
          <div className="space-y-3">
            {outgoingRequests.map(f => (
              <div key={f.friendship_id} className="flex items-center gap-3">
                <Avatar name={f.name} color={f.avatar_color} />
                <div className="flex-1">
                  <p className="font-medium text-sm text-gray-800">{f.name}</p>
                  <p className="text-xs text-gray-400">@{f.username}</p>
                </div>
                <span className="text-xs text-gray-400 italic">Pending…</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Accepted Friends */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <h3 className="font-semibold text-gray-700 mb-3">
          My Friends <span className="text-gray-400 font-normal">({acceptedFriends.length})</span>
        </h3>
        {loading && <p className="text-sm text-gray-400">Loading…</p>}
        {!loading && acceptedFriends.length === 0 && (
          <div className="text-center py-8 text-gray-400">
            <div className="text-4xl mb-2">👥</div>
            <p className="text-sm">No friends yet. Search above to add people!</p>
          </div>
        )}
        <div className="space-y-3">
          {acceptedFriends.map(f => (
            <div key={f.friendship_id} className="flex items-center gap-3">
              <Avatar name={f.name} color={f.avatar_color} />
              <div className="flex-1">
                <p className="font-medium text-sm text-gray-800">{f.name}</p>
                <p className="text-xs text-gray-400">@{f.username}{f.province && ` · ${f.province}`}</p>
              </div>
              <button
                onClick={() => router.push(`/send?to=${encodeURIComponent(f.username)}`)}
                className="bg-red-700 hover:bg-red-800 text-white text-xs font-medium px-3 py-1.5 rounded-full transition"
              >
                Send
              </button>
              <button
                onClick={() => removeFriend(f.id)}
                className="text-xs text-gray-400 hover:text-red-600 transition"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
