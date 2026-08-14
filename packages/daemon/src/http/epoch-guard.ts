/**
 * KAR-15.4 AC7 — a write stamped with a superseded daemon epoch is refused
 * (docs/05-durable-execution.md §12, docs/11-api-and-realtime.md §10).
 *
 * `daemon_epoch` is the belt to `flock`'s braces: one counter, bumped once per
 * DeFlowd life, stamped on every ledger write and compared inside the append
 * transaction (`@DeFlow/ledger`'s `epoch.ts`). That fence protects the
 * *ledger*. This one protects the **decision**: a tab that has been open across
 * a restart holds a picture of a run assembled by a daemon that no longer
 * exists, and a `POST` it sends from that picture — approve this spec, decide
 * this patch, answer this gate — was decided against a world it has not
 * re-read.
 *
 * So a client that saw `daemonEpoch` on a `hello` frame may stamp its writes
 * with it, and a stamp that no longer matches earns `409 epoch_mismatch` — the
 * same code the stream's own `fatal` frame carries, which is one of exactly two
 * a client stops retrying on. The header is an assertion a caller *may* make,
 * never one it must: `deflow run` from a fresh shell has never seen a `hello`
 * frame and has no epoch to name, and holding it to one it could not know would
 * make the CLI unusable to enforce a check it cannot fail.
 *
 * Writes only. A `GET` carrying a stale epoch is a client reading a world that
 * has moved, which is what reading is for — and it is about to be told the new
 * epoch by `/api/health` or by the next `hello` anyway.
 */
import type { MiddlewareHandler } from 'hono';
import { daemonEpoch } from '../runtime.ts';
import { apiError } from './errors.ts';

/**
 * The header a client stamps its writes with.
 *
 * A header rather than a body field, for the same reason
 * `X-DeFlow-Submitted-By` is one: the request bodies are documented per route
 * in docs/11 §7, and threading one more property through every one of them —
 * including `POST /runs`, whose shape the CLI and the UI both build — would
 * change nine documented contracts to express one fact about the connection
 * rather than about the request.
 */
export const EPOCH_HEADER = 'X-DeFlow-Epoch';

/** Methods that change something. Everything else reads. */
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The presented epoch as a number, or `null` when the caller made no claim.
 *
 * A malformed header is treated as no claim rather than as a bad request: it
 * cannot be a *stale* epoch, since it is not an epoch at all, and answering a
 * write with a 400 over a diagnostic header would fail requests that are
 * otherwise perfectly valid.
 */
function presentedEpoch(header: string | undefined): number | null {
  if (header === undefined) return null;
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export const requireCurrentEpoch: MiddlewareHandler = async (c, next) => {
  const presented = presentedEpoch(c.req.header(EPOCH_HEADER));
  const current = daemonEpoch();

  if (!WRITE_METHODS.includes(c.req.method) || presented === null || current === null) {
    await next();
    return;
  }

  if (presented !== current) {
    return c.json(
      ...apiError(
        'epoch_mismatch',
        `this write was stamped with daemon epoch ${presented} and this daemon is at ${current}: ` +
          'the daemon you were talking to has been replaced, so nothing was applied. Reconnect ' +
          'the stream, re-read the run, and decide again.',
        { detail: { presented, current } },
      ),
    );
  }

  await next();
};
