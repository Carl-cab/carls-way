/**
 * Shared types and interfaces for the repository layer.
 *
 * These types define the contract between repositories and services,
 * ensuring type safety across data access operations.
 */

/**
 * Pagination metadata for query results.
 */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/**
 * Paginated result set.
 */
export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

/**
 * Query filter options.
 */
export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'ASC' | 'DESC';
}

/**
 * User domain model.
 */
export interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  password_hash: string;
  balance_cad: number;
  balance_usd: number;
  country: 'CA' | 'US';
  province?: string;
  phone?: string;
  avatar_color?: string;
  kyc_status: 'pending' | 'verified' | 'rejected';
  kyc_provider?: string;
  kyc_session_id?: string;
  kyc_verified_at?: string;
  kyc_rejection_reason?: string;
  failed_login_attempts: number;
  locked_until?: string;
  last_login_at?: string;
  created_at: string;
}

/**
 * Bank account domain model.
 */
export interface BankAccount {
  id: number;
  user_id: number;
  plaid_item_id: string;
  plaid_access_token_enc: string;
  institution_name: string;
  account_name: string;
  account_type: string;
  account_mask: string;
  currency: 'CAD' | 'USD';
  country: 'CA' | 'US';
  is_primary: boolean;
  is_verified: boolean;
  is_active: boolean;
  is_token_encrypted: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Transaction domain model (P2P payment).
 */
export interface Transaction {
  id: number;
  sender_id: number;
  receiver_id: number;
  amount: number;
  currency: 'CAD' | 'USD';
  sender_currency?: string;
  receiver_currency?: string;
  sender_amount?: number;
  receiver_amount?: number;
  fx_rate?: number;
  fx_fee?: number;
  is_cross_border: boolean;
  payment_rail?: string;
  note?: string;
  type: 'payment' | 'request';
  status: 'completed' | 'pending' | 'declined';
  privacy: 'public' | 'friends' | 'private';
  estimated_settlement?: string;
  created_at: string;
}

/**
 * Transfer intent domain model (bank transfer state machine).
 */
export type TransferStatus =
  | 'draft'
  | 'reviewed'
  | 'ready'
  | 'processing'
  | 'settled'
  | 'failed'
  | 'returned'
  | 'cancelled'
  | 'blocked';

export interface TransferIntent {
  id: number;
  user_id: number;
  bank_account_id: number;
  type: 'add_money' | 'cash_out';
  amount: number;
  currency: 'CAD' | 'USD';
  status: TransferStatus;
  provider_region: 'CA' | 'US';
  provider_name: string;
  execution_mode: 'sandbox' | 'live';
  provider_reference_id?: string;
  failure_reason?: string;
  consent_confirmed_at?: string;
  idempotency_key?: string;
  correlation_id?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Ledger entry domain model (double-entry accounting).
 */
export interface LedgerEntry {
  id: number;
  user_id: number;
  transaction_id?: number;
  transfer_intent_id?: number;
  currency: 'CAD' | 'USD';
  account_type: 'wallet' | 'reserve' | 'fee_collected';
  entry_type:
    | 'opening_balance'
    | 'payment'
    | 'payment_sent'
    | 'payment_received'
    | 'fee'
    | 'settlement'
    | 'reversal';
  debit: number;
  credit: number;
  provider?: string;
  provider_reference?: string;
  provider_event_id?: string;
  description?: string;
  correlation_id?: string;
  created_at: string;
}

/**
 * Ledger balance calculation.
 */
export interface LedgerBalance {
  user_id: number;
  currency: 'CAD' | 'USD';
  total_debits: number;
  total_credits: number;
  balance: number; // credits - debits
}

/**
 * Provider webhook event domain model.
 */
export interface ProviderWebhookEvent {
  id: number;
  provider: string;
  provider_event_id: string;
  event_type: string;
  related_provider_reference?: string;
  raw_payload: Record<string, unknown>;
  processing_status: 'received' | 'processing' | 'processed' | 'failed';
  processing_error?: string;
  processed_at?: string;
  balance_processed_at?: string;
  balance_processing_error?: string;
  correlation_id?: string;
  created_at: string;
}

/**
 * Notification domain model.
 */
export interface Notification {
  id: number;
  user_id: number;
  type: string;
  title: string;
  message: string;
  related_entity_type?: string;
  related_entity_id?: string;
  read_at?: string;
  created_at: string;
}

/**
 * Audit log domain model.
 */
export interface AuditLog {
  id: number;
  user_id?: number;
  admin_id?: number;
  action: string;
  entity_type?: string;
  entity_id?: string | number;
  metadata?: Record<string, unknown>;
  source_ip?: string;
  user_agent?: string;
  correlation_id?: string;
  created_at: string;
}

/**
 * Friend relationship domain model.
 */
export interface Friend {
  id: number;
  user_id: number;
  friend_id: number;
  status: 'pending' | 'accepted' | 'declined' | 'blocked';
  requested_by: number;
  created_at: string;
  updated_at: string;
}

/**
 * Input types for repository creation methods.
 */

export interface CreateUserInput {
  name: string;
  username: string;
  email: string;
  password_hash: string;
  country: 'CA' | 'US';
  province?: string;
  phone?: string;
  balance_cad?: number;
  balance_usd?: number;
}

export interface CreateTransactionInput {
  sender_id: number;
  receiver_id: number;
  amount: number;
  currency: 'CAD' | 'USD';
  type: 'payment' | 'request';
  privacy: 'public' | 'friends' | 'private';
  note?: string;
}

export interface CreateTransferIntentInput {
  user_id: number;
  bank_account_id: number;
  type: 'add_money' | 'cash_out';
  amount: number;
  currency: 'CAD' | 'USD';
  provider_region: 'CA' | 'US';
  provider_name: string;
  execution_mode: 'sandbox' | 'live';
  idempotency_key?: string;
  correlation_id?: string;
}

export interface CreateLedgerEntryInput {
  user_id: number;
  transaction_id?: number;
  transfer_intent_id?: number;
  currency: 'CAD' | 'USD';
  account_type: 'wallet' | 'reserve' | 'fee_collected';
  entry_type:
    | 'opening_balance'
    | 'payment'
    | 'payment_sent'
    | 'payment_received'
    | 'fee'
    | 'settlement'
    | 'reversal';
  debit: number;
  credit: number;
  provider?: string;
  provider_reference?: string;
  provider_event_id?: string;
  description?: string;
  correlation_id?: string;
}

export interface CreateLedgerPairInput {
  sender_user_id: number;
  receiver_user_id: number;
  transaction_id: number;
  currency: 'CAD' | 'USD';
  amount: number;
  correlation_id?: string;
}

export interface CreateProviderWebhookEventInput {
  provider: string;
  provider_event_id: string;
  event_type: string;
  related_provider_reference?: string;
  raw_payload: Record<string, unknown>;
  correlation_id?: string;
}

export interface CreateNotificationInput {
  user_id: number;
  type: string;
  title: string;
  message: string;
  related_entity_type?: string;
  related_entity_id?: string | number;
}

export interface CreateAuditLogInput {
  user_id?: number;
  admin_id?: number;
  action: string;
  entity_type?: string;
  entity_id?: string | number;
  metadata?: Record<string, unknown>;
  source_ip?: string;
  user_agent?: string;
  correlation_id?: string;
}

/**
 * Repository error types.
 */

export class RepositoryError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export class DuplicateKeyError extends RepositoryError {
  constructor(entity: string, key: string) {
    super('DUPLICATE_KEY', `Duplicate key in ${entity}: ${key}`);
    this.name = 'DuplicateKeyError';
  }
}

export class NotFoundError extends RepositoryError {
  constructor(entity: string, criteria: string) {
    super('NOT_FOUND', `${entity} not found: ${criteria}`);
    this.name = 'NotFoundError';
  }
}

export class TransactionError extends RepositoryError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('TRANSACTION_ERROR', message, details);
    this.name = 'TransactionError';
  }
}
