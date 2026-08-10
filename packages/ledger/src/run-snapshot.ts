/**
 * KAR-15.7 — the reduced state at an arbitrary `seq`, computed server-side
 * (docs/11-api-and-realtime.md §7.3).
 *
 * *"The reason this exists is browser memory, not server convenience."*
 * Scrubbing the plan-evolution timeline (F10.2) or replaying a run (F10.10)
 * must not mean replaying from `seq` 0 in JavaScript — on a multi-hour run
 * that freezes the tab. SQLite rebuilds state far faster than the browser
 * can, so this is the one place that fold happens, and it is the same fold
 * every other read path in this system uses.
 *
 * **`seq` has gaps**, because `AUTOINCREMENT` never reissues a pruned number
 * and one sequence is shared by every run in the directory. A requested `seq`
 * may therefore name a value this run never committed, and the answer is the
 * state at the greatest committed `seq` at or below it — which is exactly
 * what falls out of draining forward and stopping the instant an event's own
 * `seq` overshoots the request, rather than computing "which seq is valid"
 * as a question of its own. A request past the run's own head resolves the
 * same way, because the run's head *is* its greatest committed `seq`: there
 * is nothing to stop at, so the drain runs to the end and the answer is
 * whatever it last saw. `'head'` is the same case again with nothing to
 * compare against at all.
 *
 * **One reducer.** `boundedBy` only decides where to stop; `foldEvents` and
 * `reduce` (`@DeFlow/core`) do everything about *what an event means*, which
 * is what makes this projection unable to disagree with the one every other
 * read path and the live daemon itself produce.
 *
 * **Never touches `io_chunk`.** `drainEvents` reads `event` and nothing else,
 * so a multi-hour run's terminal output — fifty times the size of its
 * control plane — never enters this fold.
 */
import {
  type Db,
  foldEvents,
  initialRunState,
  type RunId,
  type RunState,
  type UpcasterRegistry,
} from '@DeFlow/core';
import type { StoredEvent } from './append.ts';
import { drainEvents } from './drain.ts';

/**
 * `'head'` names the run's current head rather than a number a caller cannot
 * know ahead of a write — the number the caller would otherwise have to fetch
 * first, in a second request that could race the very write it is trying to
 * catch up to.
 */
export type SnapshotSeq = number | 'head';

export interface RunSnapshot {
  /**
   * The `seq` the returned `state` actually reflects.
   *
   * Echoed rather than assumed: `seq` has gaps, so a caller that asked for 6
   * and is handed the state at 5 has to be told 5, or it cannot tell its own
   * cursor from the ledger's.
   */
  readonly seq: number;
  readonly state: RunState;
}

export interface SnapshotOptions {
  /** The upcaster registry to read through; defaults to the shipped one. */
  readonly registry?: UpcasterRegistry;
  /** Rows per bounded query while draining. Defaults to `drainEvents`'s own. */
  readonly batchSize?: number;
}

/**
 * `events`, stopped the instant one overshoots `seq` — never consumed further,
 * so no batch beyond the one that answers the request is ever read off disk.
 * `'head'` has nothing to stop at and yields everything.
 */
function* boundedBy(events: Iterable<StoredEvent>, seq: SnapshotSeq): Generator<StoredEvent> {
  if (seq === 'head') {
    yield* events;
    return;
  }
  for (const event of events) {
    if (event.seq > seq) return;
    yield event;
  }
}

/**
 * The reduced `RunState` of `runId` at `seq` — the greatest committed `seq`
 * at or below the request, resolving `'head'` and a request past the run's
 * own head to the same answer: whatever this run's events actually reduce to.
 *
 * A run with no events at or before `seq` — including one with no events at
 * all — answers `{ seq: 0, state: initialRunState() }` rather than refusing;
 * whether `runId` names a run this directory holds at all is the caller's own
 * question, answered the same way every other read endpoint answers it.
 */
export function snapshotRunAt(
  db: Db,
  runId: RunId,
  seq: SnapshotSeq,
  options: SnapshotOptions = {},
): RunSnapshot {
  const drained = drainEvents(
    db,
    runId,
    options.batchSize === undefined ? {} : { batchSize: options.batchSize },
  );
  const report = foldEvents(
    boundedBy(drained, seq),
    initialRunState(),
    options.registry === undefined ? {} : { registry: options.registry },
  );
  return { seq: report.lastSeq, state: report.state };
}
