import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSql } from '@/lib/db';
import { signToken, COOKIE_NAME, validateEmail, validatePassword, sanitizeString, auditLog } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = sanitizeString(body.name || '', 100);
    const email = sanitizeString(body.email || '', 255).toLowerCase();
    const phone = sanitizeString(body.phone || '', 30);
    const province = sanitizeString(body.province || '', 50);
    const country = body.country === 'US' ? 'US' : 'CA';
    const password = body.password || '';

    // Input validation
    if (!name || !email || !password) {
      return NextResponse.json({ error: 'Name, email, and password are required' }, { status: 400 });
    }
    if (!validateEmail(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
    }
    const pwCheck = validatePassword(password);
    if (!pwCheck.valid) {
      return NextResponse.json({ error: pwCheck.reason }, { status: 400 });
    }

    const sql = getSql();

    // Check for existing email
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }

    // Generate username from name
    const baseUsername = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15);
    const suffix = Math.floor(Math.random() * 9000) + 1000;
    const username = `${baseUsername}${suffix}`;

    const password_hash = await bcrypt.hash(password, 12);
    const avatar_color = ['#E53E3E', '#DD6B20', '#D69E2E', '#38A169', '#3182CE', '#805AD5'][Math.floor(Math.random() * 6)];
    const userCountry = country;

    // Initial balances: CAD users get $100 CAD, US users get $100 USD
    const balance_cad = userCountry === 'CA' ? 100.00 : 0.00;
    const balance_usd = userCountry === 'US' ? 100.00 : 0.00;

    const result = await sql`
      INSERT INTO users (name, username, email, phone, password_hash, province, country, avatar_color, balance_cad, balance_usd, kyc_status)
      VALUES (${name}, ${username}, ${email}, ${phone || null}, ${password_hash}, ${province || null}, ${userCountry}, ${avatar_color}, ${balance_cad}, ${balance_usd}, 'pending')
      RETURNING id
    `;
    const userId = result[0].id as number;

    await auditLog(userId, 'user_registered', { email, country: userCountry });

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
