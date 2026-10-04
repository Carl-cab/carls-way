import { getSql } from '@/lib/db';

export interface DeadLetter {
  id: number;
  provider: string;
  providerEventId: string;
  eventType: string;
  failureCount: number;
  createdAt: string;
  requeuedAt: string | null;
}

/**
 * List dead-lettered webhook events, newest first.
 * Requeued entries are excluded by default — they are back in the normal
 * processing flow.
 */
export async function listDeadLetters(
  opts?: { includeRequeued?: boolean; limit?: number },
): Promise<DeadLetter[]> {
  const sql = getSql();
  const limit = Math.min(opts?.limit ?? 100, 500);

  const rows =
    opts?.includeRequeued
      ? await sql`
          SELECT id, provider, provider_event_id, event_type,
                 failure_count, created_at, requeued_at
          FROM webhook_dead_letters
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, provider, provider_event_id, event_type,
                 failure_count, created_at, requeued_at
          FROM webhook_dead_letters
          WHERE requeued_at IS NULL
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;

  return rows.map((r) => ({
    id: r.id as number,
    provider: r.provider as string,
    providerEventId: r.provider_event_id as string,
    eventType: r.event_type as string,
    failureCount: r.failure_count as number,
    createdAt: r.created_at as string,
    requeuedAt: (r.requeued_at as string | null) ?? null,
  }));
}
