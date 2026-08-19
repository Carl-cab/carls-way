/**
 * Phase 3 — live transfer execution safety.
 *
 * These tests exercise PlaidTransferProvider.executeTransfer and
 * reconcileTransfer against a real database with the Plaid SDK mocked. No live
 * provider flag is set and no real money moves; the mock stands in for the
 * network boundary only.
 *
 * The properties under test:
 *   1. one transfer intent yields one stable provider idempotency identifier,
 *      unchanged across retries, reloads and concurrent execution;
 *   2. a provider success followed by a local failure leaves a recoverable
 *      state, never a false `failed`;
 *   3. replaying the provider call cannot create a second transfer;
 *   4. webhook arrival before, after, or twice around local persistence is safe.
 */

import { getSql } from '../db';

// ── Plaid SDK mock ───────────────────────────────────────────────────────────
// Records every call so tests can assert exactly what was sent to the provider.
interface AuthCall { amount: string }
interface CreateCall { authorization_id: string }

const plaidCalls = {
  authorizations: [] as AuthCall[],
  creates: [] as CreateCall[],
  reset() { this.authorizations = []; this.creates = []; },
};

/** Transfers the fake provider believes exist, keyed by authorization id. */
const providerTransfers = new Map<string, string>();

let authorizationDecision: 'approved' | 'declined' = 'approved';
let transferCreateBehaviour: 'ok' | 'timeout' = 'ok';
let authSeq = 0;
let transferSeq = 0;

