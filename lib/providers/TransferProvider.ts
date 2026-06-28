// TransferProvider interface — every banking provider must implement these methods.
// Sandbox providers implement all methods but make no real API calls.
// Live providers implement all methods and call real payment rail APIs.
// No provider may update balances directly — all balance changes happen via settlement webhooks.

export type TransferType = 'add_money' | 'cash_out';
export type TransferStatus = 'draft' | 'reviewed' | 'ready' | 'processing' | 'settled' | 'failed' | 'returned' | 'cancelled' | 'blocked';
export type ExecutionMode = 'sandbox' | 'live';
export type ProviderRegion = 'US' | 'CA';
export type ProviderName = 'sandbox_us' | 'sandbox_ca' | 'plaid_transfer' | 'canadian_eft';

export interface TransferIntent {
  id: number;
  user_id: number;
  type: TransferType;
  amount: number;
  currency: string;
  status: TransferStatus;
  provider_region: ProviderRegion;
  provider_name: ProviderName;
  execution_mode: ExecutionMode;
  provider_reference_id: string | null;
  failure_reason: string | null;
  bank_account_id: number | null;
  consent_confirmed_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface BankAccountSummary {
  id: number;
  institution_name: string;
  account_name: string;
  account_mask: string | null;
  currency: string;
}

export interface ReviewDetails {
  amount: number;
  currency: string;
  type: TransferType;
  bank_account: BankAccountSummary;
  provider_name: ProviderName;
  provider_region: ProviderRegion;
  execution_mode: ExecutionMode;
  settlement_estimate: string;
  consent_language: string;
}

export interface CreateIntentResult {
  intent_id: number;
  status: TransferStatus;
  provider_name: ProviderName;
  provider_region: ProviderRegion;
  execution_mode: ExecutionMode;
}

export interface ReviewResult {
  intent_id: number;
  status: TransferStatus;
  review: ReviewDetails;
}

export interface ConfirmResult {
  intent_id: number;
  status: TransferStatus;
  message: string;
}

export interface CancelResult {
  intent_id: number;
  status: TransferStatus;
  message: string;
}

export interface TransferStatusResult {
  intent_id: number;
  status: TransferStatus;
  provider_reference_id: string | null;
  failure_reason: string | null;
  updated_at: string;
}

export interface WebhookResult {
  processed: boolean;
  event_type?: string;
  message?: string;
}

// The interface every provider must implement.
// Sandbox providers implement all methods but make no real API calls.
// Live providers implement all methods and call the real payment rail.
// CRITICAL: No provider may update balances. All balance changes happen via settlement webhooks only.
export interface TransferProvider {
  readonly providerName: ProviderName;
  readonly providerRegion: ProviderRegion;
  readonly executionMode: ExecutionMode;

  // Step 1: Create a draft intent — no external call, no balance change.
  createIntent(
    userId: number,
    bankAccountId: number,
    type: TransferType,
    amount: number,
    currency: string,
  ): Promise<CreateIntentResult>;

  // Step 2: Return review details so the user can confirm before committing.
  // No external call, no balance change.
  reviewTransfer(intentId: number, userId: number): Promise<ReviewResult>;

  // Step 3: User confirmed consent. Mark intent ready.
  // No external call, no balance change. Records consent_confirmed_at.
  confirmTransfer(intentId: number, userId: number): Promise<ConfirmResult>;

  // Step 4 (live only): Execute the real transfer.
  // Sandbox providers throw if this is called to prevent accidental live calls.
  // Live providers submit to payment rail and set status='processing'.
  executeTransfer(intentId: number, userId: number): Promise<never>;

  // Cancel a transfer in draft or ready state (not processing or later).
  // No external call, no balance change.
  cancelTransfer(intentId: number, userId: number): Promise<CancelResult>;

  // Get current transfer status from database (or provider if live).
  // No balance changes. Read-only.
  getTransferStatus(intentId: number, userId: number): Promise<TransferStatusResult>;

  // Webhook handler — called by POST /api/webhooks/<provider>.
  // Sandbox providers are no-ops; live providers update status based on provider response.
  // Balance updates happen ONLY after successful settlement via separate webhook handler.
  handleWebhookEvent(rawPayload: unknown): Promise<WebhookResult>;
}
