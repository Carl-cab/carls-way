// US sandbox transfer provider.
// Simulates Plaid Transfer (ACH debit/credit) without making any real API calls.
// No money moves. No balance changes. No Plaid API calls.
// Replace with PlaidTransferProvider when live US ACH is ready.

import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import type {
  TransferProvider, TransferType, CreateIntentResult,
  ReviewResult, ConfirmResult, CancelResult, TransferStatusResult, WebhookResult,
} from './TransferProvider';

export class SandboxUSProvider implements TransferProvider {
  readonly providerName = 'sandbox_us' as const;
  readonly providerRegion = 'US' as const;
  readonly executionMode = 'sandbox' as const;

  async createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult> {
    const sql = getSql();
    const idempotencyKey = `us_${userId}_${Date.now()}`;

    const result = await sql`
      INSERT INTO transfer_intents (
        user_id, bank_account_id, type, amount, currency, status,
        provider_region, provider_name, execution_mode, idempotency_key
      ) VALUES (
        ${userId}, ${bankAccountId}, ${type}, ${amount}, ${currency}, 'draft',
        'US', 'sandbox_us', 'sandbox', ${idempotencyKey}
      )
      RETURNING id
    `;

    const intentId = result[0].id as number;
    await auditLog(userId, 'transfer_intent_created', {
      intent_id: intentId, type, amount, currency,
      provider: 'sandbox_us', mode: 'sandbox',
    });

    return { intent_id: intentId, status: 'draft', provider_name: 'sandbox_us', provider_region: 'US', execution_mode: 'sandbox' };
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

    const consentLanguage = row.type === 'add_money'
      ? `By confirming, you authorize Manna to debit your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. This is a sandbox simulation — no money will move.`
      : `By confirming, you authorize Manna to deposit ${row.currency} ${Number(row.amount).toFixed(2)} to your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'}. This is a sandbox simulation — no money will move.`;

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
        provider_name: 'sandbox_us',
        provider_region: 'US',
        execution_mode: 'sandbox',
        settlement_estimate: 'Sandbox — no settlement (simulation only)',
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
    if (rows[0].status !== 'draft') throw new Error(`Cannot confirm intent in status: ${rows[0].status}`);

    await sql`
      UPDATE transfer_intents
      SET status = 'ready', consent_confirmed_at = NOW(), updated_at = NOW()
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    await auditLog(userId, 'transfer_intent_confirmed', {
      intent_id: intentId, provider: 'sandbox_us', mode: 'sandbox',
    });

    return {
      intent_id: intentId,
      status: 'ready',
      message: 'US transfer simulation confirmed. No money moved — sandbox mode.',
    };
  }

  async executeTransfer(): Promise<never> {
    throw new Error('SandboxUSProvider does not support live execution. Switch to PlaidTransferProvider for real transfers.');
  }

  async cancelTransfer(intentId: number, userId: number): Promise<CancelResult> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, status FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    if (!rows[0]) throw new Error('Transfer intent not found');
    const currentStatus = rows[0].status;

    if (currentStatus !== 'draft' && currentStatus !== 'ready') {
      throw new Error(`Cannot cancel transfer in status: ${currentStatus}`);
    }

    await sql`
      UPDATE transfer_intents
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    await auditLog(userId, 'transfer_intent_cancelled', {
      intent_id: intentId, provider: 'sandbox_us', previous_status: currentStatus,
    });

    return {
      intent_id: intentId,
      status: 'cancelled',
      message: `Transfer cancelled (was ${currentStatus}).`,
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
    return { processed: false, message: 'Sandbox provider does not process webhooks' };
  }
}
