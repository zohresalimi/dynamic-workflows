/**
 * KAR-15.4 — the cold-start hydrate loop, shared by the UI and the CLI
 * (docs/11-api-and-realtime.md §4.1, §7.2).
 *
 * > **Therefore the explicit hydrate path is mandatory, not an optimisation.**
 *
 * A tab that reloads sends no `Last-Event-ID`. A tab whose first connection
 * never opened — DeFlowd was restarting, which is the common case in
 * development — has no cursor at all. Neither can rely on the browser to resume
 * them, and the CLI has no `Last-Event-ID` mechanism whatsoever. So a client
 * with no persisted cursor calls `GET /api/runs/:id/events?since=0` until
 * `more` is false and only *then* opens the stream at the `cursor` it was
 * given. That sequence is the only one that produces neither a gap nor a
 * duplicate at the seam.
 *
 * Three rules are baked into the loop below rather than left to its callers:
 *
 * 1. **Page on `cursor`, never on a count.** `since = cursor` is the server's
 *    own answer; an offset the client counted itself is wrong the moment two
 *    runs interleave in the global sequence.
 * 2. **Stop on `more`, never on a short page.** A page can be short and still
 *    have events after it in exactly the case that matters least often and
 *    hurts most: a `limit` the server clamped.
 * 3. **No gap detection, of any shape.** `4, 5, 7` is a healthy sequence — `6`
 *    belongs to another run or to a pruned event `AUTOINCREMENT` will never
 *    reissue (§4.2) — so nothing here compares a `seq` to its predecessor,
 *    counts what it thinks is missing, or restarts from zero. A client that
 *    treated the hole as loss would refetch a multi-hour run over nothing.
 *    `test/no-gap-detection.test.ts` is what keeps that true.
 *
 * The one integrity check this offers is `headSeq`, and it is for **ordering**
 * — "how far from the head am I" — never for density.
 */
import type { Event } from '@DeFlow/core';
import { parseEvent } from '@DeFlow/core';
import type { ApiClient } from './client.ts';

/** One page of `GET /api/runs/:id/events`, as §7.2 documents it. */
export interface HydratePage {
  /** The highest `seq` in this page; the requested cursor when it is empty. */
  readonly cursor: number;
  /** The highest `seq` the ledger holds **for this run** — the denominator. */
  readonly headSeq: number;
  /** True ⇒ call again with `since=cursor`. */
  readonly more: boolean;
  /** How many events of this page this build understood and applied. */
  readonly applied: number;
}

export interface HydrateOptions {
  /** The persisted cursor to resume from. `0` — the default — is a cold start. */
  readonly since?: number;
  /** Page size. Omitted means the server's own default of 1000. */
  readonly limit?: number;
  /** Called for every event, in `seq` order, exactly once. */
  readonly apply: (event: Event) => void;
  /** Called once per page, for a progress bar with an honest denominator. */
  readonly onPage?: (page: HydratePage) => void;
  /** A kind this build has never heard of. Diagnostics only — never a gap. */
  readonly onUnknownKind?: (kind: string, seq: number) => void;
}

export interface HydrateResult {
  /** The cursor to open the stream at: `?since=<cursor>`. */
  readonly cursor: number;
  /** This run's head as the last page reported it. */
  readonly headSeq: number;
  /** Events applied across every page. */
  readonly applied: number;
  /** Round trips it took, so a caller can log a slow hydrate. */
  readonly pages: number;
}

interface EventsResponse {
  readonly events: readonly unknown[];
  readonly cursor: number;
  readonly headSeq: number;
  readonly more: boolean;
}

/**
 * Hydrates `runId` from `options.since` to the head of its log.
 *
 * The cursor advances past an event this build cannot parse, exactly as
 * `./dispatch.ts` does on the stream: a client that skipped both the event and
 * its number would ask for it again on every reconnect, forever.
 */
export async function hydrateRun(
  client: ApiClient,
  runId: string,
  options: HydrateOptions,
): Promise<HydrateResult> {
  let cursor = options.since ?? 0;
  let headSeq = 0;
  let applied = 0;
  let pages = 0;

  for (;;) {
    const response = await client.runs[':id'].events.$get({
      param: { id: runId },
      // Both keys always present, `limit` as an explicit `undefined` when the
      // caller named none: the route declares them as two optional strings, and
      // under `exactOptionalPropertyTypes` an absent key and a key holding
      // `undefined` are different types. `hono/client` drops the undefined one
      // from the query string, so the wire is unchanged either way.
      query: {
        since: String(cursor),
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
    });
    if (!response.ok) {
      throw new Error(`hydrating ${runId} from ${cursor} failed with ${response.status}`);
    }

    const page = (await response.json()) as EventsResponse;
    pages += 1;
    headSeq = page.headSeq;

    let appliedHere = 0;
    for (const candidate of page.events) {
      const parsed = parseEvent(candidate);
      if (parsed.status === 'ok') {
        options.apply(parsed.event);
        appliedHere += 1;
        continue;
      }
      if (parsed.status === 'unknown-kind') options.onUnknownKind?.(parsed.kind, parsed.seq);
    }
    applied += appliedHere;

    // The server's cursor, taken as given. Deriving one from the events —
    // "the last seq I understood" — would stall the loop on a page this build
    // could not parse at all, and re-request it forever.
    cursor = page.cursor;
    options.onPage?.({ cursor, headSeq, more: page.more, applied: appliedHere });
    if (!page.more) return { cursor, headSeq, applied, pages };
  }
}
