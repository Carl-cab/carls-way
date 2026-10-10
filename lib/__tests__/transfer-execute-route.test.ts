/**
 * POST /api/transfers/[id]/execute
 *
 * Runs against PostgreSQL. The property under test is the claim: two
 * concurrent requests for one ready live intent must not both reach the
 * provider. The provider itself is mocked so the test does not depend on
 * Plaid or Stripe, and the live flags are left unset so the real factory
 * cannot select a live provider.
 */
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { getSql, initializeSchema } from '@/lib/db';
import { signToken } from '@/lib/auth';
import { RATE_LIMITS, __resetInMemoryCounters } from '@/lib/rate-limit';

const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));

const providerControl = vi.hoisted(() => ({
  mode: 'mock' as 'mock' | 'real',
  executionMode: 'live' as 'live' | 'sandbox',
  execute: vi.fn<(intentId: number, userId: number) => Promise<never>>(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name !== 'manna-token' || !cookieValue.current) return undefined;
      return { name, value: cookieValue.current };
    },
  }),
}));

vi.mock('@/lib/providers/TransferProviderFactory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/TransferProviderFactory')>();
  return {
    ...actual,
    getTransferProvider: (region: 'US' | 'CA', mode: 'sandbox' | 'live') => {
      if (providerControl.mode === 'real') {
        return actual.getTransferProvider(region, mode);
      }
      return {
        providerName: region === 'US' ? 'plaid_transfer' : 'canadian_eft',
        providerRegion: region,
        executionMode: providerControl.executionMode,
        executeTransfer: providerControl.execute,
      };
    },
  };
});

import { POST } from '@/app/api/transfers/[id]/execute/route';

const sql = getSql();
const OWNER_EMAIL = 'execute-owner@example.test';
const OTHER_EMAIL = 'execute-other@example.test';

let ownerId: number;
let otherId: number;

function tokenFor(userId: number, email: string, username: string): string {
  return signToken({ userId, email, username, tv: 0 });
}

function call(id: number | string) {
  return POST(new Request('http://localhost/api/transfers/' + id + '/execute', { method: 'POST' }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

async function insertIntent(overrides: {
  userId?: number;
  status?: string;
  executionMode?: string;
  region?: string;
}): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO transfer_intents (
      user_id, type, amount, currency, status,
      provider_region, provider_name, execution_mode
    ) VALUES (
      ${overrides.userId ?? ownerId},
      'add_money',
      25.00,
      ${overrides.region === 'CA' ? 'CAD' : 'USD'},
      ${overrides.status ?? 'ready'},
      ${overrides.region ?? 'US'},
      ${overrides.region === 'CA' ? 'canadian_eft' : 'plaid_transfer'},
      ${overrides.executionMode ?? 'live'}
    )
    RETURNING id
  `;
  return rows[0].id;
}

async function statusOf(id: number): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM transfer_intents WHERE id = ${id}
  `;
  return rows[0].status;
}

beforeAll(async () => {
  process.env.JWT_SECRET ??= 'execute-route-test-secret';
  delete process.env.PLAID_TRANSFER_LIVE;
  delete process.env.CA_EFT_LIVE;
  await initializeSchema();
  await sql`DELETE FROM transfer_intents WHERE user_id IN (
    SELECT id FROM users WHERE email IN (${OWNER_EMAIL}, ${OTHER_EMAIL})
  )`;
  await sql`DELETE FROM users WHERE email IN (${OWNER_EMAIL}, ${OTHER_EMAIL})`;

  const owner = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country, token_version)
    VALUES ('Execute Owner', 'execute_owner', ${OWNER_EMAIL}, 'x', 'US', 0)
    RETURNING id
  `;
  const other = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country, token_version)
    VALUES ('Execute Other', 'execute_other', ${OTHER_EMAIL}, 'x', 'US', 0)
    RETURNING id
  `;
  ownerId = owner[0].id;
  otherId = other[0].id;
}, 60000);

beforeEach(() => {
  // The execute route is rate limited per user id. Without this the
  // in-process counter accumulates across cases in this file and a later
  // case 429s for reasons that have nothing to do with what it asserts.
  __resetInMemoryCounters();
  cookieValue.current = tokenFor(ownerId, OWNER_EMAIL, 'execute_owner');
  providerControl.mode = 'mock';
  providerControl.executionMode = 'live';
  providerControl.execute.mockReset();
  providerControl.execute.mockImplementation(async () => {
    throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
      __submitted: true,
      status: 'processing',
      plaid_transfer_id: 'plaid_transfer_test',
    });
  });
  delete process.env.PLAID_TRANSFER_LIVE;
  delete process.env.CA_EFT_LIVE;
});

afterAll(async () => {
  await sql`DELETE FROM transfer_intents WHERE user_id IN (${ownerId}, ${otherId})`;
  await sql`DELETE FROM users WHERE id IN (${ownerId}, ${otherId})`;
}, 60000);

