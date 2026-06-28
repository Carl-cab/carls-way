# Data Access Guide

Practical guide for using the Manna repository layer in services and API routes.

## Quick Start

### 1. Import Repositories

```typescript
import {
  getUserRepository,
  getLedgerRepository,
  getTransferIntentRepository,
  getProviderEventRepository,
} from '@/lib/repositories';
```

### 2. Query Data

```typescript
// Get single user
const user = await getUserRepository().findById(userId);
if (!user) {
  throw new NotFoundError('User', `id = ${userId}`);
}

// Get user transactions (paginated)
const result = await getLedgerRepository().findByUserPaginated(userId, 1, 50);
console.log(`Showing ${result.data.length} of ${result.meta.total} items`);

// Get user balance
const balance = await getLedgerRepository().getBalance(userId, 'CAD');
console.log(`Balance: $${balance.balance}`);
```

### 3. Modify Data

```typescript
// Create new user
const user = await getUserRepository().create({
  name: 'Alice',
  username: 'alice',
  email: 'alice@example.com',
  password_hash: hashedPassword,
  country: 'CA',
});

// Create transfer intent
const intent = await getTransferIntentRepository().create({
  user_id: userId,
  bank_account_id: accountId,
  type: 'add_money',
  amount: 500,
  currency: 'CAD',
  provider_region: 'CA',
  provider_name: 'sandbox_ca',
  execution_mode: 'sandbox',
  correlation_id: context.correlationId,
});

// Update status
await getTransferIntentRepository().updateStatus(intent.id, 'ready');
```

## Common Patterns

### Pattern: Create a P2P Payment

```typescript
import { getTransactionRepository, getLedgerRepository } from '@/lib/repositories';

async function createPayment(
  senderId: number,
  receiverId: number,
  amount: number,
  currency: 'CAD' | 'USD',
  correlationId: string
): Promise<{ transaction: Transaction; ledger: LedgerEntry[] }> {
  // 1. Create transaction record
  const transaction = await getTransactionRepository().create({
    sender_id: senderId,
    receiver_id: receiverId,
    amount,
    currency,
    type: 'payment',
    privacy: 'friends',
  });

  // 2. Create ledger pair (atomic)
  const { debit, credit } = await getLedgerRepository().createPair({
    sender_user_id: senderId,
    receiver_user_id: receiverId,
    transaction_id: transaction.id,
    currency,
    amount,
    correlation_id: correlationId,
  });

  // 3. Return both records
  return {
    transaction,
    ledger: [debit, credit],
  };
}
```

### Pattern: Handle Webhook Event

```typescript
import { getProviderEventRepository } from '@/lib/repositories';

async function handlePlaidWebhook(
  webhookId: string,
  payload: Record<string, unknown>,
  correlationId: string
): Promise<{ processed: boolean; eventId?: number }> {
  try {
    // Record webhook event (idempotency check)
    const event = await getProviderEventRepository().create({
      provider: 'plaid',
      provider_event_id: webhookId,
      event_type: payload.webhook_type as string,
      related_provider_reference: payload.item_id as string,
      raw_payload: payload,
      correlation_id: correlationId,
    });

    // Event is new - process it
    await getProviderEventRepository().markProcessing(event.id);

    try {
      // Process the event (orchestration, settlement, etc.)
      await processWebhookEvent(event, payload);

      // Mark as processed
      await getProviderEventRepository().markProcessed(event.id);

      return { processed: true, eventId: event.id };
    } catch (err) {
      // Mark as failed
      await getProviderEventRepository().markFailed(event.id, err.message);
      throw err;
    }
  } catch (err) {
    if (err instanceof DuplicateKeyError) {
      // Event already processed - acknowledge with 200
      return { processed: false };
    }
    throw err;
  }
}
```

### Pattern: Track Request Through System

