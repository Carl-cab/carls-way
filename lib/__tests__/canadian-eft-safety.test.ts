/**
 * Phase 3 — Canadian ACSS (Stripe) transfer execution safety.
 *
 * ACSS semantics are NOT the same as Plaid's, and these tests are written to the
 * real differences rather than to an assumed symmetry:
 *
 *   - There is no separate authorization step. paymentIntents.create({confirm})
 *     and payouts.create are each a single money-moving call, so there is no
 *     authorization that can be orphaned — and no pre-call provider handle to
 *     persist. Protection is Stripe's request-level idempotency key.
 *   - Stripe idempotency is a request OPTION (second argument), not a body field.
 *   - paymentIntents.search exists, so add_money can be reconciled by an
 *     authoritative provider lookup on metadata. payouts has NO search, so
 *     cash_out can only be recovered by an idempotent replay.
 *
 * The Stripe SDK is mocked; no live flag is set and no real money moves.
 */

import { getSql } from '../db';

interface StripeCall { idempotencyKey?: string }

const stripeCalls = {
  paymentIntents: [] as StripeCall[],
  payouts: [] as StripeCall[],
  reset() { this.paymentIntents = []; this.payouts = []; },
};

/** Objects the fake Stripe account holds, keyed by idempotency key. */
const stripeObjects = new Map<string, string>();
/** PaymentIntents indexed by manna_intent_id metadata, for the search path. */
const byIntentMetadata = new Map<string, string>();

let behaviour: 'ok' | 'timeout' | 'card_error' = 'ok';
let piSeq = 0;
let poSeq = 0;

vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    customers: { create: async () => ({ id: 'cus_test' }) },
    paymentIntents: {
      create: async (
        params: { metadata: { manna_intent_id: string } },
        opts?: { idempotencyKey?: string },
      ) => {
        stripeCalls.paymentIntents.push({ idempotencyKey: opts?.idempotencyKey });
        if (behaviour === 'timeout') throw new Error('ETIMEDOUT: stripe did not respond');
        if (behaviour === 'card_error') {
          throw Object.assign(new Error('Your bank account could not be debited'), {
            type: 'StripeCardError',
          });
        }
        const key = opts?.idempotencyKey ?? '';
        // Stripe replays the original response for a repeated idempotency key.
        const existing = stripeObjects.get(key);
        if (existing) return { id: existing };
        piSeq += 1;
        const id = `pi_${piSeq}`;
        stripeObjects.set(key, id);
        byIntentMetadata.set(params.metadata.manna_intent_id, id);
        return { id };
      },
      search: async ({ query }: { query: string }) => {
        const match = /manna_intent_id'\]\s*:\s*'(\d+)'/.exec(query);
        const intentId = match?.[1];
        const found = intentId ? byIntentMetadata.get(intentId) : undefined;
        return { data: found ? [{ id: found }] : [] };
      },
    },
    payouts: {
      create: async (
        _params: unknown,
        opts?: { idempotencyKey?: string },
      ) => {
        stripeCalls.payouts.push({ idempotencyKey: opts?.idempotencyKey });
        if (behaviour === 'timeout') throw new Error('ETIMEDOUT: stripe did not respond');
        const key = opts?.idempotencyKey ?? '';
        const existing = stripeObjects.get(key);
        if (existing) return { id: existing };
        poSeq += 1;
        const id = `po_${poSeq}`;
        stripeObjects.set(key, id);
        return { id };
      },
    },
  }),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  return { ...actual, auditLog: async () => {} };
});

const { CanadianEFTProvider } = await import('../providers/CanadianEFTProvider');

const USER_ID = 9002;
const BANK_ACCOUNT_ID = 9002;

const sql = getSql();
const provider = new CanadianEFTProvider();

