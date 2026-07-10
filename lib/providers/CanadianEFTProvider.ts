// Canadian EFT provider — CA live EFT via Stripe ACSS Debit.
// Implements the full TransferProvider interface using Stripe's ACSS (Pre-Authorized Debit) API.
//
// Flow:
//   createIntent   → stores draft in transfer_intents (no Stripe call)
//   reviewTransfer → returns review details + PAD mandate language (no Stripe call)
//   confirmTransfer→ records consent_confirmed_at, sets status='ready' (no Stripe call)
//   executeTransfer→ creates Stripe PaymentIntent (add_money) or Payout (cash_out),
//                    stores provider_reference_id, sets status='processing'
//   cancelTransfer → cancels Stripe PaymentIntent if still cancellable
//   getTransferStatus → queries DB (source of truth)
//   handleWebhookEvent → no-op; Stripe events handled in app/api/webhooks/stripe/route.ts
//
// CRITICAL: This provider NEVER updates balances.
// All balance changes happen only after settlement via SettlementOrchestrator/Executor.
//
// Stripe ACSS Debit (PAD) notes:
//   - Add Money: PaymentIntent with payment_method_types=['acss_debit']
//   - Cash Out: Stripe Payout to a connected bank account
//   - Mandate verification is handled by Stripe; user must have completed Stripe setup
//   - Settlement: 2–5 business days for ACSS

import { getStripe } from '@/lib/stripe';
import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import type {
  TransferProvider,
  TransferType,
  CreateIntentResult,
  ReviewResult,
  ConfirmResult,
  CancelResult,
  TransferStatusResult,
  WebhookResult,
} from './TransferProvider';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function settlementEstimate(type: TransferType): string {
  return type === 'add_money'
    ? 'Funds typically available in 2–5 business days (ACSS/PAD)'
    : 'Deposit typically arrives in 2–5 business days (ACSS/PAD)';
}

/**
 * Fetch the Stripe customer ID for the user, creating one if it doesn't exist.
 * Stored in users.stripe_customer_id (added in migration).
 */
async function getOrCreateStripeCustomer(userId: number): Promise<string> {
  const sql = getSql();
  const rows = await sql`
    SELECT stripe_customer_id, email, name FROM users WHERE id = ${userId}
  `;
  if (!rows[0]) throw new Error('User not found');

  const user = rows[0] as { stripe_customer_id: string | null; email: string; name: string };
  if (user.stripe_customer_id) return user.stripe_customer_id;

  // Create Stripe customer
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { manna_user_id: String(userId) },
  });

  await sql`
    UPDATE users SET stripe_customer_id = ${customer.id} WHERE id = ${userId}
  `;

  return customer.id;
}

/**
 * Fetch the Stripe bank account / payment method ID for a bank_account row.
 * Stored in bank_accounts.stripe_payment_method_id (added in migration).
 */
