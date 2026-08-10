/**
 * Which routes answer without a bearer token — the one fact `./api.ts` and
 * `./auth.ts` both need.
 *
 * Its own module rather than a constant in `api.ts`, because the auth
 * middleware is registered *on* the app it would have to import from, and a
 * cycle between "the routing table" and "the thing that guards it" is the kind
 * of import graph that works until the day module evaluation order changes
 * under it. `api.ts` re-exports both names, so the route table stays the thing
 * a reader looks at.
 */

/**
 * The one route that answers without a bearer token, as `"<METHOD> <path>"`.
 *
 * Unauthenticated *deliberately*: `DeFlow up` polls it for readiness before it
 * has read the token file, and it exposes nothing a local process could not
 * already learn from `.DeFlow/daemon.json`. It is exempt from the **token**
 * only — `Host` and `Origin` validation still apply, because a rebound page is
 * not `DeFlow up`.
 */
export const PUBLIC_ROUTES: readonly string[] = ['GET /health'];

/**
 * Whether `method path` is exempt from authentication.
 *
 * Accepts both the registered path (`/health`, as the route table holds it) and
 * the request path (`/api/health`, as a middleware sees it), because those are
 * the two callers and neither should have to know about the mount prefix.
 */
export function isPublicRoute(method: string, path: string): boolean {
  const registered = path === '/api' ? '/' : path.startsWith('/api/') ? path.slice(4) : path;
  return PUBLIC_ROUTES.includes(`${method.toUpperCase()} ${registered}`);
}