async function createReadyIntent(
  type: 'add_money' | 'cash_out' = 'add_money',
  idempotencyKey: string | null = null,
): Promise<number> {
  const rows = await sql`
    INSERT INTO transfer_intents (
      user_id, bank_account_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, idempotency_key
    ) VALUES (
      ${USER_ID}, ${BANK_ACCOUNT_ID}, ${type}, 40.00, 'CAD', 'ready',
      'CA', 'canadian_eft', 'live', ${idempotencyKey}
    )
    RETURNING id
  `;
  return rows[0].id as number;
}

async function readIntent(intentId: number) {
  const rows = await sql`
    SELECT status, idempotency_key, provider_reference_id, failure_reason
    FROM transfer_intents WHERE id = ${intentId}
  `;
  return rows[0] as {
    status: string;
    idempotency_key: string | null;
    provider_reference_id: string | null;
    failure_reason: string | null;
  };
}

async function execute(intentId: number): Promise<{
  submitted: boolean; referenceId?: string; idempotencyKey?: string; error?: Error;
}> {
  try {
    await provider.executeTransfer(intentId, USER_ID);
    return { submitted: false };
  } catch (err) {
    const e = err as Error & {
      __submitted?: boolean; stripe_reference_id?: string; idempotency_key?: string;
    };
    if (e.__submitted) {
      return { submitted: true, referenceId: e.stripe_reference_id, idempotencyKey: e.idempotency_key };
    }
    return { submitted: false, error: e };
  }
}

