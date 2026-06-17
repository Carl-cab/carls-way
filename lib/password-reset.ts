import crypto from 'crypto';
import { getSql } from './db';

export function generateResetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createPasswordResetToken(userId: number): Promise<string> {
  const sql = getSql();
  const token = generateResetToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

  // Invalidate old tokens for this user
  await sql`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ${userId} AND used_at IS NULL`;

  // Create new token
  await sql`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt}, NOW())
  `;

  return token;
}

export async function validatePasswordResetToken(token: string): Promise<{ userId: number } | null> {
  const sql = getSql();
  const tokenHash = hashToken(token);

  const result = await sql`
    SELECT user_id FROM password_reset_tokens
    WHERE token_hash = ${tokenHash}
      AND used_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `;

  return result.length > 0 ? { userId: result[0].user_id } : null;
}

export async function markTokenAsUsed(token: string): Promise<void> {
  const sql = getSql();
  const tokenHash = hashToken(token);

  await sql`
    UPDATE password_reset_tokens
    SET used_at = NOW()
    WHERE token_hash = ${tokenHash}
  `;
}
