// Plaid Transfer provider — US live ACH debit/credit.
// Implements the full TransferProvider interface using Plaid's Transfer API.
//
// Flow:
//   createIntent   → stores draft in transfer_intents (no Plaid call)
//   reviewTransfer → returns review details + consent language (no Plaid call)
//   confirmTransfer→ records consent_confirmed_at, sets status='ready' (no Plaid call)
//   executeTransfer→ calls Plaid transferAuthorizationCreate + transferCreate,
//                    stores provider_reference_id, sets status='processing'
//   cancelTransfer → calls Plaid transferCancel (if still pending), sets status='cancelled'
//   getTransferStatus → queries DB (source of truth)
//   handleWebhookEvent → no-op; TRANSFER.STATUS_UPDATE handled in webhook route
//
// CRITICAL: This provider NEVER updates balances.
// All balance changes happen only after settlement via SettlementOrchestrator/Executor.

import { plaidClient, requireEncryptedBankToken } from '@/lib/plaid';
import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';
import {
  TransferType as PlaidTransferType,
  TransferNetwork,
  ACHClass,
} from 'plaid';
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

/**
 * Fetch the Plaid account_id for a given bank_account row.
 * The account_id is stored in bank_accounts.plaid_account_id (added in migration).
 * Falls back to fetching from Plaid authGet if the column is null (legacy rows).
 */
async function getPlaidAccountId(
  bankAccountId: number,
  accessToken: string
): Promise<string> {
  const sql = getSql();
  const rows = await sql`
    SELECT plaid_account_id, account_mask FROM bank_accounts WHERE id = ${bankAccountId}
  `;
  if (!rows[0]) throw new Error('Bank account not found');

  const stored = (rows[0] as { plaid_account_id: string | null; account_mask: string | null }).plaid_account_id;
  if (stored) return stored;

  // Legacy row: fetch from Plaid and backfill
  const authResp = await plaidClient.authGet({ access_token: accessToken });
  const accounts = authResp.data.accounts;
  if (!accounts.length) throw new Error('No accounts returned from Plaid authGet');

  const mask = (rows[0] as { account_mask: string | null }).account_mask;
  const matched = mask
    ? accounts.find((a) => a.mask === mask) ?? accounts[0]
    : accounts[0];

  const plaidAccountId = matched.account_id;

  // Backfill for future calls
  await sql`
    UPDATE bank_accounts SET plaid_account_id = ${plaidAccountId}
    WHERE id = ${bankAccountId}
  `;

  return plaidAccountId;
}

function toPlaidTransferType(type: TransferType): PlaidTransferType {
  return type === 'add_money' ? PlaidTransferType.Debit : PlaidTransferType.Credit;
}

function settlementEstimate(type: TransferType): string {
  return type === 'add_money'
    ? 'Funds typically available in 1–3 business days (ACH standard)'
    : 'Deposit typically arrives in 1–3 business days (ACH standard)';
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class PlaidTransferProvider implements TransferProvider {
  readonly providerName = 'plaid_transfer' as const;
  readonly providerRegion = 'US' as const;
  readonly executionMode = 'live' as const;

  async createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult> {
    const sql = getSql();
    const idempotencyKey = `plaid_${userId}_${Date.now()}`;

    const result = await sql`
      INSERT INTO transfer_intents (
        user_id, bank_account_id, type, amount, currency, status,
        provider_region, provider_name, execution_mode, idempotency_key
      ) VALUES (
        ${userId}, ${bankAccountId}, ${type}, ${amount}, ${currency}, 'draft',
        'US', 'plaid_transfer', 'live', ${idempotencyKey}
      )
      RETURNING id
    `;
    const intentId = result[0].id as number;

    await auditLog(userId, 'transfer_intent_created', {
      intent_id: intentId, type, amount, currency,
      provider: 'plaid_transfer', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'draft',
      provider_name: 'plaid_transfer',
      provider_region: 'US',
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

    const consentLanguage =
      row.type === 'add_money'
        ? `By confirming, you authorize Manna to initiate an ACH debit from your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. Funds are typically available in 1–3 business days. You may cancel before the transfer is submitted.`
        : `By confirming, you authorize Manna to initiate an ACH credit to your ${row.institution_name} account ending in ${row.account_mask || 'XXXX'} for ${row.currency} ${Number(row.amount).toFixed(2)}. Funds are typically available in 1–3 business days.`;

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
        provider_name: 'plaid_transfer',
        provider_region: 'US',
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
      intent_id: intentId, provider: 'plaid_transfer', mode: 'live',
    });

    return {
      intent_id: intentId,
      status: 'ready',
      message: 'ACH transfer confirmed. Ready to execute.',
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

    const accessToken = await requireEncryptedBankToken(userId, intent.bank_account_id as number);
    const plaidAccountId = await getPlaidAccountId(intent.bank_account_id as number, accessToken);
    const plaidType = toPlaidTransferType(intent.type as TransferType);
    const amountStr = Number(intent.amount).toFixed(2);
    const description = intent.type === 'add_money' ? 'Manna Add' : 'Manna Pay';

    // Step 1: Create authorization
    const authResp = await plaidClient.transferAuthorizationCreate({
      access_token: accessToken,
      account_id: plaidAccountId,
      type: plaidType,
      network: TransferNetwork.Ach,
      amount: amountStr,
      ach_class: ACHClass.Ppd,
      user: { legal_name: 'Manna User' },
    });

    const authorization = authResp.data.authorization;
    if (authorization.decision !== 'approved') {
      const reason =
        authorization.decision_rationale?.description ?? authorization.decision;
      await sql`
        UPDATE transfer_intents
        SET status = 'failed', failure_reason = ${reason}, updated_at = NOW()
        WHERE id = ${intentId}
      `;
      await auditLog(userId, 'transfer_authorization_declined', {
        intent_id: intentId, reason, decision: authorization.decision,
      });
      throw new Error(`Plaid transfer authorization declined: ${reason}`);
    }

    // Step 2: Create the transfer
    const transferResp = await plaidClient.transferCreate({
      access_token: accessToken,
      account_id: plaidAccountId,
      authorization_id: authorization.id,
      description,
    });

    const plaidTransferId = transferResp.data.transfer.id;

    await sql`
      UPDATE transfer_intents
      SET status = 'processing',
          provider_reference_id = ${plaidTransferId},
          updated_at = NOW()
      WHERE id = ${intentId}
    `;

    await auditLog(userId, 'transfer_submitted', {
      intent_id: intentId,
      provider: 'plaid_transfer',
      plaid_transfer_id: plaidTransferId,
      amount: amountStr,
      type: intent.type,
    });

    // Return never — transfer is now async; status updates arrive via TRANSFER.STATUS_UPDATE webhook
    throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
      __submitted: true,
      plaid_transfer_id: plaidTransferId,
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

    if (provider_reference_id && status === 'processing') {
      try {
        await plaidClient.transferCancel({
          transfer_id: provider_reference_id as string,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Transfer cannot be cancelled — it may already be posted or settled. Contact support. (${msg})`
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
      provider: 'plaid_transfer',
      previous_status: status,
      plaid_transfer_id: provider_reference_id ?? null,
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
    // TRANSFER.STATUS_UPDATE events are handled in app/api/webhooks/plaid/route.ts
    // via the SettlementOrchestrator/Executor pipeline.
    return { processed: false, message: 'PlaidTransferProvider: webhook handled by route handler' };
  }
}