beforeAll(async () => {
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, kyc_status)
    VALUES (${USER_ID}, 'CA Test User', 'catest9002', 'ca9002@example.test',
            'not-a-real-hash', 'CA', 'verified')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO bank_accounts (id, user_id, institution_name, account_name,
                               stripe_payment_method_id, currency, country,
                               is_token_encrypted, is_verified)
    VALUES (${BANK_ACCOUNT_ID}, ${USER_ID}, 'Test CA Bank', 'Chequing',
            'pm_test_acss', 'CAD', 'CA', true, true)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    UPDATE users SET stripe_customer_id = 'cus_test' WHERE id = ${USER_ID}
  `;
});

beforeEach(async () => {
  stripeCalls.reset();
  stripeObjects.clear();
  byIntentMetadata.clear();
  behaviour = 'ok';
  piSeq = 0;
  poSeq = 0;
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql`DELETE FROM transfer_intents WHERE user_id = ${USER_ID}`;
});

describe('Canadian ACSS transfer safety', () => {
  describe('normal submission', () => {
    it('persists a stable key, sends it as a Stripe request option, and records the reference', async () => {
      const intentId = await createReadyIntent('add_money');

      const result = await execute(intentId);
      expect(result.submitted).toBe(true);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      expect(intent.provider_reference_id).toBe(result.referenceId);
      expect(intent.failure_reason).toBeNull();
      // Derived from the durable intent id — not Date.now(), not a request id.
      expect(intent.idempotency_key).toBe(`manna_intent_${intentId}`);

      // Sent as a request option with the operation suffix.
      expect(stripeCalls.paymentIntents).toHaveLength(1);
      expect(stripeCalls.paymentIntents[0].idempotencyKey).toBe(`manna_intent_${intentId}:pi`);
    });

    it('uses a distinct key suffix for payouts so the two request shapes cannot collide', async () => {
      const intentId = await createReadyIntent('cash_out');
      await execute(intentId);

      expect(stripeCalls.payouts).toHaveLength(1);
      expect(stripeCalls.payouts[0].idempotencyKey).toBe(`manna_intent_${intentId}:po`);
    });
  });

  describe('duplicate submission', () => {
    it('executing twice reuses the key and creates no second Stripe object', async () => {
      const intentId = await createReadyIntent('add_money');

      const first = await execute(intentId);
      const second = await execute(intentId);

      expect(first.submitted).toBe(true);
      expect(second.submitted).toBe(true);
      expect(second.referenceId).toBe(first.referenceId);
      expect(stripeCalls.paymentIntents).toHaveLength(1);
      expect(stripeObjects.size).toBe(1);
    });

    it('a reload from the database yields the same key (survives process restart)', async () => {
      const intentId = await createReadyIntent('add_money');
      await execute(intentId);
      const first = await readIntent(intentId);

      const freshProvider = new CanadianEFTProvider();
      try { await freshProvider.executeTransfer(intentId, USER_ID); } catch { /* tagged */ }

      const second = await readIntent(intentId);
      expect(second.idempotency_key).toBe(first.idempotency_key);
      expect(second.provider_reference_id).toBe(first.provider_reference_id);
      expect(stripeObjects.size).toBe(1);
    });
  });

  describe('concurrent submission', () => {
    it('two simultaneous executions produce one Stripe object', async () => {
      const intentId = await createReadyIntent('add_money');

      await Promise.all([execute(intentId), execute(intentId)]);

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('processing');
      // The transactional claim serialises the two callers.
      expect(stripeObjects.size).toBe(1);
      expect(stripeCalls.paymentIntents.length).toBeLessThanOrEqual(1);
    });
  });

  describe('provider timeout — outcome unknown', () => {
    it('does NOT mark the transfer failed and leaves it reconcilable', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'timeout';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);
      expect(result.error?.message).toContain('ETIMEDOUT');

      const intent = await readIntent(intentId);
      // Unknown is not failure.
      expect(intent.status).toBe('submitting');
      expect(intent.status).not.toBe('failed');
      expect(intent.failure_reason).toBeNull();
      // The key needed for an idempotent replay is persisted.
      expect(intent.idempotency_key).toBe(`manna_intent_${intentId}`);
    });
  });

  describe('provider failure — outcome known', () => {
    it('a rejected debit surfaces the error and leaves the intent recoverable, not falsely settled', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'card_error';

      const result = await execute(intentId);
      expect(result.submitted).toBe(false);
      expect(result.error?.message).toContain('could not be debited');

      const intent = await readIntent(intentId);
      expect(intent.provider_reference_id).toBeNull();
      expect(intent.status).not.toBe('processing');
      expect(intent.status).not.toBe('settled');
    });
  });

  describe('provider success then database failure', () => {
    /** Stripe created the object; the local write recording it never landed. */
    async function simulateLostWrite(intentId: number, type: 'add_money' | 'cash_out') {
      behaviour = 'timeout';
      await execute(intentId);              // persists the key, then "fails"
      behaviour = 'ok';
      const suffix = type === 'add_money' ? 'pi' : 'po';
      const key = `manna_intent_${intentId}:${suffix}`;
      const id = type === 'add_money' ? 'pi_orphan' : 'po_orphan';
      stripeObjects.set(key, id);
      if (type === 'add_money') byIntentMetadata.set(String(intentId), id);
      return id;
    }

    it('leaves a recoverable state with no false failure', async () => {
      const intentId = await createReadyIntent('add_money');
      await simulateLostWrite(intentId, 'add_money');

      const intent = await readIntent(intentId);
      expect(intent.status).toBe('submitting');
      expect(intent.provider_reference_id).toBeNull();
      expect(intent.failure_reason).toBeNull();
    });

    it('add_money reconciles by authoritative provider lookup on metadata', async () => {
      const intentId = await createReadyIntent('add_money');
      const orphan = await simulateLostWrite(intentId, 'add_money');

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('recovered');
      expect(outcome.provider_reference_id).toBe(orphan);
      expect((await readIntent(intentId)).status).toBe('processing');
      expect(stripeObjects.size).toBe(1);
    });

    it('cash_out reconciles by idempotent replay (payouts has no search API)', async () => {
      const intentId = await createReadyIntent('cash_out');
      const orphan = await simulateLostWrite(intentId, 'cash_out');

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('recovered_by_replay');
      expect(outcome.provider_reference_id).toBe(orphan);
      // The replay returned the original payout rather than creating a second.
      expect(stripeObjects.size).toBe(1);
    });

    it('an ordinary retry after the lost write also recovers rather than duplicating', async () => {
      const intentId = await createReadyIntent('add_money');
      const orphan = await simulateLostWrite(intentId, 'add_money');

      const retry = await execute(intentId);

      expect(retry.submitted).toBe(true);
      expect(retry.referenceId).toBe(orphan);
      expect(stripeObjects.size).toBe(1);
    });

    it('reconciling an add_money intent that never reached Stripe returns it to ready', async () => {
      const intentId = await createReadyIntent('add_money');
      await sql`UPDATE transfer_intents SET status = 'submitting' WHERE id = ${intentId}`;

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);

      expect(outcome.outcome).toBe('never_submitted');
      expect((await readIntent(intentId)).status).toBe('ready');
    });

    it('reconciling an already-recorded transfer is a no-op', async () => {
      const intentId = await createReadyIntent('add_money');
      await execute(intentId);

      const outcome = await provider.reconcileTransfer(intentId, USER_ID);
      expect(outcome.outcome).toBe('already_recorded');
      expect(stripeObjects.size).toBe(1);
    });
  });

  describe('webhook race', () => {
    async function webhookLookup(reference: string) {
      const rows = await sql`
        SELECT id, status FROM transfer_intents WHERE provider_reference_id = ${reference}
      `;
      return rows[0] ?? null;
    }

    it('webhook BEFORE local persistence finds nothing; reconciliation repairs it', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'timeout';
      await execute(intentId);
      behaviour = 'ok';
      stripeObjects.set(`manna_intent_${intentId}:pi`, 'pi_orphan');
      byIntentMetadata.set(String(intentId), 'pi_orphan');

      // No reference persisted yet, so the event cannot match and must not
      // drive a state transition.
      expect(await webhookLookup('pi_orphan')).toBeNull();
      expect((await readIntent(intentId)).status).toBe('submitting');

      await provider.reconcileTransfer(intentId, USER_ID);

      const matched = await webhookLookup('pi_orphan');
      expect(matched).not.toBeNull();
      expect(matched.id).toBe(intentId);
    });

    it('webhook AFTER local persistence resolves immediately', async () => {
      const intentId = await createReadyIntent('add_money');
      const result = await execute(intentId);

      const matched = await webhookLookup(result.referenceId as string);
      expect(matched.id).toBe(intentId);
      expect(matched.status).toBe('processing');
    });

    it('a duplicate webhook resolves to the same single intent', async () => {
      const intentId = await createReadyIntent('add_money');
      const result = await execute(intentId);
      const reference = result.referenceId;
      expect(reference).toBeDefined();
      if (!reference) return;

      expect((await webhookLookup(reference)).id).toBe(intentId);
      expect((await webhookLookup(reference)).id).toBe(intentId);

      const count = await sql`
        SELECT COUNT(*)::int AS n FROM transfer_intents
        WHERE provider_reference_id = ${reference}
      `;
      expect(count[0].n).toBe(1);
    });

    it('an event arriving after reconciliation converges to the same state', async () => {
      const intentId = await createReadyIntent('add_money');
      behaviour = 'timeout';
      await execute(intentId);
      behaviour = 'ok';
      stripeObjects.set(`manna_intent_${intentId}:pi`, 'pi_orphan');
      byIntentMetadata.set(String(intentId), 'pi_orphan');

      await provider.reconcileTransfer(intentId, USER_ID);
      const afterReconcile = await readIntent(intentId);

      // A late event resolves to the same intent and the same reference.
      const matched = await webhookLookup('pi_orphan');
      expect(matched.id).toBe(intentId);
      expect(afterReconcile.provider_reference_id).toBe('pi_orphan');
      expect(afterReconcile.status).toBe('processing');
    });
  });

  describe('cross-provider reference isolation', () => {
    it('one external reference cannot be attached to two intents', async () => {
      const a = await createReadyIntent('add_money');
      const b = await createReadyIntent('add_money');

      await sql`UPDATE transfer_intents SET provider_reference_id = 'pi_shared' WHERE id = ${a}`;
      await expect(
        sql`UPDATE transfer_intents SET provider_reference_id = 'pi_shared' WHERE id = ${b}`,
      ).rejects.toThrow();
    });
  });
});
