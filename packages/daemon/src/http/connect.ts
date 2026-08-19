/**
 * Runs a connect-style middleware (Vite's `vite.middlewares`) inside Hono.
 *
 * `@hono/node-server` exposes the real `node:http` request and response on
 * `c.env`, and exports `RESPONSE_ALREADY_SENT` as the way to tell Hono "this
 * response was written directly to the socket, do not build one". That is the
 * whole adapter: no buffering, no re-wrapping, so Vite streams its transformed
 * modules straight out.
 *
 * KAR-25.9: a connect middleware's `next()` call is not proof that nothing
 * was written. Vite's own error and fallback middlewares write a complete
 * response *and then* call `next()` — a courtesy to whatever comes after them
 * in a plain connect chain. Trusting that signal here made Hono build a
 * second response over an already-finished socket and Node throw
 * `ERR_HTTP_HEADERS_SENT`. The fix asks `outgoing` instead of the middleware:
 * after the promise below settles, `headersSent` / `writableEnded` say
 * whether bytes actually went out, regardless of what `next()` claimed.
 *
 * The second half is a listener leak, not a crash, but the same settle-path
 * bug: `outgoing.once('finish' | 'close', ...)` only ever cleans up the
 * listener for the event that fired — the other one is left registered until
 * garbage collection, on every request that finishes via `next()` or resolves
 * via `'finish'`/`'close'` rather than being explicitly swept. `settle()` now
 * removes both listeners on every path that ends the promise — the `next()`
 * callback, and `'finish'`/`'close'` themselves — so a long-lived daemon does
 * not accumulate listeners on responses it has already answered.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { MiddlewareHandler } from 'hono';

export type ConnectMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

export function fromConnect(
  middleware: ConnectMiddleware,
): MiddlewareHandler<{ Bindings: HttpBindings }> {
  return async (c, next) => {
    const { incoming, outgoing } = c.env;

    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        outgoing.removeListener('finish', onFinish);
        outgoing.removeListener('close', onFinish);
      };
      const onFinish = () => {
        settle();
        resolve();
      };
      outgoing.once('finish', onFinish);
      outgoing.once('close', onFinish);
      middleware(incoming, outgoing, (error?: unknown) => {
        settle();
        if (error === undefined || error === null) {
          resolve();
          return;
        }
        if (error instanceof Error) {
          reject(error);
          return;
        }
        reject(new Error(typeof error === 'string' ? error : JSON.stringify(error)));
      });
    });

    // `next()` firing is not the fact — a middleware can write a complete
    // response and still call next() (see the header comment). Whether bytes
    // hit the wire is knowable only from `outgoing` itself.
    if (outgoing.headersSent || outgoing.writableEnded) return RESPONSE_ALREADY_SENT;
    await next();
    return undefined;
  };
}
