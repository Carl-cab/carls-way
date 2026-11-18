/**
 * A rejected password-reset email must not be silent.
 *
 * THE DEFECT. `resend.emails.send()` resolves to
 * `{ data, error: null } | { data: null, error }` — it does not throw when the
 * API rejects the request. `lib/email.ts` discarded that result, and
 * `POST /api/auth/forgot-password` wraps the call in a `try/catch` that logs
 * and then answers `{ success: true }` unconditionally, which is the right
 * response because revealing whether an address exists is account enumeration.
 *
 * Combined: the SDK did not throw, so the catch never ran and nothing was
 * logged; the route answered 200; a reset token row was created; no email was
 * sent. Measured in a running sandbox with an invalid API key — the route
 * answered 200 and the log held zero occurrences of its own "Password reset
 * email error".
 *
 * Password recovery could be entirely broken in production and nothing would
 * say so. `invalid_from_address` alone makes that reachable: it is what Resend
 * answers when `EMAIL_FROM` is not on a verified domain.
 *
 * WHAT IS PINNED. That a populated `error` throws, and that a successful send
 * does not. Not the email's wording. The Resend client is mocked because the
 * subject is this module's handling of the two shapes the real SDK returns,
 * and asserting it must never make a network call to an email provider.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor(public apiKey: string) {}
  },
}));

const ENV = {
  RESEND_API_KEY: 're_test_key_not_real',
  EMAIL_FROM: 'noreply@example.test',
  NEXT_PUBLIC_APP_URL: 'https://example.test',
};

beforeEach(() => {
  sendMock.mockReset();
  Object.assign(process.env, ENV);
});

describe('sendPasswordResetEmail', () => {
  it('throws when Resend returns an error instead of resolving quietly', async () => {
    // The exact shape resend@6 returns for a rejected send: resolved promise,
    // null data, populated error. This is the case that was silent.
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'invalid_api_key', message: 'API key is invalid' },
      headers: null,
    });

    const { sendPasswordResetEmail } = await import('../email');

    await expect(
      sendPasswordResetEmail('someone@example.test', 'token-abc'),
    ).rejects.toThrow(/invalid_api_key/);
  });

  it('names invalid_from_address specifically, the unverified-domain case', async () => {
    // Called out because it is the failure a correct deployment hits: a real
    // API key with EMAIL_FROM not on a verified sending domain.
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'invalid_from_address', message: 'The from address is not verified' },
      headers: null,
    });

    const { sendPasswordResetEmail } = await import('../email');

    await expect(
      sendPasswordResetEmail('someone@example.test', 'token-abc'),
    ).rejects.toThrow(/invalid_from_address/);
  });

  it('does not put the recipient address in the thrown message', async () => {
    // The throw reaches logRedactedError in the route. An operator needs the
    // provider's error code, not a user's email address in the logs.
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests' },
      headers: null,
    });

    const { sendPasswordResetEmail } = await import('../email');

    await expect(
      sendPasswordResetEmail('private-person@example.test', 'token-abc'),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('private-person@example.test'),
      }) as Error,
    );
  });

  it('resolves without throwing on a successful send', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_123' }, error: null, headers: null });

    const { sendPasswordResetEmail } = await import('../email');

    await expect(
      sendPasswordResetEmail('someone@example.test', 'token-abc'),
    ).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('still throws on incomplete configuration, before any send is attempted', async () => {
    // Pre-existing behaviour, pinned so the change above did not move the
    // point at which a missing variable is noticed.
    delete process.env.RESEND_API_KEY;
    const { sendPasswordResetEmail } = await import('../email');

    await expect(
      sendPasswordResetEmail('someone@example.test', 'token-abc'),
    ).rejects.toThrow(/Email configuration incomplete/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
