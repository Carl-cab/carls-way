import { NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { betaRestrictionState } from '@/lib/beta-restrictions';

/**
 * The active beta profile, for the interface and for pre-invitation
 * verification.
 *
 * ONE RESOLVER, TWO READERS. This returns `betaRestrictionState()` — the same
 * function the routes enforce with. A separate UI-side constant would be free
 * to drift, and a UI that hid a button while the API still honoured it would
 * be worse than no restriction at all, because it would look controlled.
 *
 * Authenticated, because it describes the deployment's posture rather than
 * public marketing copy. It exposes no credential, no host and no count — only
 * which capabilities are withheld, which is what a participant is told anyway
 * when they try one.
 *
 * This is also the endpoint the invitation gate checks: the restriction is a
 * configuration-dependent control, so "it is on" has to be READ FROM THE
 * RUNNING DEPLOYMENT rather than assumed from an environment variable
 * somebody believes they set.
 */
export async function GET() {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return NextResponse.json(betaRestrictionState());
}
