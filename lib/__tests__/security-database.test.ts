/**
 * Database TLS default regression tests.
 *
 * The connection layer relaxes TLS only for an explicit `?sslmode=disable`,
 * which exists so local and CI PostgreSQL instances without certificates can be
 * addressed. Everything else — including a typo — must keep requiring TLS, so
 * encryption can never be dropped by accident.
 */

import { resolveSslMode } from '../db';

describe('database connection TLS', () => {
  const BASE = 'postgres://user:pass@db.example.com:5432/manna';

  it('requires TLS when no sslmode is given', () => {
    expect(resolveSslMode(BASE)).toBe('require');
  });

  it('requires TLS for a production-style pooler URL', () => {
    expect(
      resolveSslMode('postgres://postgres.abc:secret@aws-0-ca-central-1.pooler.supabase.com:6543/postgres'),
    ).toBe('require');
  });

  it('disables TLS only for an exact sslmode=disable opt-in', () => {
    expect(resolveSslMode(`${BASE}?sslmode=disable`)).toBe(false);
  });

  it.each([
    ['require', 'require'],
    ['verify-full', 'verify-full'],
    ['prefer', 'prefer'],
    ['allow', 'allow'],
    ['empty', ''],
    ['typo', 'disabled'],
    ['uppercase', 'DISABLE'],
    ['padded', ' disable '],
    ['boolean-ish', 'false'],
  ])('keeps requiring TLS for sslmode=%s', (_label, value) => {
    expect(resolveSslMode(`${BASE}?sslmode=${encodeURIComponent(value)}`)).toBe('require');
  });

  it('requires TLS when the connection string is unparseable', () => {
    expect(resolveSslMode('not a url')).toBe('require');
    expect(resolveSslMode('')).toBe('require');
  });

  it('is unaffected by other query parameters', () => {
    expect(resolveSslMode(`${BASE}?pool_timeout=30&application_name=manna`)).toBe('require');
  });
});
