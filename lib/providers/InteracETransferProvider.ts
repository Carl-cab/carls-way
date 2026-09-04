// Interac e-Transfer provider — Canadian domestic P2P.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE ATTEMPTING TO "FINISH" THIS FILE
//
// Interac does not publish a self-serve API. There is no public sandbox, no
// developer signup, and no npm client you can install and point at a test
// endpoint. Access to the e-Transfer rails is granted only to Participating
// Financial Institutions and to organisations that complete Interac's
// commercial and regulatory onboarding as a connected partner. That process
// involves contracts, security review, and (for a money-services business)
// FINTRAC registration.
//
// The practical consequence: this provider CANNOT be implemented against a real
// endpoint from inside this repository today. What exists here is the adapter
// shape — the seam the rest of the application talks to — so that when
// credentials and API documentation do arrive, the integration is a matter of
// filling in the request bodies rather than restructuring the app.
//
// Every method therefore throws InteracNotConfiguredError. That is deliberate:
// a provider that silently pretended to move money would be far more dangerous
// than one that refuses.
// ─────────────────────────────────────────────────────────────────────────────
//
// The shape below mirrors the two live providers already in the codebase, which
// were built against real SDKs and hardened in Phase 3:
//
//   - a stable idempotency key derived from the durable transfer_intents.id,
//     never from Date.now() or a per-request value;
//   - the provider reference persisted immediately after submission, with the
//     intent parked in `submitting` until that write lands, so a
//     provider-success/database-failure window stays recoverable;
//   - a `submitting` state that means "outcome unknown", never conflated with
//     `failed`;
//   - reconciliation by provider lookup where the provider supports it.
//
// Interac-specific behaviour that will need to be honoured once wired up:
//
//   Auto-deposit    Recipients with auto-deposit registered receive funds
//                   directly; no security question is involved and the transfer
//                   completes without recipient action.
//   Security Q&A    Recipients WITHOUT auto-deposit must answer a security
//                   question. The answer must never be stored in plaintext, and
//                   must not be derivable from the transfer note or amount.
//   Recipient email The registered Interac email is the addressing key, held in
//                   users.interac_email.
//   Notifications   Interac delivers status by callback; those callbacks must be
//                   signature-verified before any state change, exactly as the
//                   Plaid and Stripe webhooks already are.

/* eslint-disable @typescript-eslint/no-unused-vars --
   Every method in this adapter throws InteracNotConfiguredError because there is
   no Interac client to call. The parameters are retained (underscore-prefixed)
   so the file documents the real TransferProvider contract that a future
   implementation must satisfy; removing them would erase that signature. */

import type {
  TransferProvider,
  TransferType,
  CreateIntentResult,
  ReviewResult,
  ConfirmResult,
  CancelResult,
  TransferStatusResult,
  WebhookResult,
} from './TransferProvider';

/**
 * Thrown by every method until a real Interac integration exists.
 *
 * Callers must treat this as "this rail is unavailable", never as a transfer
 * failure — no money was moved and no external state was created.
 */
export class InteracNotConfiguredError extends Error {
  readonly capability = 'interac_etransfer';

  constructor(operation: string) {
    super(
      `Interac e-Transfer is not configured: ${operation} is unavailable. ` +
        'Interac has no public API; access requires onboarding as a Participating ' +
        'Financial Institution or connected partner. See GO_LIVE_RUNBOOK.md.',
    );
    this.name = 'InteracNotConfiguredError';
  }
}

/** Whether a real Interac integration has been configured. Always false today. */
export function isInteracConfigured(): boolean {
  // Intentionally not wired to an environment flag. Adding a flag would imply
  // the integration can be switched on, which it cannot — there is no client
  // behind it. This returns false until real code replaces the stubs below.
  return false;
}

export class InteracETransferProvider implements TransferProvider {
  readonly providerName = 'canadian_eft' as const;
  readonly providerRegion = 'CA' as const;
  readonly executionMode = 'live' as const;

  async createIntent(
    _userId: number,
    _bankAccountId: number,
    _type: TransferType,
    _amount: number,
    _currency: string,
  ): Promise<CreateIntentResult> {
    throw new InteracNotConfiguredError('createIntent');
  }

  async reviewTransfer(_intentId: number, _userId: number): Promise<ReviewResult> {
    throw new InteracNotConfiguredError('reviewTransfer');
  }

  async confirmTransfer(_intentId: number, _userId: number): Promise<ConfirmResult> {
    throw new InteracNotConfiguredError('confirmTransfer');
  }

  async executeTransfer(_intentId: number, _userId: number): Promise<never> {
    throw new InteracNotConfiguredError('executeTransfer');
  }

  async cancelTransfer(_intentId: number, _userId: number): Promise<CancelResult> {
    throw new InteracNotConfiguredError('cancelTransfer');
  }

  async getTransferStatus(_intentId: number, _userId: number): Promise<TransferStatusResult> {
    throw new InteracNotConfiguredError('getTransferStatus');
  }

  async handleWebhookEvent(_rawPayload: unknown): Promise<WebhookResult> {
    return {
      processed: false,
      message: 'Interac e-Transfer is not configured; no webhook handling exists.',
    };
  }
}
