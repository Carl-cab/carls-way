import { NextResponse } from 'next/server';
import { getAuthUser, auditLog } from '@/lib/auth';
import { getSql } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import {
  canAutoVerifyIdentity,
  assertKycProviderConfigured,
  ConfigurationError,
} from '@/lib/environment';

/**
 * Start identity verification.
 *
 * Fail-closed contract: auto-verification is gated solely on an explicitly
 * declared sandbox environment (`MANNA_ENV=sandbox`). It never consults whether
 * a credential happens to be present, so a production deployment with a missing
 * or malformed STRIPE_SECRET_KEY produces a controlled 503 and the user stays
 * unverified — it can never degrade into automatic approval.
 */
export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sql = getSql();

    // Prevent duplicate sessions for already-verified users
    const rows = await sql`SELECT kyc_status FROM users WHERE id = ${user.userId}`;
    if (rows[0]?.kyc_status === 'verified') {
      return NextResponse.json({ error: 'Identity already verified' }, { status: 400 });
    }

    // Explicitly declared sandbox only. No credential is inspected here.
    if (canAutoVerifyIdentity()) {
      await sql`
        UPDATE users
        SET kyc_status = 'verified', kyc_provider = 'sandbox', kyc_session_id = NULL
        WHERE id = ${user.userId}
      `;
      await auditLog(user.userId, 'kyc_sandbox_verified', { mode: 'sandbox' });
      return NextResponse.json({ sandbox: true, verified: true });
    }

    // Production path. Any configuration problem below must abort the request
    // with the user left unverified.
    assertKycProviderConfigured();

    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      throw new ConfigurationError('kyc', 'NEXT_PUBLIC_APP_URL is not configured.');
    }

    const stripe = getStripe();
    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { user_id: String(user.userId) },
      options: {
        document: {
          require_matching_selfie: true,
        },
      },
      return_url: `${appUrl}/profile?kyc=complete`,
    });

    // Store session ID and mark as pending — webhook is the source of truth for status
    await sql`
      UPDATE users
      SET kyc_session_id = ${session.id},
          kyc_provider   = 'stripe',
          kyc_status     = 'pending'
      WHERE id = ${user.userId}
    `;

    await auditLog(user.userId, 'kyc_session_created', { sessionId: session.id });

    // Only return the hosted URL and session ID — never expose the raw session object
    return NextResponse.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    // A configuration problem is reported as "unavailable", never as success.
    // The user's kyc_status is untouched on this path.
    if (err instanceof ConfigurationError) {
      console.error(`KYC configuration error [${err.capability}]:`, err.message);
      return NextResponse.json(
        { error: 'Identity verification is temporarily unavailable. Please try again later.' },
        { status: 503 },
      );
    }

    // Provider failure (Stripe unreachable, rejected the request, invalid key at
    // the API boundary, ...) also leaves the user unverified.
    console.error('KYC create-session error:', err);
    return NextResponse.json({ error: 'Failed to create verification session' }, { status: 500 });
  }
}
