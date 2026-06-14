import { Pool } from 'pg';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return _pool;
}

// Helper: run a parameterized query
export async function query(text: string, params?: unknown[]) {
  const pool = getPool();
  return pool.query(text, params);
}

export async function initializeSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 100.00,
      province TEXT,
      country TEXT NOT NULL DEFAULT 'CA',
      avatar_color TEXT NOT NULL DEFAULT '#CC0000',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      friend_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CAD',
      note TEXT,
      type TEXT NOT NULL DEFAULT 'payment',
      status TEXT NOT NULL DEFAULT 'completed',
      privacy TEXT NOT NULL DEFAULT 'public',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export default getPool;
