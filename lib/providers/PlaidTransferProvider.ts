// Plaid Transfer provider — US ACH transfers (live).
// Status: Not yet implemented.
// This provider will handle real ACH debit/credit via Plaid Transfer API.
// Placeholder throws "Not implemented" for all methods until development begins.

import type {
  TransferProvider, TransferType, CreateIntentResult,
  ReviewResult, ConfirmResult, CancelResult, TransferStatusResult, WebhookResult,
} from './TransferProvider';

export class PlaidTransferProvider implements TransferProvider {
  readonly providerName = 'plaid_transfer' as const;
  readonly providerRegion = 'US' as const;
  readonly executionMode = 'live' as const;

  async createIntent(): Promise<CreateIntentResult> {
    throw new Error('PlaidTransferProvider.createIntent: Not implemented');
  }

  async reviewTransfer(): Promise<ReviewResult> {
    throw new Error('PlaidTransferProvider.reviewTransfer: Not implemented');
  }

  async confirmTransfer(): Promise<ConfirmResult> {
    throw new Error('PlaidTransferProvider.confirmTransfer: Not implemented');
  }

  async executeTransfer(): Promise<never> {
    throw new Error('PlaidTransferProvider.executeTransfer: Not implemented');
  }

  async cancelTransfer(): Promise<CancelResult> {
    throw new Error('PlaidTransferProvider.cancelTransfer: Not implemented');
  }

  async getTransferStatus(): Promise<TransferStatusResult> {
    throw new Error('PlaidTransferProvider.getTransferStatus: Not implemented');
  }

  async handleWebhookEvent(): Promise<WebhookResult> {
    throw new Error('PlaidTransferProvider.handleWebhookEvent: Not implemented');
  }
}
