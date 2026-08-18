# Repository Conventions

This document defines the standards and patterns for implementing repositories in Manna.

## File Organization

```
lib/repositories/
├── types.ts                    # Shared types and interfaces
├── BaseRepository.ts           # Base class with common patterns
├── UserRepository.ts           # User management
├── LedgerRepository.ts         # Ledger accounting
├── TransferIntentRepository.ts # Transfer state machine
├── ProviderEventRepository.ts  # Webhook events
├── index.ts                    # Central export point
└── __tests__/
    └── repositories.test.ts    # Unit tests
```

## Naming Conventions

### Classes

- Repository classes: `{Entity}Repository`
  - ✅ `UserRepository`
  - ✅ `LedgerRepository`
  - ✅ `TransferIntentRepository`
  - ❌ `UserData` (too vague)
  - ❌ `UserManager` (implies business logic)

### Methods

#### Read Methods

- Prefix: `find`, `get`, `search`, `count`
- Suffixes indicate specificity:
  - `findById(id)` - Single record by ID
  - `findByEmail(email)` - Single record by unique field
  - `findByStatus(status)` - Multiple records filtered
  - `findAll()` - All records
  - `search(query)` - Text search
  - `getBalance(userId, currency)` - Calculated value
  - `countByStatus()` - Aggregation

#### Write Methods

- Prefix: `create`, `update`, `delete`, `mark`
- Descriptive action:
  - `create(input)` - Insert new record
  - `update(id, updates)` - Partial update
  - `updateStatus(id, newStatus)` - Status-specific update
  - `delete(id)` - Soft or hard delete
  - `markProcessed(id)` - Idempotent state update

#### Patterns

- ✅ `findByUser(userId)`
- ✅ `findByProviderEvent(provider, eventId)`
- ✅ `updateLastLogin(id)`
- ✅ `markFailed(id, reason)`
- ❌ `get(id)` (too generic, use findById)
- ❌ `find()` (no parameters, use findAll)
- ❌ `set(id, field, value)` (use updateField instead)

## Type Definitions

All repositories use types from `lib/repositories/types.ts`.

### Domain Models

Domain models represent entities in the business:

```typescript
// User domain model
interface User {
  id: number;                           // Primary key
  name: string;                         // Immutable user data
  username: string;
  email: string;
  password_hash: string;
  balance_cad: number;                  // Denormalized cache
  balance_usd: number;
  country: 'CA' | 'US';                 // Immutable after creation
  kyc_status: 'pending' | 'verified' | 'rejected'; // Status enum
  kyc_verified_at?: string;             // Optional timestamp
  created_at: string;                   // Immutable, set by DB
}
```

**Patterns**:

- All IDs are `number` (PostgreSQL SERIAL)
- All timestamps are `string` (ISO 8601 from database)
- All currency amounts are `number` (stored as NUMERIC in DB)
- All enums are string unions: `'draft' | 'ready' | 'settled'`
- Optional fields use `?` suffix

### Input Types

Input types (for create/update) are separate from domain models:

```typescript
// CreateUserInput - only for user.create()
interface CreateUserInput {
  name: string;
  username: string;
  email: string;
  password_hash: string;
  country: 'CA' | 'US';
  province?: string;
  phone?: string;
  balance_cad?: number;      // Can be omitted (defaults to 100)
}

// Partial<User> - for profile updates
// Users don't update username/email (immutable), only:
//   - name
//   - phone
//   - avatar_color
//   - province
```

**Pattern**: Input types are "what the client provides", domain models are "what the database stores".

## Method Signatures

### Query Methods

```typescript
// Single record by ID
async findById(id: number): Promise<Entity | null>

// Single record by unique field
async findByEmail(email: string): Promise<User | null>

// Multiple records filtered
async findByStatus(status: string, limit?: number): Promise<Entity[]>

// All records with pagination
async findAll(page?: number, limit?: number): Promise<PaginatedResult<Entity>>

// Text search
async search(query: string, limit?: number): Promise<Entity[]>

// Aggregation / calculation
async getBalance(userId: number, currency: string): Promise<LedgerBalance>

// Existence check
async emailExists(email: string): Promise<boolean>

// Count
async countByStatus(): Promise<Record<string, number>>
```

