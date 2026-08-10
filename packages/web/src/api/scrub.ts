/**
 * KAR-15.7 — the client half of `GET /api/runs/:id/snapshot?seq=N`: the
 * plan-evolution scrubber's hydration path, shared by the UI and the CLI
 * (docs/11-api-and-realtime.md §7.3).
 *
 * > **The reason this endpoint exists is browser memory, not server
 * > convenience.**
 *
 * The endpoint alone does not deliver that. A client is perfectly able to call
 * `…/events?since=0`, fold a nine-hour run in JavaScript and freeze the tab
 * with the snapshot endpoint sitting there unused — which is exactly the
 * failure F10.2's scrubber was specified against. This module is the other
 * half of the promise: the only way this codebase materialises the state at a
 * `seq`, with three rules baked into it rather than left to its callers.
 *
 * 1. **Every position is fetched, never derived.** `positionAt(N)` is one
 *    `…/snapshot?seq=<N>` request. `N` travels as the caller named it —
 *    including `'head'`, which is a `seq` the client cannot know without a
 *    request that could race the very write it is trying to catch — and the
 *    `seq` in the response says which committed `seq` the state reflects,
 *    because `seq` has gaps and the position dragged to may name a number this
 *    run never committed.
 * 2. **Forward replay re-bases on the nearest snapshot.** Following a live tail
 *    a few events past a position already held is cheaper as a fold than as a
 *    round trip, so it is allowed — from the *greatest* snapshot at or below
 *    the target, and only while the target is within `replayWindow` of it.
 *    Anything further is the server's fold, not the tab's.
 * 3. **No fold ever starts from `seq` 0.** The base of a forward replay is
 *    always a state the server computed, and never the state at `seq` 0 — the
 *    initial state under another name. A client that folded from there would
 *    be replaying the run from the beginning through a slower path than the one
 *    it was given to avoid.
 *
 * Positions are held by the `seq` they *reflect* rather than by the `seq` that
 * was asked for: 10 and 11 either side of a hole are the same state, and a
 * cache keyed on the request would hold it twice and still miss on the third
 * number in the gap.
 */
import type { RunState } from '@DeFlow/core';
import { foldEvents } from '@DeFlow/core';
import type { ApiClient } from './client.ts';

/** The state at one position of the timeline, and how it got here. */
export interface ScrubPosition {
  /**
   * The committed `seq` `state` reflects — the greatest one at or below the
   * position asked for, which is not always the number that was asked for.
   */
  readonly seq: number;
  readonly state: RunState;
  /** Read off `state`, so a rendered version can never disagree with it. */
  readonly planVersion: number;
  readonly planHash: RunState['planHash'];
  /** `'snapshot'` ⇒ the server folded it; `'replay'` ⇒ this client did. */
  readonly hydratedBy: 'snapshot' | 'replay';
  /** The `seq` of the snapshot this position was folded forward from. Never 0. */
  readonly replayedFrom: number;
  /** Events this client folded to reach it. `0` for a snapshot. */
  readonly replayed: number;
}

export interface ScrubberOptions {
  /**
   * How far past a held snapshot a target may be and still be reached by
   * folding events client-side. `0` — the default — means never: every
   * position is the server's fold. A live tail sets it to a handful.
   *
   * It is measured in `seq`, which over-counts (the sequence is shared by every
   * run in the directory), and that is the safe direction: the window bounds
   * the work by more than it will ever actually be.
   */
  readonly replayWindow?: number;
  /** Page size for the replay's event reads. Omitted takes the server default. */
  readonly limit?: number;
}

export interface Scrubber {
  /** The state at `seq`, hydrated from the daemon. `'head'` is the run's head. */
  positionAt(seq: number | 'head'): Promise<ScrubPosition>;
  /** The `seq` of every position held, ascending. */
  held(): readonly number[];
}

interface SnapshotResponse {
  readonly seq: number;
  readonly state: RunState;
}

interface EventsPage {
  readonly events: readonly unknown[];
  readonly cursor: number;
  readonly more: boolean;
}

/**
 * A scrubber over `runId`.
 *
 * Constructed per timeline rather than exported as a singleton, because the
 * positions it holds are one run's and the window is the caller's call: the
 * plan-evolution view wants a handful, a CLI replay wants none.
 */
