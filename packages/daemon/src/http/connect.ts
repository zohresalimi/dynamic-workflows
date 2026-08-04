/**
 * Runs a connect-style middleware (Vite's `vite.middlewares`) inside Hono.
 *
 * `@hono/node-server` exposes the real `node:http` request and response on
 * `c.env`, and exports `RESPONSE_ALREADY_SENT` as the way to tell Hono "this
 * response was written directly to the socket, do not build one". That is the
 * whole adapter: no buffering, no re-wrapping, so Vite streams its transformed
 * modules straight out.
 */
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage, ServerResponse } from 'node:http';

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

    const handled = await new Promise<boolean>((resolve, reject) => {
      const done = () => resolve(true);
      outgoing.once('finish', done);
      outgoing.once('close', done);
      middleware(incoming, outgoing, (error?: unknown) => {
        outgoing.removeListener('finish', done);
        outgoing.removeListener('close', done);
        if (error === undefined || error === null) {
          resolve(false);
          return;
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    if (handled) return RESPONSE_ALREADY_SENT;
    await next();
    return undefined;
  };
}
