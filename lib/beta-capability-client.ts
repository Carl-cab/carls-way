/**
 * The CLIENT-side half of the one-resolver rule: given whatever
 * `GET /api/beta-profile` produced, is this capability available?
 *
 * **It fails closed, and that is its whole purpose.** Only an explicit `true`
 * at `capabilities[capability]` returns true. A null body (a non-ok response),
 * a missing `capabilities` object, a missing key, or a non-boolean value all
 * return **false** — withheld.
 *
 * WHY THIS EXISTS AS A FUNCTION. The first version of `PlaidLinkButton` held
 * `boolean | null` and disabled its control only on an explicit `false`, so a
 * failed profile request left the "+ Link Account" button live: the user was
 * offered an action the server answers with 403, and an operator glancing at
 * the page saw a beta that looked unrestricted. The rule is identical for
 * every capability-gated control, so it belongs in one tested place — a second
 * copy inline in a component is a second chance to get the default backwards.
 *
 * WHY ITS OWN MODULE, and not `lib/beta-restrictions.ts`. That module imports
 * `lib/environment.ts` and resolves `MANNA_BETA_PROFILE` from `process.env`.
 * Importing it from a `'use client'` component would pull server-side
 * environment resolution into the browser bundle, where those variables do not
 * exist and the logic is meaningless. This file imports nothing but a type,
 * which erases at compile time.
 *
 * This is PRESENTATION ONLY. It can be more restrictive than the server and
 * never less, because the control is the route's 403. A UI that hid a control
 * the API still honoured would merely look restricted; the reverse — which is
 * what this fixes — offers an action that cannot succeed.
 */

import type { RestrictedCapability } from '@/lib/beta-restrictions';

export function clientCapabilityAvailable(
  payload: unknown,
  capability: RestrictedCapability,
): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const caps = (payload as { capabilities?: unknown }).capabilities;
  if (typeof caps !== 'object' || caps === null) return false;
  return (caps as Record<string, unknown>)[capability] === true;
}