### Mutation Methods

```typescript
// Create new record
async create(input: CreateEntityInput): Promise<Entity>

// Update specific field
async updateStatus(id: number, newStatus: string): Promise<Entity>

// Update multiple fields
async updateProfile(id: number, updates: Partial<Entity>): Promise<Entity>

// Idempotent state transitions
async markProcessed(id: number): Promise<Entity>
async markFailed(id: number, reason: string): Promise<Entity>

// Delete (soft or hard)
async delete(id: number): Promise<void>
```

## Error Handling

All repositories inherit error handling from `BaseRepository`.

### Error Types

```typescript
// Database UNIQUE violation → DuplicateKeyError
// Usage: catch and handle duplicate keys
try {
  await userRepository.create(input);
} catch (err) {
  if (err instanceof DuplicateKeyError) {
    return { error: 'Email already registered' };
  }
  throw err;
}

// Record not found
// Usage: when asserting a record must exist
try {
  const user = await userRepository.findById(id);
  assertFound(user, `user ${id}`);
  return user;
} catch (err) {
  if (err instanceof NotFoundError) {
    return { error: '404 User not found' };
  }
  throw err;
}

// Foreign key or check constraint violations
// Usage: when data violates constraints
// (usually indicates a bug, not user error)
try {
  await ledgerRepository.createEntry(entry);
} catch (err) {
  if (err instanceof TransactionError) {
    logger.error('FK violation:', err.details);
    return { error: 'Internal server error' };
  }
  throw err;
}
```

### Exception Handling Pattern

```typescript
// ✅ Correct: Services handle expected errors
async createTransfer(input: CreateTransferInput): Promise<TransferResult> {
  try {
    const intent = await transferRepository.create(input);
    return { success: true, intent };
  } catch (err) {
    if (err instanceof DuplicateKeyError) {
      // Idempotency: same request already processed
      return { success: false, reason: 'duplicate_request' };
    }
    // Unexpected error: let it propagate
    throw err;
  }
}

// ❌ Incorrect: Repositories catching errors
async create(input: CreateUserInput): Promise<User> {
  try {
    // ...
  } catch (err) {
    // Don't catch here - let service handle
    console.error(err);
    throw new Error('Failed to create');
  }
}
```

## Pagination

All repositories support pagination using offset-based approach.

### Pagination Pattern

```typescript
// Validate input
const { page, limit } = validatePagination(userPage, userLimit);

// Calculate offset
const offset = calculateOffset(page, limit);

// Execute query with LIMIT and OFFSET
const data = await sql`
  SELECT * FROM users
  LIMIT ${limit}
  OFFSET ${offset}
`;

// Count total
const totalResult = await sql`
  SELECT COUNT(*) as count FROM users
`;

// Return paginated result
return {
  data,
  meta: {
    page,
    limit,
    total: totalResult[0].count,
    hasMore: offset + limit < total,
  },
};
```

### Constants

```typescript
const PAGINATION_DEFAULTS = {
  page: 1,
  limit: 50,
  minLimit: 1,
  maxLimit: 500,
};
```

## SQL Query Patterns

### Parameterized Queries (Always)

```typescript
// ✅ Correct: Parameterized via template literals
const result = await this.sql`
  SELECT * FROM users WHERE id = ${userId}
`;

// ❌ Incorrect: String concatenation
const result = await this.sql.unsafe(
  `SELECT * FROM users WHERE id = ${userId}` // Still safe due to ${}, but don't use .unsafe
);
```

### INSERT with RETURNING

```typescript
// ✅ Correct: Capture generated ID and fields
const result = await this.sql<User[]>`
  INSERT INTO users (name, email, password_hash)
  VALUES (${input.name}, ${input.email}, ${input.password_hash})
  RETURNING *
