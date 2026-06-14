import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSql } from '@/lib/db';
import { signToken, COOKIE_NAME } from '@/lib/auth';

const AVATAR_COLORS = [
  '#CC0000', '#1a6b3c', '#003087', '#c8860a', '#6b21a8',
  '#0f766e', '#be123c', '#1d4ed8', '#15803d', '#9333ea',
];

export async function POST(req: NextRequest) {
  try {
    const sql = getSql();
    const { name, email, phone, password, province, country } = await req.json();
    if (!name || !email || !password) {
      return NextResponse.json({ error: 'Name, email, and password are required' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
    }
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }
    const username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + Math.floor(Math.random() * 1000);
    const password_hash = await bcrypt.hash(password, 10);
    const avatar_color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    const userCountry = country === 'US' ? 'US' : 'CA';
    const result = await sql`
      INSERT INTO users (name, username, email, phone, password_hash, province, country, avatar_color)
      VALUES (${name}, ${username}, ${email}, ${phone || null}, ${password_hash}, ${province || null}, ${userCountry}, ${avatar_color})
      RETURNING id
    `;
    const userId = result[0].id as number;
    const token = signToken({ userId, email, username });
    const response = NextResponse.json({ success: true, username }, { status: 201 });
    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });
    return response;
  } catch (err) {
    console.error('Register error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
