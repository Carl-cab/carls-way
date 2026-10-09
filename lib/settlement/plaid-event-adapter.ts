import type { SettlementEventType } from './types';

/**
 * Plaid Transfer statuses, from the Transfer API.
 *
 * `posted` means the debit or credit was submitted to the ACH network. It is
 * not a terminal success. This pipeline's own event name `posted` means
 * "funds moved", so mapping Plaid's `posted` onto that name would settle a
 * transfer that is still in flight. In-flight Plaid states stay `pending`,
 * which does not move an intent that is already `processing`.
 *
 * `funds_available` is the terminal success for an ACH debit (add money):
 * Plaid has released the funds. `settled` is the terminal success for an ACH
 * credit, and it is also the status the STATUS_UPDATE contract uses for a
 * completed transfer. Both map to `settled`.
 *
 * Unknown values are not guessed. A default of `submitted` would advance an
 * intent on a status this code does not understand.
 */
const PLAID_TRANSFER_STATUS_MAP: Record<string, SettlementEventType> = {
  pending: 'pending',
  posted: 'pending',
  settled: 'settled',
  funds_available: 'settled',
  failed: 'failed',
  returned: 'returned',
  cancelled: 'cancelled',
};

/**
 * Map a Plaid transfer status onto a settlement event.
 *
 * Returns null when the status is missing or not one of the statuses above.
 */
export function mapPlaidTransferStatus(
  status: string | undefined | null,
): SettlementEventType | null {
  if (!status) return null;
  return PLAID_TRANSFER_STATUS_MAP[status] ?? null;
}
