/**
 * KAR-25.9 — the response that was written twice.
 *
 * Verifies: EPIC-25-S56 (write-then-next doesn't double-respond), EPIC-25-S57
 * (next-only still falls through), EPIC-25-S58 (write-only is still
 * already-sent), EPIC-25-S59 (listeners are removed on every settle path)
 *
 * Drives `fromConnect` against fake connect middlewares — no Vite, no real
 * socket. The defect needs exactly two things true at once: a middleware that
 * writes to `outgoing` and *then* calls `next()` (which is what Vite's own
 * error and fallback middlewares do), and an adapter that trusts `next()`'s
 * signal over what `outgoing` actually did. `endResponse` reproduces the
 * ordering that makes this a race at all: it flips `headersSent` /
 * `writableEnded` synchronously, the way real `ServerResponse` does, but only
 * *emits* `'finish'` on a later microtask, also like the real thing — so a
 * middleware that calls `next()` right after ending the response gets its
 * `next()` callback run before `'finish'` fires. That ordering is what made
 * the old code's `handled` flag lie: it believed `next()`, not `outgoing`.
 *
 * Each test builds its own `FakeResponse` and closes over it directly, rather
 * than reading it back off the middleware's `res` parameter — the fake is a
 * plain `EventEmitter`, not a real `ServerResponse`, so passing it through
 * `c.env` needs one `as unknown as ServerResponse` at the boundary, and
 * closing over the original keeps that the only place it happens.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { expect, it, describe as suite } from 'vitest';
import { type ConnectMiddleware, fromConnect } from './connect.ts';

/**
 * Just enough of `ServerResponse` for the adapter: it only ever reads
 * `headersSent` / `writableEnded` and listens for `'finish'` / `'close'`.
 */
class FakeResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
}

const FAKE_INCOMING = {} as IncomingMessage;

/** Mirrors real `ServerResponse#end()`: the flags flip now, `'finish'` fires later. */
function endResponse(res: FakeResponse): void {
  res.headersSent = true;
  res.writableEnded = true;
  queueMicrotask(() => res.emit('finish'));
}

function listenerTotal(res: FakeResponse): number {
  return res.listenerCount('finish') + res.listenerCount('close');
}

const nextOnly: ConnectMiddleware = (_req, _res, next) => next();

interface RunResult {
  result: unknown;
  honoNextCalled: boolean;
  error?: unknown;
}

/** Sends one request through the adapter and reports what happened. */
async function run(middleware: ConnectMiddleware, outgoing: FakeResponse): Promise<RunResult> {
  let honoNextCalled = false;
  const honoNext = () => {
    honoNextCalled = true;
    return Promise.resolve();
  };
  const c = {
    env: { incoming: FAKE_INCOMING, outgoing: outgoing as unknown as ServerResponse },
  };
  const handler = fromConnect(middleware);

  try {
    const result = await handler(c as never, honoNext as never);
    return { result, honoNextCalled };
  } catch (error) {
    return { result: undefined, honoNextCalled, error };
  }
}

suite('EPIC-25-S56 — write then next() does not double-respond', () => {
  it('reports already-sent and does not fall through to Hono', async () => {
    const outgoing = new FakeResponse();
    const writeThenNext: ConnectMiddleware = (_req, _res, next) => {
      endResponse(outgoing);
      next();
    };

    const { result, honoNextCalled, error } = await run(writeThenNext, outgoing);

    expect(error).toBeUndefined();
    expect(result).toBe(RESPONSE_ALREADY_SENT);
    expect(honoNextCalled).toBe(false);
  });
});

suite('EPIC-25-S57 — next() with no write still falls through', () => {
  it("runs Hono's next handler, unchanged", async () => {
    const { result, honoNextCalled, error } = await run(nextOnly, new FakeResponse());

    expect(error).toBeUndefined();
    expect(result).toBeUndefined();
    expect(honoNextCalled).toBe(true);
  });
});

suite('EPIC-25-S58 — write with no next() is still already-sent', () => {
  it('reports already-sent, unchanged from today', async () => {
    const outgoing = new FakeResponse();
    const writeOnly: ConnectMiddleware = (_req) => {
      endResponse(outgoing);
    };

    const { result, honoNextCalled, error } = await run(writeOnly, outgoing);

    expect(error).toBeUndefined();
    expect(result).toBe(RESPONSE_ALREADY_SENT);
    expect(honoNextCalled).toBe(false);
  });
});

suite('EPIC-25-S59 — listeners on outgoing are removed on every settle path', () => {
  it('next() with no write', async () => {
    const outgoing = new FakeResponse();
    const before = listenerTotal(outgoing);

    await run((_req, _res, next) => next(), outgoing);

    expect(listenerTotal(outgoing)).toBe(before);
  });

  it('next() after a write', async () => {
    const outgoing = new FakeResponse();
    const before = listenerTotal(outgoing);

    await run((_req, _res, next) => {
      endResponse(outgoing);
      next();
    }, outgoing);

    expect(listenerTotal(outgoing)).toBe(before);
  });

  it('finish without next()', async () => {
    const outgoing = new FakeResponse();
    const before = listenerTotal(outgoing);

    await run(() => {
      endResponse(outgoing);
    }, outgoing);

    expect(listenerTotal(outgoing)).toBe(before);
  });

  it('close without next()', async () => {
    const outgoing = new FakeResponse();
    const before = listenerTotal(outgoing);

    await run(() => {
      // Headers went out, then the connection dropped before 'finish' — the
      // 'close' path, distinct from the 'finish' one above.
      outgoing.headersSent = true;
      queueMicrotask(() => outgoing.emit('close'));
    }, outgoing);

    expect(listenerTotal(outgoing)).toBe(before);
  });

  it('next(error)', async () => {
    const outgoing = new FakeResponse();
    const before = listenerTotal(outgoing);
    const boom = new Error('boom');

    const { error } = await run((_req, _res, next) => next(boom), outgoing);

    expect(error).toBe(boom);
    expect(listenerTotal(outgoing)).toBe(before);
  });
});
