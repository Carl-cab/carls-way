# Repository Architecture

## Overview

The repository layer is the permanent data access foundation for Manna's Operations Platform (Release 0.95, Milestone 3). It provides a strongly-typed, consistent interface for all data operations while maintaining clean separation between data access and business logic.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ HTTP/API Routes                                                 │
│ (app/api/...)                                                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌─────────────────────────▼────────────────────────────────────────┐
│ Middleware                                                      │
│ (proxy.ts, correlation-middleware.ts)                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌─────────────────────────▼────────────────────────────────────────┐
│ Services                                                        │
│ - Settlement orchestration                                       │
│ - Financial rules                                                │
│ - Validation                                                     │
│ - Authorization                                                  │
│ - Audit generation                                               │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌─────────────────────────▼────────────────────────────────────────┐
│ Repository Layer (NEW)                                          │
│                                                                 │
│ ┌──────────────────────────────────────────────────────────┐   │
│ │ BaseRepository                                           │   │
│ │ - Error handling (convert DB errors to app errors)      │   │
│ │ - Query execution & validation                          │   │
│ │ - Pagination support                                     │   │
│ │ - Timestamp formatting                                   │   │
│ └──────────────────────────────────────────────────────────┘   │
│                         ▲                                       │
│    ┌────────┬──────────┼──────────┬────────┐                  │
│    │        │          │          │        │                  │
│    ▼        ▼          ▼          ▼        ▼                  │
│  UserRepo LedgerRepo TransferRepo ProviderEventRepo ...      │
│                                                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌─────────────────────────▼────────────────────────────────────────┐
│ Database (Supabase PostgreSQL)                                 │
│ - users                                                         │
│ - transfer_intents                                              │
│ - ledger_entries                                                │
│ - provider_webhook_events                                       │
│ - ... (other tables)                                            │
└──────────────────────────────────────────────────────────────────┘
```

## Key Design Principles

### 1. Single Responsibility

Each repository is responsible for **one aggregate or entity**:

- **UserRepository**: User accounts, profiles, KYC status, authentication state
- **LedgerRepository**: Double-entry accounting, balance calculations, transaction history
- **TransferIntentRepository**: Bank transfer state machine, provider coordination
- **ProviderEventRepository**: Webhook events, idempotency tracking, processing status
- **NotificationRepository**: User notifications (future implementation)
- **AuditLogRepository**: Immutable audit trail (future implementation)

### 2. No Business Logic

Repositories **never contain**:

- Financial calculations (fees, rates, balances)
- Business rules (velocity limits, KYC requirements)
- Validation (format, constraints)
- Authorization decisions (who can do what)
- Provider coordination (calling Plaid, Stripe, etc.)
- Idempotency logic (that's handled by services and unique constraints)

Repositories **only contain**:

- Data reading (SELECT queries)
- Data writing (INSERT, UPDATE, DELETE)
- Transaction management
- Pagination
- Error mapping

### 3. Type Safety

All repositories use strongly-typed interfaces defined in `lib/repositories/types.ts`:

```typescript
// Domain model
interface User {
  id: number;
  name: string;
  email: string;
  kyc_status: 'pending' | 'verified' | 'rejected';
  // ... other fields
}

// Input types for mutations
interface CreateUserInput {
  name: string;
  email: string;
  password_hash: string;
  // ... other fields
}

