/**
 * Repository layer index.
 *
 * Central export point for all repositories and their singleton instances.
 * Services should import repositories from this index, not directly from
 * individual files.
 *
 * Usage:
 *   import { getUserRepository, getLedgerRepository } from '@/lib/repositories';
 *
 *   const user = await getUserRepository().findById(123);
 *   const balance = await getLedgerRepository().getBalance(123, 'CAD');
 */

export * from './types';
export * from './BaseRepository';
export * from './UserRepository';
export * from './LedgerRepository';
export * from './TransferIntentRepository';
export * from './ProviderEventRepository';

// Export singleton factories
export { getUserRepository } from './UserRepository';
export { getLedgerRepository } from './LedgerRepository';
export { getTransferIntentRepository } from './TransferIntentRepository';
export { getProviderEventRepository } from './ProviderEventRepository';

/**
 * Repository registry for dependency injection.
 *
 * If needed in the future for more complex DI patterns, this provides
 * a centralized way to manage all repository instances.
 */
export const RepositoryRegistry = {
  user: () => {
    const { getUserRepository } = require('./UserRepository');
    return getUserRepository();
  },
  ledger: () => {
    const { getLedgerRepository } = require('./LedgerRepository');
    return getLedgerRepository();
  },
  transferIntent: () => {
    const { getTransferIntentRepository } = require('./TransferIntentRepository');
    return getTransferIntentRepository();
  },
  providerEvent: () => {
    const { getProviderEventRepository } = require('./ProviderEventRepository');
    return getProviderEventRepository();
  },
};
