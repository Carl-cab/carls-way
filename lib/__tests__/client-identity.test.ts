/**
 * Client identity resolution for unauthenticated requests.
 *
 * ## What these tests are for, and what they are not
 *
 * They pin the *resolution order*, the *validation*, and the *provenance* that
 * `clientIdentity()` reports. They do **not** establish that the resulting
 * identity is unforgeable, and no assertion here should be read that way: which
 * of these headers the platform actually sets is unverified (Vercel's docs are
 * unreachable from the engineering environment, and third-party accounts
 * contradict both each other and the official docs).
 *
 * What they do establish is that a client cannot turn arbitrary header content
 * into an arbitrary rate-limit key, and that an operator can find out which
 * header a real request was keyed on instead of guessing.
 */
import { describe, expect, it } from 'vitest';
import { clientIdentity, clientIdentifier } from '../rate-limit';

/** Minimal stand-in for the `headers.get()` surface the function needs. */
function req(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name: string) => lower[name.toLowerCase()] ?? null } };
}

describe('resolution order', () => {
  it('prefers x-vercel-forwarded-for over the others', () => {
    const id = clientIdentity(
      req({
        'x-vercel-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
        'x-forwarded-for': '203.0.113.3',
      }),
    );
    expect(id).toEqual({ id: '203.0.113.1', source: 'x-vercel-forwarded-for' });
  });

  it('falls to x-real-ip when the platform header is absent', () => {
    const id = clientIdentity(req({ 'x-real-ip': '203.0.113.2', 'x-forwarded-for': '203.0.113.3' }));
    expect(id).toEqual({ id: '203.0.113.2', source: 'x-real-ip' });
  });

  it('falls to x-forwarded-for when neither of the others is present', () => {
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.3' }))).toEqual({
      id: '203.0.113.3',
      source: 'x-forwarded-for',
    });
  });

  it('reports source "none" when no header is usable', () => {
    expect(clientIdentity(req({}))).toEqual({ id: 'unknown-client', source: 'none' });
  });
});

describe('x-forwarded-for takes the rightmost hop, not the leftmost', () => {
  it('ignores the client-supplied prefix', () => {
    // The whole point. XFF is built left to right, each proxy appending the
    // address it saw; the leftmost entries are whatever the client made up.
    // Reading the leftmost entry would let a caller send a different value per
    // request so the counter never accumulates — removing the ceiling from
    // login, registration and password reset at once.
    const id = clientIdentity(req({ 'x-forwarded-for': '10.0.0.1, 198.51.100.9, 203.0.113.7' }));
    expect(id.id).toBe('203.0.113.7');
  });

  it('skips a trailing entry that is not an IP and takes the next one right-to-left', () => {
    // A malformed last hop must not become the key, and must not make the
    // whole header unusable either.
    const id = clientIdentity(req({ 'x-forwarded-for': '203.0.113.7, not-an-ip' }));
    expect(id).toEqual({ id: '203.0.113.7', source: 'x-forwarded-for' });
  });

  it('handles a single-entry header, which is what one trusted proxy produces', () => {
    expect(clientIdentity(req({ 'x-forwarded-for': '203.0.113.7' })).id).toBe('203.0.113.7');
  });
});