describe('POST /api/transfers/[id]/execute', () => {
  it('rejects an unauthenticated caller', async () => {
    cookieValue.current = undefined;
    const id = await insertIntent({});
    const res = await call(id);
    expect(res.status).toBe(401);
    expect(providerControl.execute).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe('ready');
  });

  it('rejects a caller who does not own the intent', async () => {
    const id = await insertIntent({ userId: otherId });
    const res = await call(id);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: 'You do not have access to this transfer',
    });
    expect(providerControl.execute).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe('ready');
  });

  it('rejects an intent that is not ready', async () => {
    const id = await insertIntent({ status: 'draft' });
    const res = await call(id);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("status 'draft'");
    expect(providerControl.execute).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe('draft');
  });

  it('rejects an intent that is not live', async () => {
    const id = await insertIntent({ executionMode: 'sandbox' });
    const res = await call(id);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('sandbox');
    expect(providerControl.execute).not.toHaveBeenCalled();
    expect(await statusOf(id)).toBe('ready');
  });

  it('does not call the provider when the live flags are off', async () => {
    providerControl.mode = 'real';
    const id = await insertIntent({});
    const res = await call(id);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Live transfers are not enabled. No funds were moved.',
    });
    expect(await statusOf(id)).toBe('ready');
    expect(process.env.PLAID_TRANSFER_LIVE).toBeUndefined();
    expect(process.env.CA_EFT_LIVE).toBeUndefined();
  });

  it('executes a ready live intent and reports processing', async () => {
    const id = await insertIntent({});
    const res = await call(id);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      intent_id: id,
      status: 'processing',
      provider_reference_id: 'plaid_transfer_test',
    });
    expect(providerControl.execute).toHaveBeenCalledTimes(1);
    expect(providerControl.execute).toHaveBeenCalledWith(id, ownerId);
    expect(await statusOf(id)).toBe('processing');
  });

  it('lets only one of two concurrent submits call the provider', async () => {
    const id = await insertIntent({});
    let inFlight = 0;
    let maxInFlight = 0;
    providerControl.execute.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 80));
      inFlight -= 1;
      throw Object.assign(new Error('__TRANSFER_SUBMITTED__'), {
        __submitted: true,
        status: 'processing',
        plaid_transfer_id: 'plaid_transfer_once',
      });
    });

    const [first, second] = await Promise.all([call(id), call(id)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(providerControl.execute).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    const loser = first.status === 409 ? first : second;
    const body = await loser.json();
    expect(body.error).toContain('submitting');
    expect(await statusOf(id)).toBe('processing');
  });
});

describe('rate limiting', () => {
  it('stops submitting at the limit, and moves nothing when it refuses', async () => {
    // Every other money path carries a limit; this one reached a payment rail
    // with none. The claim prevents one intent being submitted twice, so this
    // covers the orthogonal case the claim says nothing about: one account
    // pushing many separate intents at a rail in a burst.
    const rule = RATE_LIMITS['money:transfer-execute'];
    const ids: number[] = [];
    for (let i = 0; i < rule.limit; i++) ids.push(await insertIntent({}));
    const overflowId = await insertIntent({});

    for (const id of ids) {
      expect((await call(id)).status).toBe(200);
    }
    expect(providerControl.execute).toHaveBeenCalledTimes(rule.limit);

    const refused = await call(overflowId);
    expect(refused.status).toBe(429);
    await expect(refused.json()).resolves.toMatchObject({
      error: expect.stringContaining('No funds were moved'),
    });

    // The refusal must come before the provider and before the claim: the
    // intent stays ready rather than stranded in submitting.
    expect(providerControl.execute).toHaveBeenCalledTimes(rule.limit);
    expect(await statusOf(overflowId)).toBe('ready');
  }, 60000);

  it('limits per account, so one user cannot exhaust another', async () => {
    const rule = RATE_LIMITS['money:transfer-execute'];
    for (let i = 0; i < rule.limit; i++) {
      expect((await call(await insertIntent({}))).status).toBe(200);
    }
    expect((await call(await insertIntent({}))).status).toBe(429);

    // A different account is unaffected: the key is the user id, not the IP,
    // which an IP-keyed limit would get wrong on a shared network.
    cookieValue.current = tokenFor(otherId, OTHER_EMAIL, 'execute_other');
    const othersIntent = await insertIntent({ userId: otherId });
    expect((await call(othersIntent)).status).toBe(200);
  }, 60000);
});

describe('status reporting', () => {
  it('names the status it actually found, never a contradiction', async () => {
    // The claim's defensive branch reported the literal 'ready', producing
    // "Cannot execute a transfer in status 'ready'. It must be ready." in front
    // of whoever was debugging a live transfer.
    const id = await insertIntent({ status: 'processing' });

    const res = await call(id);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("'processing'");
    expect(body.error).not.toContain("status 'ready'");
  }, 60000);
});
