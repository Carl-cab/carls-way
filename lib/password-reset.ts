import crypto from 'crypto';
import { getSql } from './db';
import { revokeUserSessions } from './auth';

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

/**
 * Atomically consume a reset token and apply the security-sensitive account
 * changes it authorizes.
 *
 * The conditional UPDATE is the sole authorization gate: a caller gets a user
 * only when its SHA-256 token hash still identifies an unused, unexpired row.
 * That prevents a time-of-check/time-of-use gap between token validation and
 * consumption. The preliminary lookup only derives the account row to lock;
 * it does not establish validity. Locking that row before the claim also
 * serializes different outstanding tokens for one account, so legacy duplicate
 * reset rows cannot reset an account twice under concurrent requests.
 *
 * Returning null is intentionally indistinguishable for unknown, expired, and
 * previously used tokens. Unexpected write failures are thrown so postgres.js
 * rolls back the token claim together with the password and session changes.
 */
export async function claimPasswordResetAndUpdatePassword(
  token: string,
  passwordHash: string,
): Promise<{ userId: number } | null> {
  const sql = getSql();
  const tokenHash = hashToken(token);

  return sql.begin(async (tx) => {
    // Do not treat this lookup as validation. It obtains a stable per-account
    // lock before the conditional claim below, which is the authorization gate.
    const candidates = await tx<{ id: number; user_id: number }[]>`
      SELECT id, user_id
      FROM password_reset_tokens
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `;
    const candidate = candidates[0];
    if (!candidate) return null;

    // Serializing claims at the account row prevents two distinct, concurrently
    // valid rows (for example from a historical issuance race) from changing the
    // password twice. This lock is held until every reset side effect commits.
    const users = await tx<{ id: number }[]>`
      SELECT id FROM users WHERE id = ${candidate.user_id} FOR UPDATE
    `;
    if (!users[0]) return null;

    // This conditional UPDATE is the atomic claim. A concurrent claimant waits
    // for the row lock, then sees used_at and receives no returned row.
    const claimed = await tx<{ user_id: number }[]>`
      UPDATE password_reset_tokens
      SET used_at = NOW()
      WHERE id = ${candidate.id}
        AND token_hash = ${tokenHash}
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING user_id
    `;
    if (!claimed[0]) return null;

    // Include the established token-version revocation in the same transaction
    // as the password update. A failure below aborts the claim, making the reset
    // link usable for a retry rather than leaving a partially recovered account.
    const updatedUsers = await tx<{ id: number }[]>`
      UPDATE users
      SET password_hash = ${passwordHash}
      WHERE id = ${claimed[0].user_id}
      RETURNING id
    `;
    if (!updatedUsers[0]) {
      throw new Error('Password reset user update did not affect a user');
    }
    await revokeUserSessions(claimed[0].user_id, tx);

    // There should normally be only one active row because issuance retires old
    // tokens. Retire any legacy/concurrently-issued rows before commit as a
    // defense in depth measure, while the account row remains locked.
    await tx`
      UPDATE password_reset_tokens
      SET used_at = NOW()
      WHERE user_id = ${claimed[0].user_id}
        AND used_at IS NULL
    `;

    return { userId: claimed[0].user_id };
  });
}
