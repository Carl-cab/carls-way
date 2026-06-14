import postgres from 'postgres';

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    _sql = postgres(process.env.DATABASE_URL, {
      ssl: 'require',
      max: 5,
      idle_timeout: 30,
      connect_timeout: 10,
    });
  }
  return _sql;
}

export async function initializeSchema() {
  const sql = getSql();
  await sql`
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
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS friends (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      friend_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, friend_id)
    )
  `;
  await sql`
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
  `;
}

export default getSql;
