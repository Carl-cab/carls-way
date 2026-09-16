import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { verifyUserPassword, USER_PASSWORD_ROUNDS } from '@/lib/auth';
import { clientIdentifier } from '@/lib/rate-limit';

/**
 * Two defences on the login surface that were present in name only.
 *
 * Both had a comment describing the protection they were supposed to provide,
 * which is what kept them from being looked at again. The tests below assert
 * the behaviour rather than the intent.
 */

function headers(map: Record<string, string>) {
  return { headers: { get: (name: string) => map[name.toLowerCase()] ?? null } };
}

async function timeOf(fn: () => Promise<unknown>, runs = 3): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < runs; i++) await fn();
  return (Date.now() - started) / runs;
}

describe('login user enumeration', () => {
  it('spends real bcrypt work on an account that does not exist', async () => {
    const realHash = await bcrypt.hash('CorrectHorse1', USER_PASSWORD_ROUNDS);

    const knownAccount = await timeOf(() => verifyUserPassword('guess', realHash));
    const unknownAccount = await timeOf(() => verifyUserPassword('guess', null));

    // The old dummy ('$2b$10$invalidhashfortimingnormalization') is not a valid
    // bcrypt digest, so this measured ~315ms against ~0ms. Anything close to
    // zero for the unknown branch is the enumeration oracle, back again.
    expect(unknownAccount).toBeGreaterThan(knownAccount * 0.5);
  });

  it('answers false for an unknown account rather than throwing', async () => {
    await expect(verifyUserPassword('anything', null)).resolves.toBe(false);
    await expect(verifyUserPassword('anything', undefined)).resolves.toBe(false);
  });

  it('answers false, not an exception, for a corrupt stored hash', async () => {
    // A row left behind by an older hashing scheme must fail closed.
    await expect(verifyUserPassword('anything', 'not-a-bcrypt-hash')).resolves.toBe(false);
    await expect(
      verifyUserPassword('anything', '$2b$10$invalidhashfortimingnormalization'),
    ).resolves.toBe(false);
  });

  it('still accepts the correct password and rejects a wrong one', async () => {
    const hash = await bcrypt.hash('CorrectHorse1', USER_PASSWORD_ROUNDS);
    expect(await verifyUserPassword('CorrectHorse1', hash)).toBe(true);
    expect(await verifyUserPassword('CorrectHorse2', hash)).toBe(false);
  });

  it('uses the same cost for the dummy as for real passwords', async () => {
    const source = await (await import('node:fs/promises')).readFile('lib/auth.ts', 'utf8');
    const dummy = source.match(/ABSENT_USER_DUMMY_HASH\s*=\s*\n?\s*'(\$2[aby]\$\d+\$[^']+)'/);
    expect(dummy).not.toBeNull();

    // A dummy at a lower cost is a quieter version of the same timing leak.
    const rounds = Number(dummy![1].split('$')[2]);
    expect(rounds).toBe(USER_PASSWORD_ROUNDS);

    // And it must be a hash nothing matches.
    expect(await bcrypt.compare('', dummy![1])).toBe(false);
  });
});

describe('clientIdentifier', () => {
  it('ignores a client-supplied X-Forwarded-For prefix', () => {
    // The attacker controls everything left of the entry the proxy appended.
    const spoofed = clientIdentifier(
      headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }),
    );
    expect(spoofed).toBe('203.0.113.9');
    expect(spoofed).not.toBe('1.1.1.1');
  });

  it('gives one client the same identity however it rewrites the header', () => {
    // This is the bypass: with the leftmost entry, each of these was a distinct
    // identity and the rate-limit counter never accumulated.
    const identities = new Set(
      ['9.9.9.9', 'fake', '10.0.0.1, 10.0.0.2', ''].map((prefix) =>
        clientIdentifier({
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'x-forwarded-for'
                ? (prefix ? `${prefix}, ` : '') + '203.0.113.9'
                : null,
          },
        }),
      ),
    );
    expect(identities).toEqual(new Set(['203.0.113.9']));
  });

  it('prefers x-real-ip, which carries no client-supplied prefix', () => {
    const id = clientIdentifier(
      headers({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }),
    );
    expect(id).toBe('203.0.113.9');
  });

  it('handles a single-hop header', () => {
    expect(clientIdentifier(headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('tolerates whitespace and empty entries without returning an empty key', () => {
    expect(clientIdentifier(headers({ 'x-forwarded-for': ' 1.1.1.1 ,  203.0.113.9  ' })))
      .toBe('203.0.113.9');
    expect(clientIdentifier(headers({ 'x-forwarded-for': '203.0.113.9, ,' }))).toBe('203.0.113.9');
    expect(clientIdentifier(headers({ 'x-forwarded-for': '  ' }))).toBe('unknown-client');
  });

  it('throttles globally when no forwarding header is present', () => {
    // Safe direction: one shared bucket limits more, not less.
    expect(clientIdentifier(headers({}))).toBe('unknown-client');
  });
});
