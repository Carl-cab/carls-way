/**
 * Origin validation for state-changing API routes.
 *
 * This is the CSRF control for an endpoint with no browser client. The reason
 * it is shaped the way it is matters, because the obvious stricter version
 * breaks a recovery path:
 *
 * **A missing `Origin` header is allowed.** That looks like a hole and is not.
 * CSRF requires a *browser* as the vehicle — the attack is riding the victim's
 * cookies from a page the attacker controls — and a browser always sends
 * `Origin` on a POST, cross-site or same-site. So a request with no `Origin`
 * did not come from a browser, and therefore cannot be the cross-site forgery
 * this guards against. What it typically is, is `curl` from an operator's
 * terminal.
 *
 * Requiring the header instead would reject every command-line call. For
 * `/api/migrate` that would disable the anonymous authentication-repair path —
 * the one that exists because production was once locked out and no
 * authenticated endpoint could fix it. A CSRF control that creates a lockout
 * is a worse trade than the one it prevents.
 *
 * What this does NOT defend against, stated rather than implied: a
 * non-browser client that already holds a valid credential. That is not CSRF;
 * it is credential compromise, and it is Layer 1's problem (see
 * `docs/decisions/0005-migration-privilege-separation.md`), not this
 * function's.
 */

export type OriginCheck =
  | { ok: true; reason: 'absent' | 'match' }
  | { ok: false; reason: 'mismatch' | 'malformed'; got: string };

/**
 * The origins a browser request may legitimately come from.
 *
 * `NEXT_PUBLIC_APP_URL` is the deployment's own origin. Vercel preview
 * deployments get a generated hostname that is not in it, which is why
 * `VERCEL_URL` is accepted too when present — otherwise a preview's own pages
 * would be treated as cross-site.
 */
function allowedOrigins(): string[] {
  const out: string[] = [];
  const app = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (app) out.push(app.replace(/\/+$/, ''));
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) out.push(`https://${vercel.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`);
  return out;
}

/**
 * Compare by parsed origin rather than string, so a trailing slash or a
 * differing default port does not read as a mismatch.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host;
  } catch {
    return false;
  }
}

export function checkOrigin(req: {
  headers: { get(name: string): string | null };
}): OriginCheck {
  const origin = req.headers.get('origin');

  // No Origin means no browser, which means no CSRF. See the note above.
  if (!origin) return { ok: true, reason: 'absent' };

  // `null` is what a browser sends from an opaque origin (a sandboxed iframe,
  // or a redirect chain that lost its origin). It is not a trusted caller.
  if (origin === 'null') return { ok: false, reason: 'malformed', got: origin };

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: 'malformed', got: origin };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'malformed', got: origin };
  }

  const allowed = allowedOrigins();

  // Nothing configured to compare against. Refusing every browser request
  // would be the stricter choice but would also fail closed on a deployment
  // that simply has not set NEXT_PUBLIC_APP_URL, so the request is refused
  // only because it carries an Origin that cannot be verified — a CLI call,
  // which sends none, still works.
  if (allowed.length === 0) return { ok: false, reason: 'mismatch', got: origin };

  return allowed.some((candidate) => sameOrigin(origin, candidate))
    ? { ok: true, reason: 'match' }
    : { ok: false, reason: 'mismatch', got: origin };
}
