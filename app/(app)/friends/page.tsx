'use client';
import { useEffect, useState } from 'react';

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
  direction: string;
  friendship_date: string;
}

function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2);
  return (
    <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0" style={{ backgroundColor: color }}>
      {initials}
    </div>
  );
}

export default function FriendsPage() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    loadFriends();
  }, []);

  function loadFriends() {
    fetch('/api/friends').then(r => r.json()).then(data => {
      setFriends(Array.isArray(data) ? data : []);
      setLoading(false);
    });
  }

  async function search(q: string) {
    setSearchQuery(q);
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    setSearchResults(Array.isArray(data) ? data : []);
    setSearching(false);
  }

  async function addFriend(friendId: number) {
    const res = await fetch('/api/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId }),
    });
    if (res.ok) {
      loadFriends();
      setSearchQuery('');
      setSearchResults([]);
    }
  }

  async function removeFriend(friendId: number) {
    await fetch('/api/friends', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId }),
    });
    loadFriends();
  }

  const friendIds = new Set(friends.map(f => f.id));
  const acceptedFriends = friends.filter(f => f.status === 'accepted');

  return (
    <div>
      <h2 className="text-xl font-bold text-gray-800 mb-4">Friends</h2>

      {/* Search */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
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
            {searchResults.map(user => (
              <div key={user.id} className="flex items-center gap-3">
                <Avatar name={user.name} color={user.avatar_color} />
                <div className="flex-1">
                  <p className="font-medium text-sm text-gray-800">{user.name}</p>
                  <p className="text-xs text-gray-400">@{user.username} {user.province && `· ${user.province}`}</p>
                </div>
                {friendIds.has(user.id) ? (
                  <span className="text-xs text-green-600 font-medium">Added ✓</span>
                ) : (
                  <button
                    onClick={() => addFriend(user.id)}
                    className="bg-red-700 hover:bg-red-800 text-white text-xs font-medium px-3 py-1.5 rounded-full transition"
                  >
                    + Add
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {searchQuery && !searching && searchResults.length === 0 && (
          <p className="text-sm text-gray-400 mt-2">No users found.</p>
        )}
      </div>

      {/* Friends list */}
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
          {acceptedFriends.map(friend => (
            <div key={friend.friendship_id} className="flex items-center gap-3">
              <Avatar name={friend.name} color={friend.avatar_color} />
              <div className="flex-1">
                <p className="font-medium text-sm text-gray-800">{friend.name}</p>
                <p className="text-xs text-gray-400">@{friend.username} {friend.province && `· ${friend.province}`}</p>
              </div>
              <button
                onClick={() => removeFriend(friend.id)}
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
