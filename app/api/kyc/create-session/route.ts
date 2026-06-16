import { NextResponse } from 'next/server';
import { getAuthUser, auditLog } from '@/lib/auth';
import { getSql } from '@/lib/db';
import { getStripe } from '@/lib/stripe';

export async function POST() {
  try {
    const user = await getAuthUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL is not configured' }, { status: 500 });
    }

    const sql = getSql();

    // Prevent duplicate sessions for already-verified users
    const rows = await sql`SELECT kyc_status FROM users WHERE id = ${user.userId}`;
    if (rows[0]?.kyc_status === 'verified') {
      return NextResponse.json({ error: 'Identity already verified' }, { status: 400 });
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
    console.error('KYC create-session error:', err);
    return NextResponse.json({ error: 'Failed to create verification session' }, { status: 500 });
  }
}
