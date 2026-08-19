/**
 * KAR-15.2 — the four controls that stand between port 7777 and everything
 * else running on this machine (docs/15-security-model.md §3,
 * docs/11-api-and-realtime.md §8).
 *
 * **Binding to loopback is not authentication.** Two attacks make it
 * insufficient, and both of them are already inside the network boundary:
 *
 *   - *Any local process running as the user* can reach `127.0.0.1:7777` — and
 *     the one that matters most is an agent DeFlow itself spawned, because an
 *     agent with a prompt-injected instruction and a shell is inside the trust
 *     boundary of an unauthenticated daemon that can start runs, read every
 *     artifact and approve human gates.
 *   - *DNS rebinding* lets any page the user already has open issue requests
 *     from the browser's own network position. Same-origin policy does not
 *     help: the browser believes the origin is `attacker.example` and it is
 *     talking to `127.0.0.1:7777`. What saves you is that a rebound page
 *     **cannot forge `Origin`**.
 *
 * So: a bearer token compared in constant time, an `Origin` allowlist, `Host`
 * validation as the second half of the rebinding defence, and `Vary: Origin`
 * on every response — without which a cache can serve a response computed for
 * one origin to a request from another and quietly undo the third.
 *
 * One decision function, `authorize`, answers for both transports: the HTTP
 * middleware below and the WebSocket upgrade guard in `./server.ts` (AC11).
 * Two implementations of one rule is how the socket ends up being the one that
 * forgot to check.
 *
 * ## The honest limits, recorded next to the control
 *
 * A process running *as the user* can read `.DeFlow/daemon.json`. This raises
 * the bar from "trivial" to "requires filesystem access as the user"; it does
 * not eliminate the class, and only OS-level isolation would. And the daemon
 * token is a **local** secret: it is never a team-hub credential, and it is on
 * the wrong side of `buildChildEnv()`'s allowlist like every other `*_TOKEN`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { MiddlewareHandler } from 'hono';
import { isPublicRoute } from './api-routes.ts';
import { apiError } from './errors.ts';

/** docs/15 §3.2: *"32 bytes from `crypto.randomBytes`, base64url"*. */
export const DAEMON_TOKEN_BYTES = 32;

/**
 * A fresh daemon token.
 *
 * base64url rather than hex or base64 because this string has to survive a URL
 * fragment, a JSON file and a shell argument without re-encoding — and a `+`
 * or a `/` in a fragment is exactly the kind of thing that works on one
 * machine and not on the next.
 */
