/**
 * KAR-15.4 — the resume contract, as two pure functions
 * (docs/11-api-and-realtime.md §4.1, §4.2, §7.2).
 *
 * There are **two** resume paths and both are mandatory, because they cover
 * disjoint cases. The browser sends `Last-Event-ID` only when *its own*
 * reconnection logic fires on a connection that had previously opened
 * successfully — never after a page reload, never on a first attempt, and never
 * when the initial connect failed. That last case is the common one in
 * development: DeFlowd restarts, the tab's stream fails to open, and when the
 * daemon comes back the tab reconnects with no cursor at all.
 *
 * So the client persists its own cursor and always opens with `?since=<seq>`,
 * and the precedence is fixed:
 *
 * ```
 * since query param  >  Last-Event-ID header  >  head of log
 * ```
 *
 * The query parameter wins because the client's own persisted cursor is more
 * trustworthy than the browser's, and because the CLI has no `Last-Event-ID`
 * mechanism at all. Head is the floor for a request that named no cursor
 * whatsoever: it is announced in `hello.headSeq`, so a client that wanted
 * everything can hydrate through `GET /api/runs/:id/events?since=0` and open
 * the stream at the cursor that returns, rather than having every anonymous
 * connection replay a multi-hour ledger by default.
 *
 * The cursor contract is *"resume from strictly greater than `seq`"*, and it is
 * never *"expect `seq + 1`"* (§4.2). `seq` 4, 5, 7 is a healthy log: the
 * sequence is global across runs and `AUTOINCREMENT` never reissues a pruned
 * number. Nothing in this file — or anywhere else — compares an incoming `seq`
 * to its predecessor plus one; `test/no-gap-detection.test.ts` is what keeps
 * that true.
 */

/** Where a connection starts: an explicit cursor, or the head of the log. */
export type Resume = { readonly kind: 'seq'; readonly seq: number } | { readonly kind: 'head' };

/** §7.2 — `limit` defaults to 1000 … */
export const DEFAULT_HYDRATE_LIMIT = 1000;

/** … and is capped at 5000. */
export const MAX_HYDRATE_LIMIT = 5000;

/**
 * A query parameter or header as a cursor, or `null` when it is not one.
 *
 * `Number.isSafeInteger` rather than a truthiness check, and `>= 0` rather than
 * `> 0`, because `since=0` is a real cursor meaning *"everything"* — the cold
 * hydrate's first call. Treating it as falsy is the coercion bug that makes a
 * cold hydrate silently start from head.
 */
function asCursor(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** @see Resume — `since` > `Last-Event-ID` > head, and nothing else. */
export function resumeFrom(since: string | undefined, lastEventId: string | undefined): Resume {
  for (const candidate of [since, lastEventId]) {
    const seq = asCursor(candidate);
    if (seq !== null) return { kind: 'seq', seq };
  }
  return { kind: 'head' };
}

/**
 * `?limit=` for a hydrate page: 1000 by default, 5000 at most.
 *
 * Clamped rather than refused. A client asking for 50,000 is asking to hydrate
 * a long run in fewer round trips, which is a reasonable thing to want and a
 * terrible thing to serve — one statement returning 50,000 envelopes is the
 * unbounded read §5.1 measured an 82.6 MB `-wal` file behind. It gets 5,000 and
 * a `more: true` that tells it to come back, which is the same answer in a
 * shape the daemon can survive.
 */
export function hydrateLimit(limit: string | undefined): number {
  const parsed = Number(limit);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_HYDRATE_LIMIT;
  return Math.min(parsed, MAX_HYDRATE_LIMIT);
}