export function createScrubber(
  client: ApiClient,
  runId: string,
  options: ScrubberOptions = {},
): Scrubber {
  const replayWindow = options.replayWindow ?? 0;
  const held = new Map<number, ScrubPosition>();

  const remember = (position: ScrubPosition): ScrubPosition => {
    held.set(position.seq, position);
    return position;
  };

  /**
   * The greatest snapshot at or below `target`.
   *
   * Snapshots only — a position this client folded itself is not a base, so
   * replays never chain off each other and the fold is always at most one
   * window deep. `seq > 0` is rule 3: the state at `seq` 0 is the initial
   * state, and folding forward from it is the client-side reduction from zero
   * this whole module exists to make impossible.
   */
  const nearestSnapshot = (target: number): ScrubPosition | undefined => {
    let nearest: ScrubPosition | undefined;
    for (const position of held.values()) {
      if (position.hydratedBy !== 'snapshot' || position.seq === 0) continue;
      if (position.seq > target) continue;
      if (nearest === undefined || position.seq > nearest.seq) nearest = position;
    }
    return nearest;
  };

  const fetchSnapshot = async (target: number | 'head'): Promise<ScrubPosition> => {
    const response = await client.runs[':id'].snapshot.$get({
      param: { id: runId },
      query: { seq: target === 'head' ? 'head' : String(target) },
    });
    if (!response.ok) {
      throw new Error(`snapshot of ${runId} at ${target} failed with ${response.status}`);
    }

    const body = (await response.json()) as SnapshotResponse;
    return position(body.state, body.seq, 'snapshot', body.seq, 0);
  };

  const replayForward = async (base: ScrubPosition, target: number): Promise<ScrubPosition> => {
    let state = base.state;
    let seq = base.seq;
    let replayed = 0;
    let cursor = base.seq;

    for (;;) {
      const response = await client.runs[':id'].events.$get({
        param: { id: runId },
        // Both keys always present, `limit` as an explicit `undefined` when the
        // caller named none, for the reason `./hydrate.ts` spells out: under
        // `exactOptionalPropertyTypes` an absent key and a key holding
        // `undefined` are different types, and `hono/client` drops the
        // undefined one from the query string either way.
        query: {
          since: String(cursor),
          limit: options.limit === undefined ? undefined : String(options.limit),
        },
      });
      if (!response.ok) {
        throw new Error(`replaying ${runId} from ${cursor} failed with ${response.status}`);
      }

      const page = (await response.json()) as EventsPage;
      // `foldEvents` is @DeFlow/core's, the same one the endpoint folds
      // through, so a position reached by replay cannot disagree with the same
      // position fetched — which is what makes taking this path at all safe.
      const report = foldEvents(upTo(page.events, target), state);
      state = report.state;
      replayed += report.applied;
      seq = Math.max(seq, report.lastSeq);

      cursor = page.cursor;
      if (!page.more || cursor >= target) break;
    }

    return position(state, seq, 'replay', base.seq, replayed);
  };

  return {
    held: () => [...held.keys()].toSorted((left, right) => left - right),

    async positionAt(target: number | 'head'): Promise<ScrubPosition> {
      if (target === 'head') return remember(await fetchSnapshot(target));

      const exact = held.get(target);
      if (exact !== undefined) return exact;

      const nearest = nearestSnapshot(target);
      return remember(
        nearest !== undefined && target - nearest.seq <= replayWindow
          ? await replayForward(nearest, target)
          : await fetchSnapshot(target),
      );
    },
  };
}

function position(
  state: RunState,
  seq: number,
  hydratedBy: ScrubPosition['hydratedBy'],
  replayedFrom: number,
  replayed: number,
): ScrubPosition {
  return {
    seq,
    state,
    // Off the state rather than off the response's own two convenience fields:
    // one source for what this position *is*, so a view cannot render a plan
    // version the state beside it does not have.
    planVersion: state.planVersion,
    planHash: state.planHash,
    hydratedBy,
    replayedFrom,
    replayed,
  };
}

/**
 * `rows`, stopped the instant one overshoots `seq` — the same bound
 * `snapshotRunAt` applies server-side, so a replayed position resolves down
 * through a gap exactly as a fetched one does.
 */
function* upTo(rows: readonly unknown[], seq: number): Generator<unknown> {
  for (const row of rows) {
    if (seqOf(row) > seq) return;
    yield row;
  }
}

/** A row too malformed to have a `seq` is passed on for `foldEvents` to count. */
function seqOf(row: unknown): number {
  if (row === null || typeof row !== 'object') return 0;
  const seq = (row as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0;
}