// Result types for queries
interface PaginatedResult<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; hasMore: boolean };
}
```

### 4. Consistent Error Handling

All repositories inherit error handling from `BaseRepository`, which converts PostgreSQL errors to application-level error types:

```typescript
// PostgreSQL UNIQUE violation → DuplicateKeyError
// PostgreSQL FK violation → TransactionError
// Unknown DB errors → RepositoryError
```

### 5. Correlation ID Propagation

All repositories accept and preserve correlation IDs for request tracing:

```typescript
await transferIntentRepository.create({
  user_id: 123,
  correlation_id: 'corr_abc123...', // From request context
  // ... other fields
});
```

## Core Repositories (Implemented)

### UserRepository

**Responsibilities**: User account management

**Key Methods**:

```typescript
findById(id: number): Promise<User | null>
findByEmail(email: string): Promise<User | null>
findByUsername(username: string): Promise<User | null>
search(query: string): Promise<User[]>
create(input: CreateUserInput): Promise<User>
updateProfile(id: number, updates: Partial<User>): Promise<User>
updateKycStatus(id: number, status: 'pending' | 'verified' | 'rejected'): Promise<User>
updateAuthState(id: number, failedAttempts?: number, lockedUntil?: string): Promise<User>
updateLastLogin(id: number): Promise<User>
updateBalances(id: number, balanceCad?: number, balanceUsd?: number): Promise<User>
```

### LedgerRepository

**Responsibilities**: Double-entry accounting, balance tracking

**Key Methods**:

```typescript
createEntry(input: CreateLedgerEntryInput): Promise<LedgerEntry>
createPair(input: CreateLedgerPairInput): Promise<{ debit: LedgerEntry; credit: LedgerEntry }>
findByUser(userId: number): Promise<LedgerEntry[]>
findByTransaction(transactionId: number): Promise<LedgerEntry[]>
findByTransferIntent(transferIntentId: number): Promise<LedgerEntry[]>
findByProviderEvent(provider: string, eventId: string): Promise<LedgerEntry[]>
getBalance(userId: number, currency: 'CAD' | 'USD'): Promise<LedgerBalance>
getBalances(userId: number): Promise<{ CAD: number; USD: number }>
```

### TransferIntentRepository

**Responsibilities**: Bank transfer state machine

**Key Methods**:

```typescript
findById(id: number): Promise<TransferIntent | null>
findByProviderReference(ref: string): Promise<TransferIntent | null>
findByUser(userId: number): Promise<TransferIntent[]>
findByStatus(status: TransferStatus): Promise<TransferIntent[]>
create(input: CreateTransferIntentInput): Promise<TransferIntent>
updateStatus(id: number, status: TransferStatus): Promise<TransferIntent>
updateProviderReference(id: number, ref: string): Promise<TransferIntent>
confirmConsent(id: number): Promise<TransferIntent>
markFailed(id: number, reason: string): Promise<TransferIntent>
findProcessing(): Promise<TransferIntent[]>
findNeedingReview(): Promise<TransferIntent[]>
```

### ProviderEventRepository

**Responsibilities**: Webhook event tracking, idempotency

**Key Methods**:

```typescript
findById(id: number): Promise<ProviderWebhookEvent | null>
findByProviderEventId(provider: string, eventId: string): Promise<ProviderWebhookEvent | null>
findByProvider(provider: string): Promise<ProviderWebhookEvent[]>
findByEventType(eventType: string): Promise<ProviderWebhookEvent[]>
findByStatus(status: 'received' | 'processing' | 'processed' | 'failed'): Promise<ProviderWebhookEvent[]>
create(input: CreateProviderWebhookEventInput): Promise<ProviderWebhookEvent>
updateStatus(id: number, status: string, error?: string): Promise<ProviderWebhookEvent>
markProcessing(id: number): Promise<ProviderWebhookEvent>
markProcessed(id: number): Promise<ProviderWebhookEvent>
markFailed(id: number, error: string): Promise<ProviderWebhookEvent>
isProcessed(provider: string, eventId: string): Promise<boolean>
```

## Future Repositories (Structure Defined)

The following repositories are structured but not yet implemented:

- **TransactionRepository**: P2P payments
- **NotificationRepository**: User alerts
- **AuditLogRepository**: Immutable audit trail
- **BankAccountRepository**: Linked external accounts
- **FriendRepository**: Social relationships
- **VelocityRepository**: Rate limiting

## Usage Patterns

### Pattern 1: Simple Query

```typescript
import { getUserRepository } from '@/lib/repositories';

const user = await getUserRepository().findByEmail('alice@example.com');
if (!user) {
  throw new NotFoundError('User', 'email');
}
console.log(user.id, user.name);
```

### Pattern 2: Creating Multiple Related Records

```typescript
import { getLedgerRepository, getTransactionRepository } from '@/lib/repositories';

// Create P2P payment
const transaction = await transactionRepository.create({
  sender_id: 1,
  receiver_id: 2,
  amount: 100,
  currency: 'CAD',
});

