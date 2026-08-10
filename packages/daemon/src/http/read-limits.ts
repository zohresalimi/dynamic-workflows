/**
 * KAR-15.6 AC9 — the bound on every list endpoint, in one table.
 *
 * *"No endpoint can be made to return an unbounded result set."* That is a
 * property of the API rather than of any one route, so the defaults and the
 * caps live together where they can be read as a list — and so a route that
 * forgot to apply one is visible as a missing entry rather than as a number
 * somebody has to go and find.
 *
 * Two decisions worth stating:
 *
 * - **An oversized limit is clamped, not refused.** A `400` would make a UI
 *   paging bug indistinguishable from a network failure, and the client cannot
 *   do anything useful with it; the cap is the honest answer to "give me
 *   everything", and `X-DeFlow-Limit` on the response says which bound was
 *   applied so a caller can tell a truncated page from a complete one.
 * - **Anything unparseable falls back to the default.** `limit=abc` is a
 *   client bug, and the failure mode of "refuse" is a blank panel; the failure
 *   mode of "default" is a page of the documented size. `Infinity` is the case
 *   that catches naïve parsers — `Number('Infinity')` is a number, and it is
 *   not an integer, which is why the check is `Number.isInteger` rather than
 *   `Number.isNaN`.
 *
 * The caps are sized against what the P0 views actually render: a scrubber rail
 * of 500 versions is longer than any run this system has produced, and 2,000
 * `io_chunk` rows is more terminal scrollback than a browser will draw at once.
 */

/** A documented default and the cap a caller cannot exceed. */
export interface ReadLimit {
  readonly fallback: number;
  readonly cap: number;
}

/**
 * One entry per list endpoint. Adding a list without adding a row here is the
 * thing `../../test/read-bounds.test.ts` fails the build over.
 */
export const READ_LIMITS = {
  /** `GET /runs/:id/plans` — one row per plan version. */
  plans: { fallback: 200, cap: 500 },
  /** `GET /runs/:id/nodes/:nodeId/io` — chunks per page, head or tail. */
  io: { fallback: 500, cap: 2_000 },
  /** `GET /runs/:id/facts`. */
  facts: { fallback: 200, cap: 1_000 },
  /** `GET /runs/:id/facts/:factId/consumers`. */
  consumers: { fallback: 200, cap: 1_000 },
  /** `GET /runs/:id/findings`. */
  findings: { fallback: 500, cap: 2_000 },
  /** `GET /runs/:id/gates` and `…/criteria` — a plan's gates, not a page. */
  gates: { fallback: 200, cap: 500 },
} as const satisfies Readonly<Record<string, ReadLimit>>;

/** The header naming the bound that was actually applied to a response. */
export const LIMIT_HEADER = 'X-DeFlow-Limit';

/**
 * `raw` as a usable page size: the default when it names nothing usable, the
 * cap when it names more than the cap, and itself otherwise.
 */
export function boundedLimit(raw: string | undefined, limit: ReadLimit): number {
  if (raw === undefined || raw.trim() === '') return limit.fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return limit.fallback;
  return Math.min(parsed, limit.cap);
}