async function getStripeBankPaymentMethod(bankAccountId: number): Promise<string | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT stripe_payment_method_id FROM bank_accounts WHERE id = ${bankAccountId}
  `;
  if (!rows[0]) throw new Error('Bank account not found');
  return (rows[0] as { stripe_payment_method_id: string | null }).stripe_payment_method_id;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class CanadianEFTProvider implements TransferProvider {
  readonly providerName = 'canadian_eft' as const;
  readonly providerRegion = 'CA' as const;
  readonly executionMode = 'live' as const;

  async createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult> {
    const sql = getSql();
    const idempotencyKey = `ca_eft_${userId}_${Date.now()}`;

    const result = await sql`
      INSERT INTO transfer_intents (
        user_id, bank_account_id, type, amount, currency, status,
        provider_region, provider_name, execution_mode, idempotency_key
      ) VALUES (
        ${userId}, ${bankAccountId}, ${type}, ${amount}, ${currency}, 'draft',
        'CA', 'canadian_eft', 'live', ${idempotencyKey}
      )
      RETURNING id
    `;
    const intentId = result[0].id as number;

    await auditLog(userId, 'transfer_intent_created', {
      intent_id: intentId, type, amount, currency,
      provider: 'canadian_eft', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'draft',
      provider_name: 'canadian_eft',
      provider_region: 'CA',
      execution_mode: 'live',
    };
  }

  async reviewTransfer(intentId: number, userId: number): Promise<ReviewResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT ti.id, ti.type, ti.amount, ti.currency, ti.status, ti.bank_account_id,
             ba.institution_name, ba.account_name, ba.account_mask, ba.currency AS account_currency
      FROM transfer_intents ti
      JOIN bank_accounts ba ON ba.id = ti.bank_account_id
      WHERE ti.id = ${intentId} AND ti.user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const row = rows[0];

    // PAD (Pre-Authorized Debit) mandate language required by Payments Canada
    const consentLanguage =
      row.type === 'add_money'
        ? `By confirming, you authorize Manna to initiate a Canadian Pre-Authorized Debit (PAD) from your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. This authorization is for a one-time personal PAD. You have certain recourse rights if any debit does not comply with this agreement. Funds are typically available in 2–5 business days.`
        : `By confirming, you authorize Manna to initiate a Canadian EFT credit to your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. Funds are typically available in 2–5 business days.`;

    return {
      intent_id: intentId,
      status: row.status as 'draft',
      review: {
        amount: Number(row.amount),
        currency: row.currency,
        type: row.type,
        bank_account: {
          id: row.bank_account_id,
          institution_name: row.institution_name,
          account_name: row.account_name,
          account_mask: row.account_mask,
          currency: row.account_currency,
        },
        provider_name: 'canadian_eft',
        provider_region: 'CA',
        execution_mode: 'live',
        settlement_estimate: settlementEstimate(row.type),
        consent_language: consentLanguage,
      },
    };
  }

  async confirmTransfer(intentId: number, userId: number): Promise<ConfirmResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    if (rows[0].status !== 'draft') {
      throw new Error(`Cannot confirm intent in status: ${rows[0].status}`);
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'ready', consent_confirmed_at = NOW(), updated_at = NOW()
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    await auditLog(userId, 'transfer_intent_confirmed', {
      intent_id: intentId, provider: 'canadian_eft', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'ready',
      message: 'Canadian EFT transfer confirmed. Ready to execute.',
    };
  }

  async executeTransfer(intentId: number, userId: number): Promise<never> {
    const sql = getSql();

    // Lock row to prevent concurrent execution
    const rows = await sql`
      SELECT ti.id, ti.type, ti.amount, ti.currency, ti.status, ti.bank_account_id
      FROM transfer_intents ti
      WHERE ti.id = ${intentId} AND ti.user_id = ${userId}
      FOR UPDATE
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const intent = rows[0];

    if (intent.status !== 'ready') {
      throw new Error(`Cannot execute intent in status: ${intent.status}. Must be 'ready'.`);
    }

    const stripe = getStripe();
    const amountCents = Math.round(Number(intent.amount) * 100);
    let stripeReferenceId: string;

    if (intent.type === 'add_money') {
      // Add Money: Stripe PaymentIntent with ACSS Debit
      const customerId = await getOrCreateStripeCustomer(userId);
      const paymentMethodId = await getStripeBankPaymentMethod(intent.bank_account_id as number);

      if (!paymentMethodId) {
        throw new Error(
          'No Stripe payment method found for this bank account. ' +
          'Please re-link your bank account to enable Canadian EFT transfers.'
        );
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'cad',
        customer: customerId,
        payment_method: paymentMethodId,
        payment_method_types: ['acss_debit'],
        confirm: true,
        mandate_data: {
          customer_acceptance: {
            type: 'online',
            online: {
              ip_address: '0.0.0.0', // Server-side confirmation
              user_agent: 'Manna/1.0',
            },
          },
        },
        metadata: {
          manna_intent_id: String(intentId),
          manna_user_id: String(userId),
          transfer_type: 'add_money',
        },
      });

      stripeReferenceId = paymentIntent.id;

    } else {
      // Cash Out: Stripe Payout to connected bank
      // Note: Payouts require a Stripe Connect account or the platform's bank account.
      // For now we create a payout from the platform's Stripe balance.
      // In production this would be a transfer to a connected account.
      const payout = await stripe.payouts.create({
        amount: amountCents,
        currency: 'cad',
        method: 'standard',
        metadata: {
          manna_intent_id: String(intentId),
          manna_user_id: String(userId),
          transfer_type: 'cash_out',
        },
      });

      stripeReferenceId = payout.id;
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'processing',
          provider_reference_id = ${stripeReferenceId},
          updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_submitted', {
      intent_id: intentId,
      provider: 'canadian_eft',
      stripe_reference_id: stripeReferenceId,
      amount: intent.amount,
      type: intent.type,
    });

    // Return never — transfer is now async; status updates arrive via Stripe webhooks
    throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
      __submitted: true,
      stripe_reference_id: stripeReferenceId,
      intent_id: intentId,
      status: 'processing' as const,
    });
  }

  async cancelTransfer(intentId: number, userId: number): Promise<CancelResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status, provider_reference_id FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const { status, provider_reference_id } = rows[0];

    if (status !== 'draft' && status !== 'ready' && status !== 'processing') {
      throw new Error(`Cannot cancel transfer in status: ${status}`);
    }

    // If a PaymentIntent was created (add_money), attempt to cancel it
    if (provider_reference_id && status === 'processing') {
      const ref = provider_reference_id as string;
      if (ref.startsWith('pi_')) {
        try {
          const stripe = getStripe();
          await stripe.paymentIntents.cancel(ref);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Transfer cannot be cancelled — it may already be processing. Contact support. (${msg})`
          );
        }
      } else if (ref.startsWith('po_')) {
        // Payouts cannot be cancelled via API once created
        throw new Error(
          'Cash-out transfers cannot be cancelled once submitted. Contact support.'
        );
      }
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_intent_cancelled', {
      intent_id: intentId,
      provider: 'canadian_eft',
      previous_status: status,
      stripe_reference_id: provider_reference_id ?? null,
    });

    return {
      intent_id: intentId,
      status: 'cancelled',
      message: `Transfer cancelled (was ${status}).`,
    };
  }

  async getTransferStatus(intentId: number, userId: number): Promise<TransferStatusResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status, provider_reference_id, failure_reason, updated_at
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;
    if (!rows[0]) throw new Error('Transfer intent not found');
    const row = rows[0];
    return {
      intent_id: intentId,
      status: row.status,
      provider_reference_id: row.provider_reference_id,
      failure_reason: row.failure_reason,
      updated_at: row.updated_at,
    };
  }

  async handleWebhookEvent(): Promise<WebhookResult> {
    // Stripe events (payment_intent.succeeded, payout.paid, etc.) are handled
    // in app/api/webhooks/stripe/route.ts via the SettlementOrchestrator/Executor pipeline.
    return { processed: false, message: 'CanadianEFTProvider: webhook handled by Stripe route handler' };
  }
}
