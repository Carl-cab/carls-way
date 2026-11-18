import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getSql } from '@/lib/db';
import { signTokenForUser, COOKIE_NAME, validateEmail, validatePassword, sanitizeString, auditLog } from '@/lib/auth';
import { checkRateLimit, rateLimitHeaders, clientIdentifier } from '@/lib/rate-limit';
import { isSandboxEnvironment } from '@/lib/environment';
import { createLedgerEntry } from '@/lib/ledger';
import { toDatabaseDecimal, ZERO_MINOR_UNITS } from '@/lib/money';

/**
 * The sandbox registration grant: CA$100 / US$100, in MINOR UNITS.
 *
 * Minor units because that is what the ledger helpers take, and the
 * conversion is where this went wrong once — see the note at the call site.
 *
 * This is NOT decision 0013's sandbox funding capacity and must not be
 * counted against it: that is a cumulative ceiling on simulated funding
 * through the transfer rail, this is a demo account's starting balance.
 */
const REGISTRATION_GRANT_MINOR_UNITS = 10_000;

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

    // Brute-force protection. Keyed on client IP, so one abusive client
    // cannot lock out everybody else.
    const rate = await checkRateLimit('auth:register', clientIdentifier(req));
    if (!rate.allowed) {
      return NextResponse.json(
        { error: 'Too many attempts. Please try again later.' },
        { status: 429, headers: rateLimitHeaders(rate) },
      );
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

    // THE REGISTRATION GRANT IS SANDBOX-ONLY, AND IT IS BOOKED.
    //
    // Two separate defects were corrected here together, because fixing
    // either alone leaves an inconsistent account (owner decision 2,
    // 2026-11-18).
    //
    // 1. The grant was unconditional. Every account created on ANY deployment
    //    received CA$100 or US$100, production included — simulated money
    //    credited to a real customer wallet with no funding event, no
    //    provider settlement and no accounting behind it. A production
    //    account must start at zero unless an independently authorized and
    //    properly accounted funding or promotional mechanism exists, and none
    //    does.
    // 2. The grant was never booked. It went straight into
    //    `balance_cad`/`balance_usd` with no ledger entry, so every
    //    registered user's wallet was permanently out of step with their
    //    ledger by their seed amount and
    //    `user_wallets_exactly_match_ledger` could never pass.
    //
    // `isSandboxEnvironment()` is a positive opt-in on `MANNA_ENV=sandbox`
    // exactly, and `VERCEL_ENV=production` overrides it — so this cannot be
    // switched on by a misconfigured or absent variable. Production is the
    // default and the default is zero.
    //
    // This grant is NOT decision 0013's sandbox funding capacity, and must
    // not be counted against it. That is a per-user cumulative ceiling on
    // simulated *funding* through the transfer rail; this is the starting
    // balance of a demo account. They are separate mechanisms with separate
    // authorizations, and conflating them would let one consume the other's
    // budget.
    // Held in MINOR UNITS as the single source of truth, because the two
    // consumers want different representations and the conversion is exactly
    // where this went wrong once: `createLedgerEntry()` takes minor units, so
    // passing the decimal 100.00 booked a ledger credit of $1.00 against a
    // wallet of $100.00 — a 100x understatement that every balance assertion
    // except a ledger one would have missed.
    const sandbox = isSandboxEnvironment();
    const grantMinorUnits = sandbox ? REGISTRATION_GRANT_MINOR_UNITS : 0;
    const balance_cad = userCountry === 'CA' ? toDatabaseDecimal(grantMinorUnits) : '0';
    const balance_usd = userCountry === 'US' ? toDatabaseDecimal(grantMinorUnits) : '0';

    // One transaction: the account row and its opening-balance entry both
    // exist or neither does. A failure after the INSERT previously left an
    // account whose balance no ledger explained.
    const userId = await sql.begin(async (tx) => {
      const result = await tx`
        INSERT INTO users (name, username, email, phone, password_hash, province, country, avatar_color, balance_cad, balance_usd, kyc_status)
        VALUES (${name}, ${username}, ${email}, ${phone || null}, ${password_hash}, ${province || null}, ${userCountry}, ${avatar_color}, ${balance_cad}, ${balance_usd}, 'pending')
        RETURNING id
      `;
      const newUserId = result[0].id as number;

      const grantCurrency = userCountry === 'US' ? 'USD' : 'CAD';

      if (grantMinorUnits > 0) {
        // Credit, because value enters the user's wallet. Booked on the same
        // `tx`, so it cannot outlive a rolled-back account.
        //
        // Deliberately `entry_type='opening_balance'`, the type
        // `reconcileInternalTransactions()` already counts toward wallet
        // equality and that no per-payment invariant claims — a registration
        // grant is not a payment and must not look like one.
        await createLedgerEntry(
          newUserId,
          grantCurrency,
          'wallet',
          'opening_balance',
          ZERO_MINOR_UNITS,
          grantMinorUnits,
          {
            executor: tx,
            description: 'Sandbox registration grant (simulated funds, not a deposit)',
          },
        );
      }

      return newUserId;
    });

    // Outside the transaction on purpose: `auditLog()` takes its own
    // connection, and calling it inside would ask the `max: 5` pool for a
    // second connection while holding one.
    await auditLog(userId, 'user_registered', {
      email,
      country: userCountry,
      environment: sandbox ? 'sandbox' : 'production',
      registration_grant:
        grantMinorUnits > 0
          ? {
              minor_units: grantMinorUnits,
              currency: userCountry === 'US' ? 'USD' : 'CAD',
            }
          : null,
    });

    const token = await signTokenForUser({ userId, email, username });
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
