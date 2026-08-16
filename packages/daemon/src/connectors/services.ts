/**
 * KAR-22.6 — the roster: which services this build registers, and the one
 * lookup from a path parameter to one of them.
 *
 * **Its own module rather than the bottom of `./registry.ts`, and the reason is
 * a bug this story hit.** `registry.ts` holds the *contract* every service is
 * written against, so every service imports it; a roster that lives beside the
 * contract has to import every service back, and that cycle is invisible while
 * the service imports are type-only — TypeScript erases them — and becomes a
 * `TypeError: Cannot read properties of undefined` the moment anything shared
 * is a *value*. Hoisting one constant was enough to trigger it.
 *
 * So the layering is explicit: `registry.ts` imports nothing of DeFlow's,
 * services import `registry.ts`, and this file imports both. There is one of
 * these arrays and `test/one-connector-surface.test.ts` asserts it.
 */
import { GITHUB } from './github.ts';
import { JIRA } from './jira.ts';
import { LINEAR } from './linear.ts';
import type { ConnectorService, ConnectorServiceId } from './registry.ts';

/**
 * `raw` as a `ConnectorServiceId`, or `null`.
 *
 * The one place a path parameter becomes a service, so an unknown service is a
 * 404 rather than a lookup that returns `undefined` three frames later.
 */
export function asServiceId(raw: string): ConnectorServiceId | null {
  return SERVICES.some((service) => service.id === raw) ? (raw as ConnectorServiceId) : null;
}

export function serviceById(id: ConnectorServiceId): ConnectorService {
  const found = BY_ID.get(id);
  // Unreachable by construction — `asServiceId` is the only way to obtain one —
  // and a throw rather than a `!` so a future registry edit fails loudly.
  if (found === undefined) throw new Error(`no connector service '${id}' is registered`);
  return found;
}

/**
 * Every registered service, in the order the screen lists them.
 *
 * One array. KAR-22.6 AC1's "a second screen is a defect" is enforced by there
 * being one of these and one route family over it.
 */
export const SERVICES: readonly ConnectorService[] = [GITHUB, LINEAR, JIRA];

const BY_ID = new Map<ConnectorServiceId, ConnectorService>(
  SERVICES.map((service) => [service.id, service]),
);