```typescript
import {
  getUserRepository,
  getTransferIntentRepository,
  getProviderEventRepository,
  getLedgerRepository,
} from '@/lib/repositories';

async function traceRequest(correlationId: string): Promise<{
  user?: User;
  transferIntent?: TransferIntent;
  webhookEvent?: ProviderWebhookEvent;
  ledgerEntries?: LedgerEntry[];
}> {
  const result: Record<string, any> = {};

  // Find all entities related to this request
  const intents = await getTransferIntentRepository().findByCorrelationId(correlationId);
  if (intents.length > 0) {
    result.transferIntent = intents[0];

    const user = await getUserRepository().findById(intents[0].user_id);
    result.user = user;
  }

  const events = await getProviderEventRepository().findByCorrelationId(correlationId);
  if (events.length > 0) {
    result.webhookEvent = events[0];
  }

  const entries = await getLedgerRepository().findByCorrelationId(correlationId);
  if (entries.length > 0) {
    result.ledgerEntries = entries;
  }

  return result;
}
```

### Pattern: Ensure Idempotent Operations

```typescript
import { getTransferIntentRepository } from '@/lib/repositories';

async function createTransferIdempotent(
  userId: number,
  idempotencyKey: string,
  input: CreateTransferIntentInput
): Promise<TransferIntent> {
  // Check if request already processed
  const existing = await getTransferIntentRepository().findByIdempotencyKey(
    userId,
    idempotencyKey
  );

  if (existing.length > 0) {
    // Return existing transfer (idempotent response)
    return existing[0];
  }

  // Create new transfer
  return getTransferIntentRepository().create({
    ...input,
    user_id: userId,
    idempotency_key: idempotencyKey,
  });
}
```

### Pattern: Pagination with Cursor

```typescript
import { getUserRepository } from '@/lib/repositories';

async function listUserTransactions(userId: number, page: number = 1) {
  // Get paginated results
  const result = await getLedgerRepository().findByUserPaginated(userId, page, 50);

  // Return paginated response
  return {
    transactions: result.data,
    pagination: {
      page: result.meta.page,
      limit: result.meta.limit,
      total: result.meta.total,
      hasMore: result.meta.hasMore,
      nextPage: result.meta.hasMore ? page + 1 : null,
    },
  };
}
```

## Error Handling

### Example: Create User with Duplicate Email

```typescript
import { getUserRepository } from '@/lib/repositories';
import { DuplicateKeyError, NotFoundError } from '@/lib/repositories';

async function registerUser(input: CreateUserInput) {
  try {
    const user = await getUserRepository().create(input);
    return { success: true, user };
  } catch (err) {
    if (err instanceof DuplicateKeyError) {
      // Duplicate email/username - user error
      return { success: false, error: 'Email already registered' };
    }

    if (err instanceof TransactionError) {
      // DB constraint violation - unexpected
      logger.error('DB constraint violation:', err);
      return { success: false, error: 'Internal server error' };
    }

    // Unknown error - propagate
    throw err;
  }
}
```

### Example: Safe Delete with Existence Check

```typescript
import { getUserRepository } from '@/lib/repositories';
import { NotFoundError } from '@/lib/repositories';

async function deleteUser(userId: number) {
  try {
    const user = await getUserRepository().findById(userId);

    // Assertion: user must exist
    if (!user) {
      throw new NotFoundError('User', `id = ${userId}`);
    }

    // Proceed with deletion
    await deleteUserData(userId);

    return { success: true };
  } catch (err) {
    if (err instanceof NotFoundError) {
      return { success: false, error: '404 Not found', status: 404 };
    }

    throw err;
  }
}
```

## Integration with Services

### Example: Settlement Service Using Repositories

