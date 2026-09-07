import { getSql } from '@/lib/db';
import type { SettlementPlan } from './SettlementOrchestrator';

/**
 * Apply a settlement plan's financial effects, exactly once per business
 * outcome.
 *
 * ## Why this exists
 *
 * Idempotency used to be keyed on `provider_event_id`: the unique constraint on
 * `provider_webhook_events`, and the ledger's
 * UNIQUE(transfer_intent_id, provider_event_id, entry_type). That protects
 * against a redelivery of the *same* event and nothing else. Stripe can emit two
 * distinct event ids describing the same PaymentIntent reaching the same
 * outcome, and each carries a different `provider_event_id`, so every
 * event-keyed guard lets the second one through.
 *
 * Measured before this module existed: two distinct `payment_intent.succeeded`
 * events for one PaymentIntent credited the wallet twice (25 → 50) and wrote two
 * ledger entries. That is a double settlement of real money.
 *
 * ## What replaces it
 *
 * The intent's own status transition is the idempotency key. A conditional
 * update claims the outcome:
 *
 *     UPDATE transfer_intents SET status = <next>
 *      WHERE id = <id> AND status = <expected>
 *
 * Exactly one caller can move an intent out of a given status, because the row
 * lock serialises them and the `WHERE` clause fails for everyone after the
 * first. The claim is therefore the decision point: win it and you own the
 * financial effects, lose it and there is nothing left to apply. This holds
 * regardless of how many distinct provider events describe the same outcome.
 *
 * Everything runs in one transaction — claim, ledger, balance — so a crash
 * midway cannot leave a settled intent with no ledger entry, or a credited
 * wallet with no ledger entry to explain it.
 */

export interface ApplySettlementResult {
  /** True when this call won the claim and applied the effects. */
  applied: boolean;
  /** Why nothing was applied, when applied is false. */
  reason?: 'already_applied' | 'no_side_effects' | 'intent_missing';
  ledgerEntriesCreated: number;
  balanceChanged: boolean;
}

function mapEntryType(planType: string, nextStatus: string): string {
  if (nextStatus === 'settled') {
    return planType === 'transfer_settlement' ? 'add_money_settled' : 'cash_out_settled';
  }
  if (nextStatus === 'returned') return 'transfer_returned';
  if (nextStatus === 'failed') return 'transfer_failed';
  return planType;
}

export async function applySettlementAtomically(
  plan: SettlementPlan,
): Promise<ApplySettlementResult> {
  const sql = getSql();

  // A plan that changes nothing has no outcome to claim. A repeat `pending`
  // against an intent already in `processing` is the ordinary case.
  if (plan.previousStatus === plan.nextStatus) {
    return { applied: false, reason: 'no_side_effects', ledgerEntriesCreated: 0, balanceChanged: false };
  }

  return sql.begin(async (tx) => {
    // Claim. `FOR UPDATE` first so concurrent callers serialise on the row
    // rather than racing between the read and the write.
    const locked = await tx<{ id: string; user_id: number; status: string; provider_reference_id: string | null }[]>`
      SELECT id, user_id, status, provider_reference_id
      FROM transfer_intents
      WHERE id = ${plan.intentId}
      FOR UPDATE
    `;

    if (!locked[0]) {
      return { applied: false, reason: 'intent_missing' as const, ledgerEntriesCreated: 0, balanceChanged: false };
    }

    // The status must still be what the plan was built against. If another
    // event already moved it, that caller owns the outcome and this one must
    // not re-apply the money.
    if (locked[0].status !== plan.previousStatus) {
      return { applied: false, reason: 'already_applied' as const, ledgerEntriesCreated: 0, balanceChanged: false };
    }

    const intent = locked[0];

    await tx`
      UPDATE transfer_intents
      SET status = ${plan.nextStatus}, updated_at = NOW()
      WHERE id = ${plan.intentId} AND status = ${plan.previousStatus}
    `;

    let ledgerEntriesCreated = 0;
    if (plan.createLedgerEntries.shouldCreate && plan.createLedgerEntries.entries?.length) {
      for (const entry of plan.createLedgerEntries.entries) {
        // The event-scoped constraint is kept as a second line of defence
        // against a same-event redelivery that somehow reaches here; the claim
        // above is what stops distinct events double-writing.
        await tx`
          INSERT INTO ledger_entries (
            user_id, transfer_intent_id, currency, account_type, entry_type,
            debit, credit, provider, provider_reference, provider_event_id, description
          ) VALUES (
            ${intent.user_id}, ${intent.id}, ${entry.currency}, 'wallet',
            ${mapEntryType(entry.entryType, plan.nextStatus)},
            ${entry.debit}, ${entry.credit}, ${plan.provider},
            ${intent.provider_reference_id}, ${plan.provider_event_id}, ${entry.description}
          )
          ON CONFLICT (transfer_intent_id, provider_event_id, entry_type) DO NOTHING
        `;
        ledgerEntriesCreated += 1;
      }
    }

    let balanceChanged = false;
    if (plan.updateBalance.shouldUpdate && plan.updateBalance.amount && plan.updateBalance.currency) {
      const column = plan.updateBalance.currency === 'USD' ? 'balance_usd' : 'balance_cad';
      const delta =
        plan.updateBalance.operation === 'subtract'
          ? -Math.abs(plan.updateBalance.amount)
          : Math.abs(plan.updateBalance.amount);

      // Column name cannot be parameterised, so it is chosen from a closed set
      // above rather than interpolated from input.
      if (column === 'balance_usd') {
        await tx`UPDATE users SET balance_usd = balance_usd + ${delta} WHERE id = ${intent.user_id}`;
      } else {
        await tx`UPDATE users SET balance_cad = balance_cad + ${delta} WHERE id = ${intent.user_id}`;
      }
      balanceChanged = true;
    }

    return { applied: true, ledgerEntriesCreated, balanceChanged };
  }) as unknown as ApplySettlementResult;
}
