import { timingSafeEqual } from 'node:crypto';

export type CronAuthorizationStatus = 'authorized' | 'unauthorized' | 'misconfigured';

/**
 * Verify Vercel's Bearer credential without leaking a secret through a
 * byte-by-byte comparison. Vercel sends `Authorization: Bearer <CRON_SECRET>`
 * when CRON_SECRET is configured on the project.
 */
export function authorizeCronRequest(authorization: string | null): CronAuthorizationStatus {
  const secret = process.env.CRON_SECRET;
  if (!secret) return 'misconfigured';
  if (!authorization) return 'unauthorized';

  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(authorization);
  if (expected.length !== received.length) return 'unauthorized';

  return timingSafeEqual(expected, received) ? 'authorized' : 'unauthorized';
}
