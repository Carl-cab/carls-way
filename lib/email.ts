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

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const { apiKey, fromEmail, appUrl } = getEmailConfig();
  const resend = new Resend(apiKey);
  const resetUrl = `${appUrl}/reset-password?token=${token}`;

  await resend.emails.send({
    from: fromEmail,
    to: email,
    subject: 'Reset your Manna password',
    html: `
      <p>Hi,</p>
      <p>We received a request to reset your Manna password. Click the link below to set a new password:</p>
      <p>
        <a href="${resetUrl}" style="display: inline-block; background-color: #b91c1c; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Reset Password
        </a>
      </p>
      <p>Or copy and paste this link in your browser: ${resetUrl}</p>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
      <p>—<br />Manna Team</p>
    `,
  });
}
