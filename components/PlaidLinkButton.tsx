'use client';
import { useState, useCallback, useEffect } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { loadStripe } from '@stripe/stripe-js';
import { clientCapabilityAvailable } from '@/lib/beta-capability-client';

interface Props {
  userCountry: string;
  onSuccess: () => void;
}

/**
 * PlaidLinkButton
 *
 * Handles the full bank account linking flow:
 * 1. Fetches a Plaid link token
 * 2. Opens Plaid Link (react-plaid-link)
 * 3. On Plaid success: exchanges public token → saves bank_account row → gets back bank_account_id
 * 4. If user is CA: creates Stripe ACSS SetupIntent, confirms via Stripe.js,
 *    then calls /api/stripe/confirm-setup to store stripe_payment_method_id
 * 5. Calls onSuccess() to refresh parent state
 */
export default function PlaidLinkButton({ userCountry, onSuccess }: Props) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'idle' | 'plaid' | 'stripe' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stripeStep, setStripeStep] = useState<string>('');
  /**
   * Three states, and the distinction between the last two is the point.
   *
   *   'pending'    the profile has not answered yet
   *   'available'   the profile said bank_linking is available
   *   'withheld'    the profile said it is withheld
   *   'unknown'     the request failed, or answered something unreadable
   *
   * FAIL CLOSED. An earlier revision used `boolean | null` and only disabled
   * the control on an explicit `false`, so an unknown answer — a non-ok
   * response, a network failure, a body without the field — left the "+ Link
   * Account" button live. That is the wrong default twice over: the user is
   * offered an action the server will refuse with 403, and an operator
   * glancing at the page sees a beta that looks unrestricted. Treating
   * unknown as withheld costs a disabled button during an outage and cannot
   * misrepresent the restriction.
   *
   * WHY 'unknown' IS NOT FOLDED INTO 'withheld'. They fail closed
   * identically — neither renders a way to start linking — but they must not
   * say the same thing. In PRODUCTION there is no beta: bank_linking resolves
   * available, so the only way this component ever reaches a non-available
   * state there is a FAILED request. Collapsing the two told a production user
   * "unavailable in this beta", which is false, and left them no way back
   * short of reloading the page. 'unknown' says the check failed and offers a
   * retry.
   */
  type Availability = 'pending' | 'available' | 'withheld' | 'unknown';
  const [linkingAllowed, setLinkingAllowed] = useState<Availability>('pending');

  const isCA = userCountry === 'CA';

  // The interface reads the SAME resolver the route enforces with, so the
  // button state and the refusal cannot disagree. This is presentation only --
  // the control is the 403 in the route, and removing this effect changes
  // nothing about what the API permits. Which is also why failing closed here
  // is safe: it can only ever be MORE restrictive than the server.
  const [profileAttempt, setProfileAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    // `no-store`: the route sets no cache headers, so a heuristically cached
    // 200 could otherwise keep showing a control after the profile was
    // tightened — reintroducing the UI/server mismatch the one-resolver rule
    // exists to prevent.
    fetch('/api/beta-profile', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: unknown) => {
        if (cancelled) return;
        // The shared fail-closed resolver, not an inline check: a missing
        // capabilities object, a missing key or a non-boolean all resolve to
        // WITHHELD. Pinned in lib/__tests__/beta-containment.test.ts.
        setLinkingAllowed(clientCapabilityAvailable(d, 'bank_linking') ? 'available' : 'withheld');
      })
      .catch(() => {
        // A failed request is NOT "unknown, carry on" — but it is also not a
        // beta restriction. See the note on the Availability type.
        if (!cancelled) setLinkingAllowed('unknown');
      });
    return () => { cancelled = true; };
  }, [profileAttempt]);

  // ─── Fetch Plaid link token ───────────────────────────────────────────────
  const fetchLinkToken = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/plaid/create-link-token', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.link_token) throw new Error(data.error || 'Failed to create link token');
      setLinkToken(data.link_token);
      setStep('plaid');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start bank linking');
      setStep('error');
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Plaid Link success handler ──────────────────────────────────────────
  const handlePlaidSuccess = useCallback(async (publicToken: string, metadata: Record<string, unknown>) => {
    setLoading(true);
    setError(null);
    try {
      // Exchange public token → creates bank_account row
      const exchangeRes = await fetch('/api/plaid/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token: publicToken, metadata }),
      });
      const exchangeData = await exchangeRes.json();
      if (!exchangeRes.ok) throw new Error(exchangeData.error || 'Failed to link bank account');

      const accounts: Array<{ id: number }> = exchangeData.accounts || [];
      const bankAccountId = accounts[0]?.id;

      // For CA users: collect ACSS Debit mandate via Stripe Elements
      if (isCA && bankAccountId) {
        setStep('stripe');
        setStripeStep('Creating PAD mandate…');

        // 1. Create SetupIntent on server
        const siRes = await fetch('/api/stripe/setup-intent', { method: 'POST' });
        const siData = await siRes.json();
        if (!siRes.ok) throw new Error(siData.error || 'Failed to create Stripe setup intent');

        const { client_secret: clientSecret } = siData;

        // 2. Confirm the SetupIntent via Stripe.js (collects PAD mandate in-browser)
        setStripeStep('Authorizing PAD mandate…');
        const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
        if (!publishableKey) throw new Error('Stripe publishable key not configured');

        const stripe = await loadStripe(publishableKey);
        if (!stripe) throw new Error('Failed to load Stripe.js');

        const { setupIntent, error: stripeError } = await stripe.confirmAcssDebitSetup(
          clientSecret,
          {
            payment_method: {
              billing_details: {
                // Stripe requires name for ACSS Debit
                name: (metadata as { institution?: { name?: string } })?.institution?.name || 'Account Holder',
              },
            },
          }
        );

        if (stripeError) {
          throw new Error(stripeError.message || 'Stripe mandate authorization failed');
        }

        if (!setupIntent || setupIntent.status !== 'succeeded') {
          throw new Error(`Stripe SetupIntent status: ${setupIntent?.status || 'unknown'}`);
        }

        // 3. Store payment_method_id on bank_account
        setStripeStep('Saving payment method…');
        const confirmRes = await fetch('/api/stripe/confirm-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            setup_intent_id: setupIntent.id,
            bank_account_id: bankAccountId,
          }),
        });
        const confirmData = await confirmRes.json();
        if (!confirmRes.ok) throw new Error(confirmData.error || 'Failed to save payment method');
      }

      setStep('done');
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bank linking failed');
      setStep('error');
    } finally {
      setLoading(false);
      setStripeStep('');
    }
  }, [isCA, onSuccess]);

  // ─── Plaid Link hook ──────────────────────────────────────────────────────
  const { open: openPlaid, ready: plaidReady } = usePlaidLink({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlePlaidSuccess(publicToken, metadata as any);
    },
    onExit: () => {
      if (step === 'plaid') {
        setStep('idle');
        setLinkToken(null);
      }
    },
  });

  // Auto-open Plaid Link once token is ready
  if (linkToken && plaidReady && step === 'plaid') {
    openPlaid();
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  // Only 'available' renders a way to start linking. The other three are
  // distinguished by what they SAY, not by what they permit.
  if (linkingAllowed === 'pending') {
    return (
      <span className="text-xs text-gray-400" aria-busy="true">
        Checking availability…
      </span>
    );
  }

  if (linkingAllowed === 'withheld') {
    return (
      <span className="text-xs text-gray-500">
        Bank linking unavailable in this beta
      </span>
    );
  }

  if (linkingAllowed === 'unknown') {
    // Still fails closed — no link control — but it does not claim a beta
    // restriction it has not established, and it offers a way out.
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Couldn&apos;t check availability</span>
        <button
          onClick={() => { setLinkingAllowed('pending'); setProfileAttempt(n => n + 1); }}
          className="text-xs text-blue-700 font-semibold hover:text-blue-800 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <span className="text-xs text-green-700 font-semibold">✓ Bank linked</span>
    );
  }

  if (step === 'stripe') {
    return (
      <span className="text-xs text-blue-700 font-semibold animate-pulse">
        {stripeStep || 'Authorizing…'}
      </span>
    );
  }

  if (step === 'error') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-blue-600">{error}</span>
        <button
          onClick={() => { setStep('idle'); setError(null); setLinkToken(null); }}
          className="text-xs text-blue-700 font-semibold hover:text-blue-800 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={fetchLinkToken}
      disabled={loading || step === 'plaid'}
      className="text-xs text-blue-700 font-semibold hover:text-blue-800 disabled:opacity-50"
    >
      {loading ? 'Loading…' : '+ Link Account'}
    </button>
  );
}
