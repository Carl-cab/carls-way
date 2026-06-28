// Canadian EFT provider — CA electronic funds transfers (live).
// Status: Not yet implemented.
// This provider will handle real EFT transfers via Stripe ACSS (Add Money) and VoPay Interac (Cash Out).
// Placeholder throws "Not implemented" for all methods until development begins.

import type {
  TransferProvider, TransferType, CreateIntentResult,
  ReviewResult, ConfirmResult, CancelResult, TransferStatusResult, WebhookResult,
} from './TransferProvider';

export class CanadianEFTProvider implements TransferProvider {
  readonly providerName = 'canadian_eft' as const;
  readonly providerRegion = 'CA' as const;
  readonly executionMode = 'live' as const;

  async createIntent(): Promise<CreateIntentResult> {
    throw new Error('CanadianEFTProvider.createIntent: Not implemented');
  }

  async reviewTransfer(): Promise<ReviewResult> {
    throw new Error('CanadianEFTProvider.reviewTransfer: Not implemented');
  }

  async confirmTransfer(): Promise<ConfirmResult> {
    throw new Error('CanadianEFTProvider.confirmTransfer: Not implemented');
  }

  async executeTransfer(): Promise<never> {
    throw new Error('CanadianEFTProvider.executeTransfer: Not implemented');
  }

  async cancelTransfer(): Promise<CancelResult> {
    throw new Error('CanadianEFTProvider.cancelTransfer: Not implemented');
  }

  async getTransferStatus(): Promise<TransferStatusResult> {
    throw new Error('CanadianEFTProvider.getTransferStatus: Not implemented');
  }

  async handleWebhookEvent(): Promise<WebhookResult> {
    throw new Error('CanadianEFTProvider.handleWebhookEvent: Not implemented');
  }
}
