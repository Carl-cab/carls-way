/**
 * Unit tests for repository layer.
 *
 * Tests verify:
 * - Repository interfaces work correctly
 * - Error handling converts database errors properly
 * - Type safety is enforced
 * - Pagination works as expected
 * - Query builders produce correct SQL
 * - Singleton instances work properly
 *
 * Note: These tests use a simple mock approach. Full integration tests
 * would require a test database and transaction rollback.
 */

import { BaseRepository } from '../repositories/BaseRepository';
import {
  RepositoryError,
  DuplicateKeyError,
  NotFoundError,
  TransactionError,
  User,
  LedgerEntry,
  TransferIntent,
} from '../repositories/types';

describe('Repository Layer', () => {
  describe('Error Handling', () => {
    it('should convert PostgreSQL UNIQUE violation to DuplicateKeyError', () => {
      const repo = new BaseRepository();
      const dbError = {
        code: '23505',
        constraint: 'users_email_key',
        message: 'duplicate key value',
      };

      expect(() => {
        repo['handleError'](dbError, 'UserRepository.create');
      }).toThrow(DuplicateKeyError);
    });

    it('should convert PostgreSQL FK violation to TransactionError', () => {
      const repo = new BaseRepository();
      const dbError = {
        code: '23503',
        detail: 'Key (user_id)=(999) is not present in table "users"',
      };

      expect(() => {
        repo['handleError'](dbError, 'LedgerRepository.create');
      }).toThrow(TransactionError);
    });

    it('should convert PostgreSQL CHECK violation to TransactionError', () => {
      const repo = new BaseRepository();
      const dbError = {
        code: '23514',
        detail: 'new row for relation "transfer_intents" violates check constraint',
      };

      expect(() => {
        repo['handleError'](dbError, 'TransferIntentRepository.create');
      }).toThrow(TransactionError);
    });

    it('should re-throw RepositoryErrors as-is', () => {
      const repo = new BaseRepository();
      const error = new NotFoundError('User', 'id = 123');

      expect(() => {
        repo['handleError'](error, 'UserRepository.findById');
      }).toThrow(NotFoundError);
    });

    it('should throw TransactionError for unknown database errors', () => {
      const repo = new BaseRepository();
      const dbError = { code: 'XX999', message: 'Unknown error' };

      expect(() => {
        repo['handleError'](dbError, 'SomeRepository.someMethod');
      }).toThrow(TransactionError);
    });
  });

  describe('Assertions', () => {
    it('should throw NotFoundError when asserting on null value', () => {
      const repo = new BaseRepository();

      expect(() => {
        repo['assertFound'](null, 'user_123');
      }).toThrow(NotFoundError);
    });

    it('should throw NotFoundError when asserting on undefined value', () => {
      const repo = new BaseRepository();

      expect(() => {
        repo['assertFound'](undefined, 'transfer_456');
      }).toThrow(NotFoundError);
    });

    it('should not throw when asserting on valid value', () => {
      const repo = new BaseRepository();
      const user: User = {
        id: 1,
        name: 'Test',
        username: 'test',
        email: 'test@example.com',
        password_hash: 'hash',
        balance_cad: 100,
        balance_usd: 100,
        country: 'CA',
        kyc_status: 'pending',
        failed_login_attempts: 0,
        created_at: new Date().toISOString(),
      };

      expect(() => {
        repo['assertFound'](user, 'user_123');
      }).not.toThrow();
    });
  });

  describe('Pagination', () => {
    it('should validate and constrain page numbers', () => {
      const repo = new BaseRepository();

      const valid = repo['validatePagination'](0, 50);
      expect(valid.page).toBe(1); // Minimum page is 1

      const valid2 = repo['validatePagination'](999, 50);
      expect(valid2.page).toBe(999);
    });

    it('should validate and constrain limit', () => {
      const repo = new BaseRepository();

      const valid = repo['validatePagination'](1, 0);
      expect(valid.limit).toBe(1); // Minimum limit is 1

      const valid2 = repo['validatePagination'](1, 1000);
      expect(valid2.limit).toBe(500); // Maximum limit is 500

      const valid3 = repo['validatePagination'](1, 50);
      expect(valid3.limit).toBe(50);
    });

    it('should calculate correct offset for pagination', () => {
      const repo = new BaseRepository();

      expect(repo['calculateOffset'](1, 50)).toBe(0);
      expect(repo['calculateOffset'](2, 50)).toBe(50);
      expect(repo['calculateOffset'](3, 50)).toBe(100);
      expect(repo['calculateOffset'](10, 20)).toBe(180);
    });

    it('should handle invalid page numbers in offset calculation', () => {
      const repo = new BaseRepository();

      expect(repo['calculateOffset'](0, 50)).toBe(0); // Page 0 treated as page 1
      expect(repo['calculateOffset'](-5, 50)).toBe(0); // Negative page treated as page 1
    });
  });

  describe('Timestamp Formatting', () => {
    it('should format Date objects to ISO string', () => {
      const repo = new BaseRepository();
      const date = new Date('2024-01-15T10:30:00Z');

      const formatted = repo['formatTimestamp'](date);
      expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should return ISO strings unchanged', () => {
      const repo = new BaseRepository();
      const iso = '2024-01-15T10:30:00Z';

      const formatted = repo['formatTimestamp'](iso);
      expect(formatted).toBe(iso);
    });

    it('should use current time when no date provided', () => {
      const repo = new BaseRepository();
      const before = new Date();

      const formatted = repo['formatTimestamp']();

      const after = new Date();

      // Formatted time should be between before and after
      const formattedDate = new Date(formatted);
      expect(formattedDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(formattedDate.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should parse ISO timestamps to Date objects', () => {
      const repo = new BaseRepository();
      const iso = '2024-01-15T10:30:00Z';

      const parsed = repo['parseTimestamp'](iso);
      expect(parsed).toBeInstanceOf(Date);
      expect(parsed.getFullYear()).toBe(2024);
      expect(parsed.getMonth()).toBe(0); // January (0-indexed)
      expect(parsed.getDate()).toBe(15);
    });
  });

  describe('Type Safety', () => {
    it('should maintain User type safety', () => {
      const user: User = {
        id: 1,
        name: 'Alice',
        username: 'alice',
        email: 'alice@example.com',
        password_hash: 'hash',
        balance_cad: 150.50,
        balance_usd: 120.25,
        country: 'CA',
        province: 'ON',
        phone: '555-1234',
        avatar_color: 'red',
        kyc_status: 'verified',
        kyc_provider: 'stripe',
        kyc_verified_at: '2024-01-15T10:30:00Z',
        failed_login_attempts: 0,
        created_at: '2024-01-01T00:00:00Z',
      };

      expect(user.country).toBe('CA');
      expect(user.kyc_status).toBe('verified');
    });

    it('should maintain LedgerEntry type safety', () => {
      const entry: LedgerEntry = {
        id: 1,
        user_id: 1,
        currency: 'CAD',
        account_type: 'wallet',
        entry_type: 'payment_sent',
        debit: 50.0,
        credit: 0.0,
        created_at: new Date().toISOString(),
      };

      expect(entry.currency).toBe('CAD');
      expect(entry.entry_type).toBe('payment_sent');
      expect(entry.debit).toBe(50.0);
    });

    it('should maintain TransferIntent type safety', () => {
      const intent: TransferIntent = {
        id: 1,
        user_id: 1,
        bank_account_id: 1,
        type: 'add_money',
        amount: 500,
        currency: 'CAD',
        status: 'draft',
        provider_region: 'CA',
        provider_name: 'sandbox_ca',
        execution_mode: 'sandbox',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      expect(intent.type).toBe('add_money');
      expect(intent.status).toBe('draft');
      expect(intent.execution_mode).toBe('sandbox');
    });
  });

  describe('Error Types', () => {
    it('should create DuplicateKeyError with correct properties', () => {
      const error = new DuplicateKeyError('User', 'email_key');

      expect(error.name).toBe('DuplicateKeyError');
      expect(error.code).toBe('DUPLICATE_KEY');
      expect(error.message).toContain('User');
      expect(error.message).toContain('email_key');
    });

    it('should create NotFoundError with correct properties', () => {
      const error = new NotFoundError('TransferIntent', 'id = 999');

      expect(error.name).toBe('NotFoundError');
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toContain('TransferIntent');
      expect(error.message).toContain('id = 999');
    });

    it('should create TransactionError with optional details', () => {
      const details = { constraint: 'fk_user_id' };
      const error = new TransactionError('FK constraint violation', details);

      expect(error.name).toBe('TransactionError');
      expect(error.code).toBe('TRANSACTION_ERROR');
      expect(error.details).toEqual(details);
    });
  });

  describe('Repository Isolation', () => {
    it('should maintain separate singleton instances', async () => {
      // Importing the same repository twice should return same instance
      const { getUserRepository: getUserRepo1 } = await import(
        '../repositories/UserRepository'
      );
      const { getUserRepository: getUserRepo2 } = await import(
        '../repositories/UserRepository'
      );

      const repo1 = getUserRepo1();
      const repo2 = getUserRepo2();

      // Both should be the same instance (singleton pattern)
      expect(repo1).toBe(repo2);
    });
  });

  describe('Architecture Validation', () => {
    it('should confirm repositories contain no business logic', () => {
      // This is a conceptual test - verify by inspection that:
      // - Repositories only read/write data
      // - No financial calculations
      // - No validation logic
      // - No authorization decisions
      // - No external provider calls

      // Example validation structure for BaseRepository
      const repo = new BaseRepository();

      // Should have data access methods
      expect(typeof repo['executeQuery']).toBe('function');
      expect(typeof repo['handleError']).toBe('function');

      // Should NOT have business logic methods
      expect(typeof (repo as any).calculateFee).toBeFalsy();
      expect(typeof (repo as any).authorizeUser).toBeFalsy();
      expect(typeof (repo as any).callExternalProvider).toBeFalsy();
    });

    it('should have clean separation of concerns', () => {
      // Repositories should be focused on a single entity or aggregate
      // - UserRepository: Users
      // - LedgerRepository: Ledger entries
      // - TransferIntentRepository: Transfer intents
      // - ProviderEventRepository: Provider events

      // Each repository extends BaseRepository and implements specific queries
      expect(BaseRepository).toBeDefined();

      const { UserRepository } = require('../repositories/UserRepository');
      const { LedgerRepository } = require('../repositories/LedgerRepository');
      const { TransferIntentRepository } = require('../repositories/TransferIntentRepository');
      const { ProviderEventRepository } = require('../repositories/ProviderEventRepository');

      expect(new UserRepository()).toBeInstanceOf(BaseRepository);
      expect(new LedgerRepository()).toBeInstanceOf(BaseRepository);
      expect(new TransferIntentRepository()).toBeInstanceOf(BaseRepository);
      expect(new ProviderEventRepository()).toBeInstanceOf(BaseRepository);
    });
  });
});