export function mintDaemonToken(): string {
  return randomBytes(DAEMON_TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time string comparison (AC2).
 *
 * `timingSafeEqual` throws on operands of different length, and the obvious fix
 * — a length check in front of it — is itself the early return this exists to
 * avoid: it leaks the expected length one probe at a time. Hashing both sides
 * first makes every comparison 32 bytes wide regardless of input, so the
 * comparison always runs in full and the only thing an attacker can measure is
 * the cost of two SHA-256s over their own input.
 *
 * Timing analysis over loopback is a marginal threat and this is nearly free,
 * which is the right trade. The test asserts *which primitive is used* rather
 * than trying to measure timing, because a timing assertion in CI is a flake
 * generator.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** The credential out of an `Authorization` header, or `null` if it carries none. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** The hostname out of a `Host` header or a URL authority, brackets stripped. */
function hostnameOf(authority: string): string {
  const trimmed = authority.trim().toLowerCase();
  // IPv6 literals are bracketed precisely so their colons are not port
  // separators: `[::1]:7777`.
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  const colon = trimmed.indexOf(':');
  if (colon === -1) return trimmed;
  // A second colon in an unbracketed authority means a bare IPv6 address —
  // `::1`, as `--host ::1` and `server.address()` both spell it — and a bare
  // IPv6 address carries no port to strip. Splitting on the first colon
  // anyway would turn `::1` into the empty string, and the empty string is
  // not a loopback name, so the daemon would refuse its own bind address.
  if (trimmed.includes(':', colon + 1)) return trimmed;
  return trimmed.slice(0, colon);
}

/**
 * Whether a hostname names this machine and only this machine.
 *
 * The whole `127.0.0.0/8` block, not just `127.0.0.1`: systemd-resolved
 * listens on `127.0.0.53` and macOS aliases more of the block than people
 * expect, and a name that resolves to loopback — `rebind.attacker.example` —
 * is deliberately *not* one of these. That is the point of validating the
 * header rather than the socket.
 */
export function isLoopbackAddress(hostname: string): boolean {
  const name = hostnameOf(hostname);
  if (name === 'localhost') return true;
  if (name === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * The `Origin` allowlist: the daemon's own two origins (docs/15 §3.2).
 *
 * The configured bind address joins them only when it is something other than
 * loopback, which is only reachable through AC12's explicit flag — so the
 * allowlist cannot widen by accident.
 */
export function allowedOrigins(port: number, hostname: string): readonly string[] {
  const loopback = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return isLoopbackAddress(hostname) ? loopback : [...loopback, `http://${hostname}:${port}`];
}

/**
 * Origin validation rejects a **present and wrong** origin, never an absent one.
 *
 * Getting this backwards is a real risk: a strict "Origin must be present and
 * allowlisted" rule locks out `curl`, `deflow run` and every script, and the
 * pressure to relax it usually removes the check entirely rather than fixing
 * the condition.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  port: number,
  hostname: string,
): boolean {
  if (origin === undefined) return true;
  return allowedOrigins(port, hostname).includes(origin.trim().toLowerCase());
}

/** The second half of the rebinding defence (docs/15 §3.2). */
export function isAllowedHost(host: string | undefined, bindHostname: string): boolean {
  if (host === undefined) return false;
  const name = hostnameOf(host);
  return isLoopbackAddress(name) || name === hostnameOf(bindHostname);
}

/** A bind the operator did not explicitly ask for (AC12). */
export class NonLoopbackBindRefused extends Error {
  readonly hostname: string;

  constructor(hostname: string) {
    super(
      `refusing to bind ${hostname}: DeFlowd binds loopback only unless it is told otherwise. ` +
        'Set DeFlow_ALLOW_NON_LOOPBACK=1 to serve the control plane off-loopback, and read ' +
        'docs/15-security-model.md §3.3 first — over plain HTTP the bearer token is readable by ' +
        'anyone on the segment.',
    );
    this.name = 'NonLoopbackBindRefused';
    this.hostname = hostname;
  }
}

/**
 * AC12 — *"there is no configuration path that silently falls back to
 * `0.0.0.0`"*.
 *
 * A throw rather than a quiet fallback to `127.0.0.1`: binding somewhere other
 * than where the operator asked is its own surprise, and one they would find
 * out about from a connection that never arrives.
 */
export function assertLoopbackBind(hostname: string, allowNonLoopback: boolean): void {
  if (allowNonLoopback) return;
  if (isLoopbackAddress(hostname)) return;
  throw new NonLoopbackBindRefused(hostname);
}

/**
 * What this daemon life authenticates with.
 *
 * The port is the **bound** one, not the requested one: the allowlist is built
 * from it, and a daemon that fell back to the next free port would otherwise
 * reject its own UI.
 */
export interface DaemonAuth {
  readonly token: string;
  readonly port: number;
  readonly hostname: string;
}

let configured: DaemonAuth | null = null;

/** Called once, by `startHttp`, with this life's token and bound port. */
export function setDaemonAuth(next: DaemonAuth): void {
  configured = next;
}

/** Called on shutdown, so a route cannot authenticate against a dead daemon's token. */
export function clearDaemonAuth(): void {
  configured = null;
}

export function daemonAuth(): DaemonAuth | null {
  return configured;
}

/** What a request has to say for itself, independent of the transport it arrived on. */
export interface AuthRequest {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly authorization: string | undefined;
}

export type AuthRefusalCode = 'missing_token' | 'bad_token' | 'bad_origin';

export type AuthDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: AuthRefusalCode;
      readonly message: string;
      readonly reason: string;
    };

/**
 * The one decision, for both transports (AC11).
 *
 * Order is load-bearing. `Host` and `Origin` are checked **before** the token
 * and **regardless** of it, because a valid token must not rescue a bad origin
 * — the natural implementation checks the origin only on the unauthenticated
 * path, which leaves the rebinding attack open the moment a token leaks. And
 * the token is checked before routing, so an unknown path answers 401 rather
 * than confirming which routes exist.
 */
export function authorize(request: AuthRequest, auth: DaemonAuth): AuthDecision {
  if (!isAllowedHost(request.host, auth.hostname)) {
    return {
      ok: false,
      code: 'bad_origin',
      message: 'the Host header is neither a loopback name nor the configured bind address',
      reason: 'host_not_allowed',
    };
  }

  if (!isAllowedOrigin(request.origin, auth.port, auth.hostname)) {
    return {
      ok: false,
      code: 'bad_origin',
      message: 'this origin is not allowed to reach DeFlowd',
      reason: 'origin_not_allowed',
    };
  }

  if (isPublicRoute(request.method, request.path)) return { ok: true };

  const presented = bearerToken(request.authorization);
  if (presented === null) {
    return {
      ok: false,
      code: 'missing_token',
      message: 'this route requires "Authorization: Bearer <token>"',
      reason: 'no_bearer_credential',
    };
  }

  if (!constantTimeEqual(presented, auth.token)) {
    return {
      ok: false,
      code: 'bad_token',
      // Nothing about the expected token: not a prefix, not its length. A
      // refusal that described what it wanted would hand over the search space.
      message: 'that token is not this daemon’s token',
      reason: 'token_mismatch',
    };
  }

  return { ok: true };
}

/**
 * `Vary: Origin` on **every response Hono builds**, refusals included (AC4).
 *
 * Set after `next()` so it lands on whatever the chain produced — including a
 * refusal from the middleware below, and including the SSE stream, whose
 * response object is built by `streamSSE` rather than by `c.json`.
 *
 * ## KAR-25.9 — the one response it must not touch
 *
 * A response that was written **straight to the socket** is not Hono's to
 * header, and reaching for it is what made the dev daemon print
 * `ERR_HTTP_HEADERS_SENT` twice on every request Vite served
 * (EPIC-25-S56, EPIC-25-S60). The mechanism is worth stating, because the
 * crash names neither this file nor the line that causes it:
 *
 * 1. `../http/connect.ts` runs Vite's connect middleware, which writes the
 *    whole response itself, and returns `RESPONSE_ALREADY_SENT` — a sentinel
 *    `Response` carrying the `x-hono-already-sent` header. `@hono/node-server`
 *    checks for that header and leaves the socket alone.
 * 2. `c.header()` on a finalized context does not mutate a `Headers` object in
 *    place; it **rebuilds** `c.res` as a new `Response`.
 * 3. `@hono/node-server` replaces the global `Response` with a subclass that
 *    caches its own status/body/headers, and its writer checks for that cache
 *    **before** it checks for `x-hono-already-sent`. So the rebuilt sentinel
 *    takes the ordinary write path, `writeHead` is called on a socket that is
 *    already finished, and Node throws.
 *
 * So the sentinel is returned untouched. Nothing is lost by it: in dev, the
 * assets Vite serves never had Hono-written headers to vary in the first
 * place, and in production the SPA and its assets are built by
 * `serveStatic`/`c.body` and still get the header. AC4's claim is about the
 * responses this application builds, and this is the one response it does not.
 *
 * Identity, not a header sniff: `RESPONSE_ALREADY_SENT` is a module-level
 * singleton, so `===` is exact and cannot be spoofed by a route that happens
 * to set the same header name.
 */
export const varyOrigin: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res === RESPONSE_ALREADY_SENT) return;
  c.header('Vary', 'Origin');
};

/**
 * The middleware every `/api` route sits behind.
 *
 * With no token registered it answers 503 rather than passing the request
 * through: a daemon with no token configured is not "a daemon without auth",
 * it is a daemon that is not ready, and failing open here would be invisible
 * in every other test in the repository.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const auth = daemonAuth();
  if (auth === null) {
    // The one exemption still applies: `GET /health` is what `deflow up` polls
    // to learn whether the daemon it started is up, and refusing the readiness
    // probe until readiness has completed is a deadlock rather than a control.
    // Every other route is refused — not passed through.
    if (isPublicRoute(c.req.method, c.req.path)) {
      await next();
      return;
    }
    return c.json(
      ...apiError('daemon_starting', 'DeFlowd has not registered its token yet', {
        detail: { reason: 'auth_unconfigured' },
      }),
    );
  }

  // The `Host` header as the client sent it, falling back to the authority of
  // the request URL — which is what `@hono/node-server` builds *from* that same
  // header, so the two agree on a real socket and the fallback only matters to
  // a `app.request()` caller that constructed a Request by hand.
  const decision = authorize(
    {
      method: c.req.method,
      path: c.req.path,
      host: c.req.header('host') ?? hostOfUrl(c.req.url),
      origin: c.req.header('origin'),
      authorization: c.req.header('authorization'),
    },
    auth,
  );

  if (!decision.ok) {
    return c.json(
      ...apiError(decision.code, decision.message, { detail: { reason: decision.reason } }),
    );
  }

  await next();
  return;
};

function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