describe('validation: arbitrary header content cannot become a rate-limit key', () => {
  // This narrows the key space from "any string the client sends" to "any
  // string shaped like an IP". It does NOT stop spoofing — a caller who can
  // set the header can send valid addresses and rotate them. What it stops is
  // unbounded key cardinality from unvalidated input, and keys that are not
  // addresses at all.
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a hostname', 'evil.example.com'],
    ['a sentence', 'drop table users'],
    ['an unsplit list', '1.2.3.4,5.6.7.8'],
    ['an out-of-range octet', '999.1.1.1'],
    ['padding', 'x'.repeat(200)],
    // A bare colon is every character an IPv6 address is made of and no
    // address at all. The character-class check this validator replaced
    // accepted it, so a junk preferred header was *selected* rather than
    // skipped — see the fall-through case below, which is the consequence.
    ['a bare colon', ':'],
    ['colons only', ':::'],
    ['too many groups', '1:2:3:4:5:6:7:8:9'],
    // A zone suffix is meaningful only on a scoped IPv6 address (RFC 4007).
    // Accepting one on IPv4 let a single address mint unlimited distinct
    // rate-limit keys — see the cardinality case below, which is the reason
    // this matters rather than a syntax quibble.
    ['an IPv4 address with a zone suffix', '203.0.113.9%junk'],
    ['an IPv4 address with a short zone', '1.2.3.4%a'],
    ['a zone with no address', '%eth0'],
  ])('rejects %s in x-real-ip and does not key on it', (_label, value) => {
    const id = clientIdentity(req({ 'x-real-ip': value }));
    expect(id.id).not.toBe(value);
    expect(id).toEqual({ id: 'unknown-client', source: 'none' });
  });

  it('falls through to a usable header rather than discarding the request', () => {
    // A garbage value in the preferred header must not shadow a good value in
    // a later one — otherwise an attacker could force the collapse case
    // deliberately by sending one junk header.
    const id = clientIdentity(
      req({ 'x-vercel-forwarded-for': 'junk', 'x-real-ip': '203.0.113.5' }),
    );
    expect(id).toEqual({ id: '203.0.113.5', source: 'x-real-ip' });
  });

  it('accepts IPv6, including a zone suffix', () => {
    expect(clientIdentity(req({ 'x-real-ip': '2001:db8::1' })).id).toBe('2001:db8::1');
    expect(clientIdentity(req({ 'x-real-ip': 'fe80::1%eth0' })).id).toBe('fe80::1%eth0');
  });

  it('cannot be used to mint unlimited keys from one IPv4 address', () => {
    // The reason the zone rule matters. If `1.2.3.4%a` and `1.2.3.4%b` both
    // validated, one caller could rotate the suffix to get a fresh rate-limit
    // bucket per request — defeating every client-keyed limit and growing
    // counter cardinality without bound, which is precisely what validating
    // the header was introduced to prevent.
    const ids = ['a', 'b', 'c', 'd'].map(
      (z) => clientIdentity(req({ 'x-real-ip': `203.0.113.9%${z}` })).id,
    );
    expect(new Set(ids)).toEqual(new Set(['unknown-client']));
  });

  it('a malformed preferred header must not outrank a valid x-real-ip', () => {
    // The reviewer's framing of the same defect: an IPv4-with-zone in the
    // preferred header used to win the precedence order.
    expect(
      clientIdentity(
        req({ 'x-vercel-forwarded-for': '203.0.113.9%junk', 'x-real-ip': '198.51.100.7' }),
      ),
    ).toEqual({ id: '198.51.100.7', source: 'x-real-ip' });
  });

  it('still accepts a genuine scoped IPv6 address with its zone', () => {
    // The fix must not break the legitimate case it was written for.
    expect(clientIdentity(req({ 'x-real-ip': 'fe80::1%eth0' })).id).toBe('fe80::1%eth0');
  });

  it('accepts the IPv4-mapped IPv6 form', () => {
    // It contains dots, so a hex-and-colon character check rejected it and sent
    // a real client to the shared unknown-client bucket.
    expect(clientIdentity(req({ 'x-real-ip': '::ffff:192.0.2.1' })).id).toBe('::ffff:192.0.2.1');
  });

  it('does not let a junk preferred header shadow a valid later one', () => {
    // The specific regression: ':' passed the old shape check, so it won the
    // precedence order and x-real-ip was never consulted.
    expect(
      clientIdentity(req({ 'x-vercel-forwarded-for': ':', 'x-real-ip': '203.0.113.5' })),
    ).toEqual({ id: '203.0.113.5', source: 'x-real-ip' });
  });

  it('accepts the IPv4 boundary values', () => {
    expect(clientIdentity(req({ 'x-real-ip': '0.0.0.0' })).id).toBe('0.0.0.0');
    expect(clientIdentity(req({ 'x-real-ip': '255.255.255.255' })).id).toBe('255.255.255.255');
  });
});

describe('clientIdentifier stays a thin wrapper', () => {
  it('returns exactly the id clientIdentity resolved', () => {
    const headers = req({ 'x-forwarded-for': '198.51.100.4' });
    expect(clientIdentifier(headers)).toBe(clientIdentity(headers).id);
  });

  it('still returns the collapse constant when nothing is usable', () => {
    // Pins the fail-open behaviour deliberately: changing this to a refusal is
    // a policy decision about availability versus enforcement, and this test
    // exists so that change cannot happen silently.
    expect(clientIdentifier(req({}))).toBe('unknown-client');
  });
});

describe('the collapse case is per-key, which is why it matters more for some buckets', () => {
  it('produces one shared identity for every caller when no header is usable', () => {
    // auth:login keys on `${clientIdentifier(req)}:${email}`, so a collapse is
    // still per-email. auth:register and schema:bootstrap key on the client
    // alone, so for those the limit becomes global — three registrations an
    // hour for the whole platform, and a break-glass path any anonymous caller
    // can exhaust for everyone. Recorded as a test so the asymmetry is visible
    // in the suite rather than only in prose.
    const a = clientIdentifier(req({}));
    const b = clientIdentifier(req({ 'x-real-ip': 'not-an-ip' }));
    expect(a).toBe(b);
  });
});
