import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit IV recommended for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag (GCM default)

/**
 * Loads and validates PLAID_TOKEN_ENCRYPTION_KEY.
 * Throws at call-time (not module load) so the error surfaces in the request
 * that actually needs encryption, with a clear message.
 */
function getEncryptionKey(): Buffer {
  const keyHex = process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error(
      'PLAID_TOKEN_ENCRYPTION_KEY environment variable is not set. ' +
      'Generate one with: openssl rand -hex 32'
    );
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `PLAID_TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ` +
      `Got ${key.length} bytes.`
    );
  }
  return key;
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 *
 * Output format (colon-delimited, each segment base64-encoded):
 *   <iv>:<authTag>:<ciphertext>
 *
 * Never call this in a client component — the key is only available server-side.
 */
export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString('base64')).join(':');
}

/**
 * Decrypts a value produced by encryptToken().
 * Throws if the payload is malformed or the auth tag does not verify
 * (i.e. the ciphertext has been tampered with or the wrong key is used).
 *
 * Only call this inside server-side API routes. Never return the result
 * directly to the client — pass it only to Plaid SDK calls.
 */
export function decryptToken(payload: string): string {
  const key = getEncryptionKey();
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format — expected iv:authTag:ciphertext');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
