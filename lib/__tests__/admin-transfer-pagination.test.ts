import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getSql, initializeSchema } from '@/lib/db';

/**
 * Pagination for the admin transfer search.
 *
 * The defect these cover was invisible from the response shape. The query ran
 * with no LIMIT or OFFSET and the first `limit` rows were sliced client-side, so
 * every page returned page 1 while `page` and `total_count` came back looking
 * correct. A reviewer reading the response would see page 2 and believe it.
 *
 * Asserting "page 2 differs from page 1" is therefore the only assertion that
 * catches it; checking page numbers or counts would have passed throughout.
 *
 * Runs against real PostgreSQL: the bug is in SQL that was never issued, which
 * a mocked driver cannot show.
 */

// checkPermission reads admin context from a request-scoped store that does not
// exist outside a route, so it is stubbed to allow. Authorization is covered by
// lib/__tests__/rbac.test.ts; this file is about the SQL.
vi.mock('@/lib/rbac', () => ({
  checkPermission: () => true,
  maskSensitiveFields: <T,>(x: T) => x,
}));

const sql = getSql();
const TOTAL = 12;
const PAGE_SIZE = 5;
let userId: number;
let bankId: number;

beforeAll(async () => {
  await initializeSchema();

  const users = await sql<{ id: number }[]>`
    INSERT INTO users (name, username, email, password_hash, country)
    VALUES ('Pagination Probe', 'pgn_probe', 'pgn_probe@example.test', 'x', 'CA')
    RETURNING id
  `;
  userId = users[0].id;

  const accounts = await sql<{ id: number }[]>`
    INSERT INTO bank_accounts (user_id, institution_name, account_name)
    VALUES (${userId}, 'Test Bank', 'Checking')
    RETURNING id
  `;
  bankId = accounts[0].id;

  // Distinct created_at per row so the ordering is unambiguous and a page
  // boundary is a real boundary rather than a tie.
  for (let i = 0; i < TOTAL; i++) {
    await sql`
      INSERT INTO transfer_intents (user_id, bank_account_id, type, amount, currency, status, created_at)
      VALUES (${userId}, ${bankId}, 'add_money', ${100 + i}, 'CAD', 'draft',
              NOW() - (${TOTAL - i} || ' minutes')::interval)
    `;
  }
}, 60000);

afterAll(async () => {
  await sql`DELETE FROM transfer_intents WHERE user_id = ${userId}`;
  await sql`DELETE FROM bank_accounts WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
}, 60000);

async function search(page: number) {
  const { AdminTransferService } = await import('@/lib/services/AdminTransferService');
  return new AdminTransferService().searchTransfers({ userId }, page, PAGE_SIZE);
}

describe('admin transfer search pagination', () => {
  it('returns different rows on page 2 than page 1', async () => {
    const first = await search(1);
    const second = await search(2);

    const a = first.transfers.map((t) => t.id);
    const b = second.transfers.map((t) => t.id);

    expect(a).toHaveLength(PAGE_SIZE);
    expect(b).toHaveLength(PAGE_SIZE);

    // The whole defect in one assertion: these used to be identical.
    expect(b).not.toEqual(a);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  it('walks every row exactly once across all pages', async () => {
    const seen: number[] = [];
    for (let page = 1; page <= Math.ceil(TOTAL / PAGE_SIZE); page++) {
      seen.push(...(await search(page)).transfers.map((t) => t.id));
    }

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL); // no row repeated
  });

  it('returns a short final page rather than a full one', async () => {
    const last = await search(3); // 12 rows, 5 per page -> 2 on page 3
    expect(last.transfers).toHaveLength(TOTAL % PAGE_SIZE);
  });

  it('returns nothing past the end', async () => {
    const beyond = await search(99);
    expect(beyond.transfers).toEqual([]);
    expect(beyond.total_count).toBe(TOTAL);
  });

  it('orders newest first, consistently across pages', async () => {
    const first = await search(1);
    const second = await search(2);
    const dates = [...first.transfers, ...second.transfers].map((t) =>
      new Date(t.created_at).getTime(),
    );

    const descending = [...dates].sort((x, y) => y - x);
    expect(dates).toEqual(descending);
  });

  it('reports total_count as a number, not the string int8 comes back as', async () => {
    const result = await search(1);

    // COUNT(*) is int8 and postgres.js returns it as a string, while
    // AdminTransferListResponse declares total_count: number.
    expect(typeof result.total_count).toBe('number');
    expect(result.total_count).toBe(TOTAL);
  });

  it('caps page size at 100 however large a value is requested', async () => {
    const { AdminTransferService } = await import('@/lib/services/AdminTransferService');
    const result = await new AdminTransferService().searchTransfers({ userId }, 1, 5000);
    expect(result.page_size).toBe(100);
  });
});
