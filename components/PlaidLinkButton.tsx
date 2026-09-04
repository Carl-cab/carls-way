'use client';
import { useState, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { loadStripe } from '@stripe/stripe-js';

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

  const isCA = userCountry === 'CA';

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