`;

return result[0];
```

### Atomic Multi-Statement Operations (CTE)

```typescript
// ✅ Correct: Ledger pair created atomically
const result = await this.sql`
  WITH sender_entry AS (
    INSERT INTO ledger_entries (...)
    VALUES (...)
    RETURNING id
  ),
  receiver_entry AS (
    INSERT INTO ledger_entries (...)
    VALUES (...)
    RETURNING id
  )
  SELECT
    (SELECT id FROM sender_entry) as sender_id,
    (SELECT id FROM receiver_entry) as receiver_id
`;
```

### Idempotency via UNIQUE Constraint

```typescript
// ✅ Correct: Let database enforce uniqueness
const result = await this.sql`
  INSERT INTO provider_webhook_events (provider, provider_event_id, ...)
  VALUES (${provider}, ${eventId}, ...)
`;

// If duplicate, PostgreSQL raises error code 23505
// BaseRepository.handleError converts it to DuplicateKeyError
```

## Singleton Pattern

All repositories use singleton pattern with lazy initialization:

```typescript
// In each repository file
let instance: UserRepository | null = null;

export function getUserRepository(): UserRepository {
  if (!instance) {
    instance = new UserRepository();
  }
  return instance;
}

// Usage in services
import { getUserRepository } from '@/lib/repositories';

const user = await getUserRepository().findById(123);
```

**Benefits**:

- Single database connection per repository type
- No redundant object creation
- Easy to mock for testing
- Clear dependency injection point

## What Repositories Must NOT Do

### ❌ No Business Logic

```typescript
// WRONG: calculateFee is business logic
async calculateAndCreateEntry(userId: number, amount: number): Promise<void> {
  const fee = amount * 0.02; // NO! Business logic in repository
  await this.createEntry({
    user_id: userId,
    credit: amount - fee,
  });
}

// CORRECT: Repository only stores what service provides
await ledgerRepository.createEntry({
  user_id: userId,
  credit: amount, // Service calculated this
});
```

### ❌ No Validation

```typescript
// WRONG: Validation in repository
async create(input: CreateUserInput): Promise<User> {
  if (input.email.length < 5) {
    throw new ValidationError('Email too short'); // NO!
  }
}

// CORRECT: Service validates before calling repository
if (!isValidEmail(input.email)) {
  throw new ValidationError('Invalid email');
}

const user = await userRepository.create(input);
```

### ❌ No Authorization

```typescript
// WRONG: Authorization in repository
async getUser(id: number, currentUserId: number): Promise<User> {
  if (id !== currentUserId && !isAdmin(currentUserId)) {
    throw new UnauthorizedError(); // NO!
  }
  return this.findById(id);
}

// CORRECT: Service enforces authorization
if (userId !== currentUserId && !currentUser.isAdmin) {
  throw new UnauthorizedError();
}

const user = await userRepository.findById(userId);
```

### ❌ No Provider Calls

```typescript
// WRONG: Calling external provider in repository
async createTransfer(input: CreateTransferInput): Promise<TransferIntent> {
  const intent = await this.create(input);
  await plaidClient.createTransfer(...); // NO!
  return intent;
}

// CORRECT: Service coordinates with providers
const intent = await transferRepository.create(input);
const plaidResult = await plaidProvider.createTransfer(intent);
await transferRepository.updateProviderReference(intent.id, plaidResult.id);
```

## Summary

Repositories are the **data access layer only**. They:

- ✅ Read and write data
- ✅ Handle transactions and atomicity
- ✅ Map database records to domain models
- ✅ Convert database errors to application errors
- ✅ Support pagination and filtering

Services handle everything else:

- ✅ Business logic
- ✅ Validation
- ✅ Authorization
- ✅ External provider coordination
- ✅ Error recovery
- ✅ Audit logging

This separation keeps both layers clean, testable, and maintainable.
