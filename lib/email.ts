import { Resend } from 'resend';

function getEmailConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!apiKey || !fromEmail || !appUrl) {
    throw new Error('Email configuration incomplete: RESEND_API_KEY, EMAIL_FROM, or NEXT_PUBLIC_APP_URL not set');
  }

  return { apiKey, fromEmail, appUrl };
}

/**
 * The Resend SDK does NOT throw when the API rejects a send.
 *
 * `emails.send()` resolves to `{ data, error: null } | { data: null, error }`
 * — read off `Response<T>` in resend@6's own type definitions, not inferred.
 * Its `RESEND_ERROR_CODE_KEY` union includes `invalid_api_key`,
 * `missing_api_key`, `restricted_api_key`, `invalid_from_address`,
 * `validation_error`, `rate_limit_exceeded` and the three quota codes. Every
 * one of those resolves successfully with `error` populated.
 *
 * This function previously discarded that result, and the consequence ran the
 * whole length of the only caller. `POST /api/auth/forgot-password` wraps the
 * call in a `try/catch` that logs, and then returns `{ success: true }`
 * unconditionally — correctly, because revealing whether an address exists is
 * account enumeration. So with the result discarded:
 *
 *   - the SDK did not throw,
 *   - the catch therefore never ran and nothing was logged,
 *   - the route answered `{"success": true}`,
 *   - a `password_reset_tokens` row was created,
 *   - and no email was sent.
 *
 * Measured in a running sandbox against an invalid API key: the route answered
 * 200 and the server log contained zero occurrences of its own
 * "Password reset email error". A completely silent failure of password
 * recovery, invisible to the user by design and invisible to the operator by
 * accident.
 *
 * Throwing here is what makes the caller's existing catch mean something. The
 * enumeration-resistant response is unchanged — users still always see
 * success — but an operator now gets a log line.
 *
 * The thrown message carries the provider's error name and message and NOT the
 * recipient address, because this travels to `logRedactedError`.
 */
export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const { apiKey, fromEmail, appUrl } = getEmailConfig();
  const resend = new Resend(apiKey);
  const resetUrl = `${appUrl}/reset-password?token=${token}`;

  const result = await resend.emails.send({
    from: fromEmail,
    to: email,
    subject: 'Reset your Manna password',
    html: `
      <p>Hi,</p>
      <p>We received a request to reset your Manna password. Click the link below to set a new password:</p>
      <p>
        <a href="${resetUrl}" style="display: inline-block; background-color: #1d4ed8; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Reset Password
        </a>
      </p>
      <p>Or copy and paste this link in your browser: ${resetUrl}</p>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
      <p>—<br />Manna Team</p>
    `,
  });

  if (result.error) {
    // `name` is the RESEND_ERROR_CODE_KEY (e.g. `invalid_api_key`,
    // `invalid_from_address`), which is the part an operator acts on.
    throw new Error(
      `Resend rejected the password-reset email: ${result.error.name} — ${result.error.message}`,
    );
  }
}