```typescript
import {
  getTransferIntentRepository,
  getLedgerRepository,
  getUserRepository,
} from '@/lib/repositories';

class SettlementService {
  async executeSettlement(plan: SettlementPlan): Promise<SettlementResult> {
    const transferRepo = getTransferIntentRepository();
    const ledgerRepo = getLedgerRepository();
    const userRepo = getUserRepository();

    try {
      // Phase B3.1: Update transfer status
      const intent = await transferRepo.updateStatus(plan.intentId, plan.nextStatus);

      // Phase B3.2a: Create ledger entries
      if (plan.createLedgerEntries.shouldCreate && plan.createLedgerEntries.entries) {
        for (const entry of plan.createLedgerEntries.entries) {
          await ledgerRepo.createEntry(entry);
        }
      }

      // Phase B3.2b: Update user balances
      if (plan.updateBalance.shouldUpdate) {
        const user = await userRepo.findById(intent.user_id);
        if (!user) throw new NotFoundError('User', `id = ${intent.user_id}`);

        const balances = await ledgerRepo.getBalances(intent.user_id);
        await userRepo.updateBalances(intent.user_id, balances.CAD, balances.USD);
      }

      return {
        success: true,
        intent,
        reason: plan.reason,
      };
    } catch (err) {
      logger.error('Settlement execution failed:', err);
      throw err;
    }
  }
}
```

## Migration from Old Code

### Before: Using Direct SQL

```typescript
// OLD: Direct SQL in service
async function getUserBalance(userId: number, currency: string) {
  const sql = getSql();
  const result = await sql`
    SELECT COALESCE(SUM(credit), 0) - COALESCE(SUM(debit), 0) as balance
    FROM ledger_entries
    WHERE user_id = ${userId} AND currency = ${currency}
  `;
  return result[0].balance;
}
```

### After: Using Repository

```typescript
// NEW: Using repository
import { getLedgerRepository } from '@/lib/repositories';

async function getUserBalance(userId: number, currency: 'CAD' | 'USD') {
  const balance = await getLedgerRepository().getBalance(userId, currency);
  return balance.balance; // or balance.credit - balance.debit
}
```

## Testing Repositories

### Mock Pattern

```typescript
// In test file
jest.mock('@/lib/repositories', () => ({
  getUserRepository: jest.fn(() => ({
    findById: jest.fn().mockResolvedValue({
      id: 1,
      name: 'Test User',
      email: 'test@example.com',
      // ... other fields
    }),
    create: jest.fn().mockResolvedValue({
      id: 2,
      // ... created user
    }),
  })),
}));

// In test
import { getUserRepository } from '@/lib/repositories';

describe('Service', () => {
  it('should find user by ID', async () => {
    const user = await getUserRepository().findById(1);
    expect(user.name).toBe('Test User');
  });
});
```

## Best Practices

### ✅ DO

- Use repositories for all data access
- Let repositories handle error mapping
- Keep business logic in services
- Use singleton instances
- Pass correlation IDs through the stack
- Handle DuplicateKeyError for idempotency
- Paginate large result sets

### ❌ DON'T

- Use `getSql()` directly in new code
- Put business logic in repositories
- Validate input in repositories
- Make authorization decisions in repositories
- Call external providers from repositories
- Catch and swallow errors in repositories
- Create multiple instances of same repository

## Troubleshooting

### Problem: DuplicateKeyError on Create

**Cause**: Record with this unique key already exists

**Solution**: 
- Check if this is a duplicate request (same request processed twice)
- If so, return existing record (idempotent)
- If not, ask user to provide different value (e.g., different email)

### Problem: NotFoundError on Update

**Cause**: Record doesn't exist

**Solution**:
- Check if ID is correct
- Create record first if needed
- Return 404 if record should exist

### Problem: TransactionError on Create

**Cause**: Foreign key or check constraint violation

**Solution**:
- Ensure referenced records exist
- Ensure input values satisfy constraints
- Log error for investigation (likely a bug)

### Problem: Slow Queries

**Solution**:
- Check if database indexes exist (see REPOSITORY_ARCHITECTURE.md)
- Check if query uses LIMIT for large result sets
- Consider caching for frequently accessed data
- Profile with database query logs

## Summary

The repository layer provides:

- **Type Safety**: Strongly-typed interfaces for all data
- **Consistency**: Standardized error handling and patterns
- **Maintainability**: Clear separation of data access from logic
- **Testability**: Easy to mock for unit tests
- **Traceability**: Correlation IDs throughout the stack

Use repositories for all data access, and keep business logic in services.