vi.mock('@/lib/plaid', () => ({
  plaidClient: {
    transferAuthorizationCreate: async (req: { amount: string }) => {
      plaidCalls.authorizations.push({ amount: req.amount });
      authSeq += 1;
      return {
        data: {
          authorization: {
            id: `auth_${authSeq}`,
            decision: authorizationDecision,
            decision_rationale:
              authorizationDecision === 'declined'
                ? { description: 'Insufficient funds at institution' }
                : null,
          },
        },
      };
    },
    transferCreate: async (req: { authorization_id: string }) => {
      plaidCalls.creates.push({ authorization_id: req.authorization_id });

      if (transferCreateBehaviour === 'timeout') {
        throw new Error('ETIMEDOUT: provider did not respond');
      }

      // This is the behaviour that matters: Plaid treats authorization_id as the
      // idempotency identifier, so replaying a call with the same authorization
      // returns the transfer that already exists rather than creating another.
      const existing = providerTransfers.get(req.authorization_id);
      if (existing) {
        return { data: { transfer: { id: existing } } };
      }
      transferSeq += 1;
      const transferId = `plaid_transfer_${transferSeq}`;
      providerTransfers.set(req.authorization_id, transferId);
      return { data: { transfer: { id: transferId } } };
    },
  },
  requireEncryptedBankToken: async () => 'access-token-test',
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  return { ...actual, auditLog: async () => {} };
});

const { PlaidTransferProvider } = await import('../providers/PlaidTransferProvider');

const USER_ID = 9001;
const BANK_ACCOUNT_ID = 9001;

const sql = getSql();
const provider = new PlaidTransferProvider();

/** Create a `ready` live intent and return its id. */
async function createReadyIntent(idempotencyKey?: string | null): Promise<number> {
  const rows = await sql`
    INSERT INTO transfer_intents (
      user_id, bank_account_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, idempotency_key
    ) VALUES (
      ${USER_ID}, ${BANK_ACCOUNT_ID}, 'add_money', 25.00, 'USD', 'ready',
      'US', 'plaid_transfer', 'live', ${idempotencyKey ?? null}
    )
    RETURNING id
  `;
  return rows[0].id as number;
}

async function readIntent(intentId: number) {
  const rows = await sql`
    SELECT status, idempotency_key, provider_authorization_id, provider_reference_id, failure_reason
    FROM transfer_intents WHERE id = ${intentId}
  `;
  return rows[0] as {
    status: string;
    idempotency_key: string | null;
    provider_authorization_id: string | null;
    provider_reference_id: string | null;
    failure_reason: string | null;
  };
}

/**
 * executeTransfer signals success by throwing a tagged error (the method is
 * typed Promise<never> because the transfer continues asynchronously).
 */
async function execute(intentId: number): Promise<{
  submitted: boolean; transferId?: string; idempotencyKey?: string; error?: Error;
}> {
  try {
    await provider.executeTransfer(intentId, USER_ID);
    return { submitted: false };
  } catch (err) {
    const e = err as Error & { __submitted?: boolean; plaid_transfer_id?: string; idempotency_key?: string };
    if (e.__submitted) {
      return { submitted: true, transferId: e.plaid_transfer_id, idempotencyKey: e.idempotency_key };
    }
    return { submitted: false, error: e };
  }
}

beforeEach(async () => {
  plaidCalls.reset();
  providerTransfers.clear();
  authSeq = 0;
  transferSeq = 0;
  authorizationDecision = 'approved';
  transferCreateBehaviour = 'ok';
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

describe('Transfer execution safety', () => {
  describe('normal success', () => {
    it('persists a stable key, sends the authorization to Plaid, and records the reference', async () => {
      const intentId = await createReadyIntent('plaid_9001_persisted');

      const result = await execute(intentId);
      expect(result.submitted).toBe(true);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      expect(intent.idempotency_key).toBe('plaid_9001_persisted');
      expect(intent.provider_authorization_id).toBe('auth_1');
      expect(intent.provider_reference_id).toBe(result.transferId);
      expect(intent.failure_reason).toBeNull();

      // The authorization persisted locally is exactly what was sent to Plaid.
      expect(plaidCalls.creates).toHaveLength(1);
      expect(plaidCalls.creates[0].authorization_id).toBe('auth_1');
    });

    it('derives a stable key from the intent id when none was persisted', async () => {
      const intentId = await createReadyIntent(null);
      await execute(intentId);

      const intent = await readIntent(intentId);
      // Derived from the durable primary key — no Date.now(), no request id.
      expect(intent.idempotency_key).toBe(`manna_intent_${intentId}`);
    });
  });

  describe('duplicate execution', () => {
    it('executing the same intent twice reuses the key and creates no second transfer', async () => {
      const intentId = await createReadyIntent('plaid_dup_key');

      const first = await execute(intentId);
      const second = await execute(intentId);

      expect(first.submitted).toBe(true);
      expect(second.submitted).toBe(true);
      expect(second.transferId).toBe(first.transferId);
      expect(second.idempotencyKey).toBe(first.idempotencyKey);

      // The second execute short-circuits on the recorded reference.
      expect(plaidCalls.creates).toHaveLength(1);
      expect(plaidCalls.authorizations).toHaveLength(1);
      expect(providerTransfers.size).toBe(1);
    });

    it('a reload from the database yields the same key (survives process restart)', async () => {
      const intentId = await createReadyIntent('plaid_restart_key');
      await execute(intentId);
      const afterFirst = await readIntent(intentId);

      // Simulate a fresh process: new provider instance, state read from the DB.
      const freshProvider = new PlaidTransferProvider();
      try {
        await freshProvider.executeTransfer(intentId, USER_ID);
      } catch { /* tagged submitted error */ }

      const afterSecond = await readIntent(intentId);
      expect(afterSecond.idempotency_key).toBe(afterFirst.idempotency_key);
      expect(afterSecond.provider_reference_id).toBe(afterFirst.provider_reference_id);
      expect(providerTransfers.size).toBe(1);
    });
  });

  describe('concurrent execution', () => {
    it('two simultaneous executions produce one key and one provider transfer', async () => {
      const intentId = await createReadyIntent('plaid_concurrent_key');

      const [a, b] = await Promise.all([execute(intentId), execute(intentId)]);

      const intent = await readIntent(intentId);
      expect(intent.idempotency_key).toBe('plaid_concurrent_key');
      expect(intent.status).toBe('processing');

      // Exactly one transfer exists at the provider regardless of interleaving.
      expect(providerTransfers.size).toBe(1);
      // And at most one authorization was ever created.
      expect(plaidCalls.authorizations.length).toBeLessThanOrEqual(1);

      const submitted = [a, b].filter((r) => r.submitted);
      expect(submitted.length).toBeGreaterThanOrEqual(1);
      for (const r of submitted) {
        expect(r.transferId).toBe(intent.provider_reference_id);
      }
    });
  });

  describe('provider timeout — outcome unknown', () => {
    it('does NOT mark the transfer failed and leaves it reconcilable', async () => {
      const intentId = await createReadyIntent('plaid_timeout_key');
      transferCreateBehaviour = 'timeout';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);
      expect(result.error?.message).toContain('ETIMEDOUT');

      const intent = await readIntent(intentId);
      // The critical assertion: unknown is not failure.
      expect(intent.status).toBe('submitting');
      expect(intent.status).not.toBe('failed');
      expect(intent.failure_reason).toBeNull();
      // The durable handle needed for recovery was persisted before the call.
      expect(intent.provider_authorization_id).toBe('auth_1');
    });
  });

  describe('provider failure — outcome known', () => {
    it('a declined authorization is a definite failure', async () => {
      const intentId = await createReadyIntent('plaid_declined_key');
      authorizationDecision = 'declined';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('failed');
      expect(intent.failure_reason).toContain('Insufficient funds');
      // No transfer was ever created, so nothing to reconcile.
      expect(intent.provider_reference_id).toBeNull();
      expect(plaidCalls.creates).toHaveLength(0);
    });
  });

  describe('provider success then database failure', () => {
    /**
     * Simulates: Plaid creates the transfer, then the local write that records
     * the reference never lands (crash, connection loss, deploy). The provider
     * transfer exists; the database does not know its id.
     */
    async function simulateProviderSuccessWithLostWrite(intentId: number) {
      transferCreateBehaviour = 'timeout';
      await execute(intentId);           // persists the authorization, then "fails"
      transferCreateBehaviour = 'ok';
      const intent = await readIntent(intentId);
      // The transfer really does exist provider-side against this authorization.
      providerTransfers.set(intent.provider_authorization_id as string, 'plaid_transfer_orphan');
      return intent;
    }

    it('leaves a recoverable state with no false failure', async () => {
      const intentId = await createReadyIntent('plaid_lostwrite_key');
      const intent = await simulateProviderSuccessWithLostWrite(intentId);

      expect(intent.status).toBe('submitting');
      expect(intent.provider_authorization_id).not.toBeNull();
      expect(intent.provider_reference_id).toBeNull();
    });

    it('reconciliation discovers the existing transfer without creating a duplicate', async () => {
      const intentId = await createReadyIntent('plaid_recover_key');
      await simulateProviderSuccessWithLostWrite(intentId);

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('recovered');
      expect(outcome.provider_reference_id).toBe('plaid_transfer_orphan');

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      expect(intent.provider_reference_id).toBe('plaid_transfer_orphan');

      // Recovery replayed against the same authorization, so the provider still
      // holds exactly one transfer.
      expect(providerTransfers.size).toBe(1);
    });

    it('a retry after the lost write also recovers rather than duplicating', async () => {
      const intentId = await createReadyIntent('plaid_retry_key');
      await simulateProviderSuccessWithLostWrite(intentId);

      // Ordinary re-execution, not reconciliation.
      const retry = await execute(intentId);

      expect(retry.submitted).toBe(true);
      expect(retry.transferId).toBe('plaid_transfer_orphan');
      expect(providerTransfers.size).toBe(1);
      // No second authorization was created — the persisted one was reused.
      expect(plaidCalls.authorizations).toHaveLength(1);
    });

    it('reconciling an intent that never reached the provider returns it to ready', async () => {
      const intentId = await createReadyIntent('plaid_neversent_key');
      // `submitting` with no authorization: the provider was never asked.
      await sql`
        UPDATE transfer_intents SET status = 'submitting' WHERE id = ${intentId}
      `;

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('never_submitted');
      expect((await readIntent(intentId)).status).toBe('ready');
      expect(plaidCalls.creates).toHaveLength(0);
    });

    it('reconciling an already-recorded transfer is a no-op', async () => {
      const intentId = await createReadyIntent('plaid_noop_key');
      await execute(intentId);

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);
      expect(outcome.outcome).toBe('already_recorded');
      expect(providerTransfers.size).toBe(1);
    });
  });

  describe('webhook race', () => {
    /**
     * The Plaid webhook locates an intent by provider_reference_id. These tests
     * cover both orderings around the local write, plus a duplicate delivery.
     */
    async function webhookLookup(transferId: string) {
      const rows = await sql`
        SELECT id, status FROM transfer_intents WHERE provider_reference_id = ${transferId}
      `;
      return rows[0] ?? null;
    }

    it('webhook arriving BEFORE local persistence finds nothing, and reconciliation repairs it', async () => {
      const intentId = await createReadyIntent('plaid_webhook_early_key');
      await simulateEarlyWebhookWindow(intentId);

      // At this moment the provider has the transfer but we have no reference,
      // so a webhook cannot match — the intent must remain recoverable.
      expect(await webhookLookup('plaid_transfer_orphan')).toBeNull();
      expect((await readIntent(intentId)).status).toBe('submitting');

      await provider.reconcileTransfer(intentId, USER_ID);

      // After reconciliation the same webhook resolves correctly.
      const matched = await webhookLookup('plaid_transfer_orphan');
      expect(matched).not.toBeNull();
      expect(matched.id).toBe(intentId);
    });

    it('webhook arriving AFTER local persistence resolves immediately', async () => {
      const intentId = await createReadyIntent('plaid_webhook_late_key');
      const result = await execute(intentId);

      const matched = await webhookLookup(result.transferId as string);
      expect(matched).not.toBeNull();
      expect(matched.id).toBe(intentId);
      expect(matched.status).toBe('processing');
    });

    it('a duplicate webhook resolves to the same single intent', async () => {
      const intentId = await createReadyIntent('plaid_webhook_dup_key');
      const result = await execute(intentId);

      const transferId = result.transferId;
      expect(transferId).toBeDefined();
      if (!transferId) return;

      const first = await webhookLookup(transferId);
      const second = await webhookLookup(transferId);

      expect(first.id).toBe(intentId);
      expect(second.id).toBe(intentId);

      // provider_reference_id is uniquely indexed, so a transfer id can never
      // fan out to two intents and be settled twice.
      const all = await sql`
        SELECT COUNT(*)::int AS n FROM transfer_intents
        WHERE provider_reference_id = ${transferId}
      `;
      expect(all[0].n).toBe(1);
    });

    async function simulateEarlyWebhookWindow(intentId: number) {
      transferCreateBehaviour = 'timeout';
      await execute(intentId);
      transferCreateBehaviour = 'ok';
      const intent = await readIntent(intentId);
      providerTransfers.set(intent.provider_authorization_id as string, 'plaid_transfer_orphan');
    }
  });

  describe('database guarantees', () => {
    it('the same provider reference cannot be attached to two intents', async () => {
      const a = await createReadyIntent('plaid_unique_a');
      const b = await createReadyIntent('plaid_unique_b');

      await sql`UPDATE transfer_intents SET provider_reference_id = 'shared_ref' WHERE id = ${a}`;
      await expect(
        sql`UPDATE transfer_intents SET provider_reference_id = 'shared_ref' WHERE id = ${b}`,
      ).rejects.toThrow();
    });

    it('the same idempotency key cannot be reused by two intents', async () => {
      await createReadyIntent('plaid_shared_idem');
      await expect(createReadyIntent('plaid_shared_idem')).rejects.toThrow();
    });
  });
});
