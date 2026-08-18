// Shared sandbox settlement logic for SandboxUSProvider and SandboxCAProvider.
//
// In sandbox mode there is no real ACH/EFT rail, but for the platform to be
// usable end-to-end (link bank -> add money -> send) a confirmed sandbox
// transfer must actually move the user's platform balance and leave an
// auditable ledger entry. This helper performs that settlement atomically.
//
// This is the ONLY transfer path permitted to mutate a balance, and only while
// execution_mode = 'sandbox'. When live PlaidTransferProvider / CanadianEFTProvider
// are introduced, balance movement flows through the settlement engine instead
// and this helper is not used.

import { getSql } from '@/lib/db';
import { auditLog } from '@/lib/auth';

export interface SandboxSettlementResult {
  intent_id: number;
  status: 'settled';
  new_balance: number;
  message: string;
}

/**
 * Atomically settle a confirmed sandbox transfer:
 *  - add_money  -> credit the user's platform balance (funds "pulled" from bank)
 *  - cash_out   -> debit the user's platform balance (funds "pushed" to bank)
 * Writes a ledger entry and advances the intent to 'settled'. Idempotent: an
 * intent already in a terminal state is not settled twice.
 */
export async function settleSandboxTransfer(
  intentId: number,
  userId: number,
  providerName: 'sandbox_us' | 'sandbox_ca',
): Promise<SandboxSettlementResult> {
  const sql = getSql();
  const providerReference = `sbx_${providerName}_${intentId}`;

  const newBalance = await sql.begin(async (tx) => {
    // Lock the intent row; re-read type/amount/currency/status inside the tx.
    const intentRows = await tx`
      SELECT type, amount, currency, status
      FROM transfer_intents
      WHERE id = ${intentId} AND user_id = ${userId}
      FOR UPDATE
    `;
    if (!intentRows[0]) throw new Error('Transfer intent not found');

    const intent = intentRows[0] as {
      type: string; amount: number; currency: string; status: string;
    };

    // Only a confirmed ('ready') intent may settle. Anything else is a no-op
    // guard against double-settlement or out-of-order calls.
    if (intent.status !== 'ready') {
      throw new Error(`Cannot settle intent in status: ${intent.status}`);
    }

    const amount = Number(intent.amount);
    const currency = intent.currency;
    const isUsd = currency === 'USD';

    let balanceRows;
    if (intent.type === 'add_money') {
      balanceRows = isUsd
        ? await tx`UPDATE users SET balance_usd = balance_usd + ${amount}
                   WHERE id = ${userId} RETURNING balance_usd AS bal`
        : await tx`UPDATE users SET balance_cad = balance_cad + ${amount}
                   WHERE id = ${userId} RETURNING balance_cad AS bal`;
    } else {
      // cash_out — guard against overdraw
      balanceRows = isUsd
        ? await tx`UPDATE users SET balance_usd = balance_usd - ${amount}
                   WHERE id = ${userId} AND balance_usd >= ${amount} RETURNING balance_usd AS bal`
        : await tx`UPDATE users SET balance_cad = balance_cad - ${amount}
                   WHERE id = ${userId} AND balance_cad >= ${amount} RETURNING balance_cad AS bal`;
      if (balanceRows.length === 0) {
        throw new Error('INSUFFICIENT_BALANCE');
      }
    }

    const debit = intent.type === 'cash_out' ? amount : 0;
    const credit = intent.type === 'add_money' ? amount : 0;
    const description = intent.type === 'add_money'
      ? `Added ${amount.toFixed(2)} ${currency} from linked bank (sandbox)`
      : `Cashed out ${amount.toFixed(2)} ${currency} to linked bank (sandbox)`;

    // Ledger entry — UNIQUE(transfer_intent_id, provider_event_id, entry_type)
    // makes this insert idempotent for a given intent.
    await tx`
      INSERT INTO ledger_entries (
        user_id, transfer_intent_id, currency, account_type, entry_type,
        debit, credit, provider, provider_reference, provider_event_id, description
      ) VALUES (
        ${userId}, ${intentId}, ${currency}, 'wallet', ${intent.type},
        ${debit}, ${credit}, ${providerName}, ${providerReference}, ${providerReference}, ${description}
      )
      ON CONFLICT (transfer_intent_id, provider_event_id, entry_type) DO NOTHING
    `;

    await tx`
      UPDATE transfer_intents
      SET status = 'settled', provider_reference_id = ${providerReference}, updated_at = NOW()
      WHERE id = ${intentId} AND user_id = ${userId}
    `;

    return Number(balanceRows[0].bal);
  }) as unknown as number;

  await auditLog(userId, 'transfer_settled', {
    intent_id: intentId, provider: providerName, mode: 'sandbox',
    provider_reference: providerReference,
  });

  return {
    intent_id: intentId,
    status: 'settled',
    new_balance: newBalance,
    message: 'Transfer settled (sandbox). Your Manna balance has been updated.',
  };
}