// Create ledger pair atomically
const { debit, credit } = await ledgerRepository.createPair({
  sender_user_id: 1,
  receiver_user_id: 2,
  transaction_id: transaction.id,
  currency: 'CAD',
  amount: 100,
  correlation_id: context.correlationId,
});
```

### Pattern 3: Handling Duplicate Events (Idempotency)

```typescript
import { getProviderEventRepository } from '@/lib/repositories';

try {
  const event = await providerEventRepository.create({
    provider: 'plaid',
    provider_event_id: webhookId,
    event_type: 'TRANSFER.STATUS_UPDATE',
    raw_payload: payload,
    correlation_id: correlationId,
  });

  // Process event...
} catch (err) {
  if (err instanceof DuplicateKeyError) {
    // Event already processed - return 200 to acknowledge
    return { acknowledged: true, processed: false };
  }
  throw err;
}
```

### Pattern 4: Transaction Flow with Status Tracking

```typescript
import { getTransferIntentRepository } from '@/lib/repositories';

// Create transfer intent
let intent = await transferIntentRepository.create({
  user_id: userId,
  bank_account_id: accountId,
  type: 'add_money',
  amount: 500,
  currency: 'CAD',
  provider_region: 'CA',
  provider_name: 'sandbox_ca',
  execution_mode: 'sandbox',
  correlation_id: correlationId,
});

// User reviews and confirms
intent = await transferIntentRepository.confirmConsent(intent.id);

// Orchestrate settlement (in service layer)
const plan = await settlementOrchestrator.orchestrateSettlement(event, correlationId);

// Execute settlement (in service layer)
const result = await settlementExecutor.executeSettlementPlan(plan);

// Update status based on result
intent = await transferIntentRepository.updateStatus(intent.id, result.newStatus);
```

### Pattern 5: Pagination

```typescript
import { getUserRepository } from '@/lib/repositories';

const result = await getUserRepository().findByUserPaginated(
  userId,
  2, // page
  50 // limit
);

console.log(`Showing ${result.data.length} of ${result.meta.total} items`);
console.log(`Page ${result.meta.page}, has more: ${result.meta.hasMore}`);
```

## Backward Compatibility

**Important**: The repository layer is being introduced **alongside** existing code, not replacing it.

- Existing settlement flows continue unchanged
- Existing ledger posting continues unchanged
- Existing provider behavior continues unchanged
- Existing webhook processing continues unchanged

**Only new administrative functionality uses repositories**:

- Ops dashboard queries
- Recovery operations
- Audit reports
- (Future) RBAC enforcement

This ensures **zero risk** to production financial flows while building the foundation for operational capabilities.

## Performance Considerations

### Indexes

The repository layer assumes the following indexes exist on critical queries:

```sql
CREATE INDEX users_email_idx ON users(email);
CREATE INDEX users_username_idx ON users(username);
CREATE INDEX users_kyc_status_idx ON users(kyc_status);

CREATE INDEX ledger_entries_user_id_idx ON ledger_entries(user_id);
CREATE INDEX ledger_entries_transfer_intent_id_idx ON ledger_entries(transfer_intent_id);
CREATE INDEX ledger_entries_entry_type_idx ON ledger_entries(entry_type);

CREATE INDEX transfer_intents_user_id_idx ON transfer_intents(user_id);
CREATE INDEX transfer_intents_provider_reference_idx ON transfer_intents(provider_reference_id);
CREATE INDEX transfer_intents_status_idx ON transfer_intents(status);

CREATE INDEX provider_webhook_events_provider_event_id_idx
  ON provider_webhook_events(provider, provider_event_id);
CREATE INDEX provider_webhook_events_status_idx ON provider_webhook_events(processing_status);
```

### Query Patterns

- All queries use parameterized statements via `postgres.js` tagged templates
- Pagination is capped at 500 items per page
- Offset pagination is used (suitable for API pagination)
- No N+1 queries (each repository method executes a single SQL statement)

## Testing Strategy

### Unit Tests

- Repository interface compliance
- Error handling and conversion
- Pagination calculations
- Type safety validation

### Integration Tests (Future)

- Transaction atomicity
- Ledger pair creation
- Webhook idempotency
- Status state machine transitions

## Conclusion

The repository layer provides a clean, strongly-typed, maintainable foundation for data access in Manna. It enables safe, gradual introduction of operational capabilities without affecting production financial flows.
