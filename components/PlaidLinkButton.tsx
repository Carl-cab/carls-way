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
   *   'pending'  the profile has not answered yet
   *   true       the profile said bank_linking is available
   *   false      the profile said it is withheld, OR the request failed, OR
   *              it answered something this component cannot read
   *
   * FAIL CLOSED. An earlier revision used `boolean | null` and only disabled
   * the control on an explicit `false`, so an unknown answer — a non-ok
   * response, a network failure, a body without the field — left the "+ Link
   * Account" button live. That is the wrong default twice over: the user is
   * offered an action the server will refuse with 403, and an operator
   * glancing at the page sees a beta that looks unrestricted. Treating
   * unknown as withheld costs a disabled button during an outage and cannot
   * misrepresent the restriction.
   */
  const [linkingAllowed, setLinkingAllowed] = useState<'pending' | boolean>('pending');

  const isCA = userCountry === 'CA';

  // The interface reads the SAME resolver the route enforces with, so the
  // button state and the refusal cannot disagree. This is presentation only --
  // the control is the 403 in the route, and removing this effect changes
  // nothing about what the API permits. Which is also why failing closed here
  // is safe: it can only ever be MORE restrictive than the server.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/beta-profile')
      .then(r => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        if (cancelled) return;
        // The shared fail-closed resolver, not an inline check: a null body,
        // a missing capabilities object, a missing key or a non-boolean all
        // resolve to WITHHELD. Pinned in lib/__tests__/beta-containment.test.ts.
        setLinkingAllowed(clientCapabilityAvailable(d, 'bank_linking'));
      })
      .catch(() => {
        // A failed request is NOT "unknown, carry on" — it is withheld.
        if (!cancelled) setLinkingAllowed(false);
      });
    return () => { cancelled = true; };
  }, []);

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
  // Anything but an explicit `true` renders no usable control. `pending` and
  // `false` are shown differently — a user mid-page-load should not be told
  // the feature is unavailable in the beta when the answer has not arrived —
  // but NEITHER offers a way to start linking.
  if (linkingAllowed === 'pending') {
    return (
      <span className="text-xs text-gray-400" aria-busy="true">
        Checking availability…
      </span>
    );
  }

  if (!linkingAllowed) {
    return (
      <span className="text-xs text-gray-500">
        Bank linking unavailable in this beta
      </span>
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
