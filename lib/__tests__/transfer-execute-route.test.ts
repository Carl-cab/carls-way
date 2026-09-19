/**
 * POST /api/transfers/[id]/execute — route-level tests.
 *
 * The provider boundary (Plaid/Stripe idempotency, authorization recovery,
 * webhook races) is already covered by transfer-execution-safety.test.ts and
 * canadian-eft-safety.test.ts. These tests cover the route's own
 * responsibilities instead: ownership checks, status gating, the
 * live-only gate, and the double-submit idempotency guard — so the provider
 * is replaced with a controllable fake and never contacts Plaid or Stripe.
 */
import { getSql, initializeSchema } from '../db';

let currentUserId: number | null = null;

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth')>();
  return {
    ...actual,
    getAuthUser: async () => (currentUserId === null ? null : { userId: currentUserId }),
    auditLog: async () => {},
  };
});

type ExecBehavior = 'submit' | 'sandbox-throw';
let execBehavior: ExecBehavior = 'submit';
let executeCallCount = 0;
// Monotonic across the whole file (never reset per-test) so two tests can
// never generate the same fake reference — provider_reference_id is
// uniquely indexed in the schema, just as it is for the real providers.
let refSeq = 0;

vi.mock('@/lib/transfers/router', () => ({
  getTransferProvider: () => ({
    executeTransfer: async () => {
      executeCallCount += 1;
      if (execBehavior === 'submit') {
        refSeq += 1;
        throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
          __submitted: true,
          plaid_transfer_id: `plaid_test_ref_${refSeq}`,
        });
      }
      // Mirrors what SandboxUSProvider/SandboxCAProvider actually throw.
      throw new Error('SandboxUSProvider does not support live execution. Switch to PlaidTransferProvider for real transfers.');
    },
  }),
  toExecutionMode: (value: string | null | undefined) => (value === 'live' ? 'live' : 'sandbox'),
}));

const { POST } = await import('../../app/api/transfers/[id]/execute/route');

const sql = getSql();
const OWNER_ID = 8801;
const OTHER_USER_ID = 8802;

async function makeUser(id: number, username: string) {
  await sql`
    INSERT INTO users (id, name, username, email, password_hash, country, balance_cad, balance_usd)
    VALUES (${id}, 'Test User', ${username}, ${username + '@test.com'}, 'hash', 'US', 0, 100)
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createIntent(opts: {
  userId: number;
  status: string;
  executionMode: 'sandbox' | 'live';
  providerReferenceId?: string | null;
}): Promise<number> {
  const rows = await sql`
    INSERT INTO transfer_intents (
      user_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode, provider_reference_id
    ) VALUES (
      ${opts.userId}, 'add_money', 25.00, 'USD', ${opts.status},
      'US', ${opts.executionMode === 'live' ? 'plaid_transfer' : 'sandbox_us'}, ${opts.executionMode},
      ${opts.providerReferenceId ?? null}
    )
    RETURNING id
  `;
  return rows[0].id as number;
}

async function readIntent(intentId: number) {
  const rows = await sql`
    SELECT status, provider_reference_id FROM transfer_intents WHERE id = ${intentId}
  `;
  return rows[0] as { status: string; provider_reference_id: string | null };
}

function callExecute(intentId: number | string) {
  const req = new Request(`http://localhost/api/transfers/${intentId}/execute`, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id: String(intentId) }) });
}

beforeAll(async () => {
  await initializeSchema();
  await makeUser(OWNER_ID, 'exec_owner');
  await makeUser(OTHER_USER_ID, 'exec_other');
});

beforeEach(() => {
  currentUserId = OWNER_ID;
  execBehavior = 'submit';
  executeCallCount = 0;
});

afterAll(async () => {
  await sql`DELETE FROM transfer_intents WHERE user_id IN (${OWNER_ID}, ${OTHER_USER_ID})`;
  await sql`DELETE FROM users WHERE id IN (${OWNER_ID}, ${OTHER_USER_ID})`;
});

describe('POST /api/transfers/[id]/execute', () => {
  it('happy path: a ready live intent moves to processing and records the provider reference', async () => {
    const intentId = await createIntent({ userId: OWNER_ID, status: 'ready', executionMode: 'live' });

    const res = await callExecute(intentId);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      intent_id: intentId,
      status: 'processing',
    });
    expect(body.provider_reference_id).toMatch(/^plaid_test_ref_\d+$/);
    expect(executeCallCount).toBe(1);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('processing');
    expect(intent.provider_reference_id).toBe(body.provider_reference_id);
  });

  it('returns 404 when the intent does not exist', async () => {
    const res = await callExecute(999999999);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns 403 when the authenticated user does not own the intent', async () => {
    const intentId = await createIntent({ userId: OWNER_ID, status: 'ready', executionMode: 'live' });
    currentUserId = OTHER_USER_ID;

    const res = await callExecute(intentId);
    expect(res.status).toBe(403);
    expect(executeCallCount).toBe(0);

    // Ownership violation must not mutate the intent.
    const intent = await readIntent(intentId);
    expect(intent.status).toBe('ready');
  });

  it('returns 409 when the intent is not in ready status', async () => {
    const intentId = await createIntent({ userId: OWNER_ID, status: 'draft', executionMode: 'live' });

    const res = await callExecute(intentId);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('draft');
    expect(executeCallCount).toBe(0);
  });

  it('returns 400 when the intent is not live (sandbox execution_mode)', async () => {
    const intentId = await createIntent({ userId: OWNER_ID, status: 'ready', executionMode: 'sandbox' });

    const res = await callExecute(intentId);
    expect(res.status).toBe(400);
    expect(executeCallCount).toBe(0);

    const intent = await readIntent(intentId);
    expect(intent.status).toBe('ready');
  });

  it('propagates a sandbox-style provider throw as a 502, not a swallowed error', async () => {
    // execution_mode is 'live' so the route reaches the provider call; the
    // fake provider then throws the same way SandboxUSProvider does when a
    // live flag was disabled after the intent was created.
    execBehavior = 'sandbox-throw';
    const intentId = await createIntent({ userId: OWNER_ID, status: 'ready', executionMode: 'live' });

    const res = await callExecute(intentId);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('does not support live execution');

    // A failed submission attempt must not be recorded as processing.
    const intent = await readIntent(intentId);
    expect(intent.status).toBe('ready');
    expect(intent.provider_reference_id).toBeNull();
  });

  it('a double-submit is idempotent: the second call returns the existing state without re-executing', async () => {
    const intentId = await createIntent({ userId: OWNER_ID, status: 'ready', executionMode: 'live' });

    const first = await callExecute(intentId);
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(executeCallCount).toBe(1);

    const second = await callExecute(intentId);
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({
      success: true,
      intent_id: intentId,
      status: 'processing',
      provider_reference_id: firstBody.provider_reference_id,
    });
    // The provider was not called again — no second transfer was created.
    expect(executeCallCount).toBe(1);
  });

  it('a double-submit already recorded via a different reference short-circuits before calling the provider', async () => {
    const intentId = await createIntent({
      userId: OWNER_ID,
      status: 'processing',
      executionMode: 'live',
      providerReferenceId: 'plaid_preexisting_ref',
    });

    const res = await callExecute(intentId);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.provider_reference_id).toBe('plaid_preexisting_ref');
    expect(executeCallCount).toBe(0);
  });
});
