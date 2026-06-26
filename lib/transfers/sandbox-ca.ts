// Canadian sandbox transfer provider.
// Simulates Canadian EFT (Electronic Funds Transfer) without making any real API calls.
// No money moves. No balance changes. No external API calls.
// Replace with CanadianEFTProvider when live CA EFT is ready.
// NOTE: Plaid Transfer (ACH) is US-only. Canadian users must use this provider.

import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import type {
  TransferProvider, TransferType, CreateIntentResult,
  ReviewResult, ConfirmResult, WebhookResult,
} from './types';

export class SandboxCAProvider implements TransferProvider {
  readonly providerName = 'sandbox_ca' as const;
  readonly providerRegion = 'CA' as const;
  readonly executionMode = 'sandbox' as const;

  async createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult> {
    const sql = getSql();
    const idempotencyKey = `ca_${userId}_${Date.now()}`;

    const result = await sql`
      INSERT INTO transfer_intents (
        user_id, bank_account_id, type, amount, currency, status,
        provider_region, provider_name, execution_mode, idempotency_key
      ) VALUES (
        ${userId}, ${bankAccountId}, ${type}, ${amount}, ${currency}, 'draft',
        'CA', 'sandbox_ca', 'sandbox', ${idempotencyKey}
      )
      RETURNING id
    `;

    const intentId = result[0].id as number;
    await auditLog(userId, 'transfer_intent_created', {
      intent_id: intentId, type, amount, currency,
      provider: 'sandbox_ca', mode: 'sandbox',
    });

    return { intent_id: intentId, status: 'draft', provider_name: 'sandbox_ca', provider_region: 'CA', execution_mode: 'sandbox' };
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
      ? `By confirming, you authorize Manna to initiate a Canadian EFT debit from your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. This is a sandbox simulation — no money will move.`
      : `By confirming, you authorize Manna to initiate a Canadian EFT credit to your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. This is a sandbox simulation — no money will move.`;

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
        provider_name: 'sandbox_ca',
        provider_region: 'CA',
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
      intent_id: intentId, provider: 'sandbox_ca', mode: 'sandbox',
    });

    return {
      intent_id: intentId,
      status: 'ready',
      message: 'Canadian transfer simulation confirmed. No money moved — sandbox mode.',
    };
  }

  async executeTransfer(): Promise<never> {
    throw new Error('SandboxCAProvider does not support live execution. Switch to CanadianEFTProvider for real transfers.');
  }

  async handleWebhookEvent(): Promise<WebhookResult> {
    return { processed: false, message: 'Sandbox provider does not process webhooks' };
  }
}
