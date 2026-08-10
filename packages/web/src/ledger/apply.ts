/**
 * KAR-16.2 — the dispatcher, where the stream meets the projections
 * (docs/12-frontend-architecture.md §3.2, §3.3).
 *
 * `../api/dispatch.ts` owns the *frame*: named or unnamed, known `kind` or not.
 * This module owns what happens to the events that survive that — which run's
 * projection set they belong to, and whether they have already been applied.
 *
 * Together they are the only input the UI has. §1 of the frontend architecture
 * claims *"it becomes impossible to render something that did not come from an
 * event, because there is no other input"*, and that claim is only checkable if
 * the path is short enough to read: one `onmessage`, one `applyEvent`, one
 * fan-out by `runId`, one call per projection. Everything else in the UI is a
 * `computed` over what these two files produced.
 *
 * ## Idempotency is a requirement, not a nicety
 *
 * The daemon backfills a newly subscribed run from the cursor the *connection*
 * opened at, and reconnects re-deliver from the tab's own cursor. Both windows
 * overlap events the tab already applied, by design (docs/11 §5). So an event
 * whose `seq` is not strictly greater than what this run has applied is
 * dropped, and the drop is reported to the caller rather than swallowed, so a
 * panel can tell "nothing new" from "nothing arrived".
 *
 * That guard is `>`, never `previous + 1`. `4, 5, 7` is a healthy log and a
 * client that treated the hole as loss would refetch a multi-hour run over
 * nothing (docs/11 §4.2).
 *
 * ## Nothing here throws
 *
 * A projection is a reducer over events a newer daemon may have written, and an
 * exception on frame 4,000 of a six-hour run would take out every projection in
 * the tab over one event nobody needed. A projection that throws is reported and
 * stepped over; its siblings still see the event, and the cursor still advances.
 */
import type { Event } from '@DeFlow/core';

/**
 * A pure reducer over one run's events — no Vue, no clock, no I/O.
 *
 * The seven that ship are KAR-16.3's (`plan`, `planHistory`, `blackboard`,
 * `context`, `gates`, `cost`, `timeline`). This interface is the seam they plug
 * into, and it is deliberately the whole contract: `create` for a fresh state,
 * `apply` for one event, and a `name` so a failure can say which one.
 */
export interface Projection<S> {
  readonly name: string;
  create(): S;
  /** Mutates `state` in place and returns nothing. Ignores unknown kinds. */
  apply(state: S, event: Event): void;
}

/** One run's projection set, plus the position it has been folded to. */
export interface RunLedger {
  readonly runId: string;
  /** The state this run holds for `projection`. Identity-keyed. */
  state<S>(projection: Projection<S>): S;
  /** The highest `seq` this run has applied. */
  appliedSeq(): number;
  /** How many events were applied. Never a count of what is "missing". */
  appliedCount(): number;
  /** The projections this set holds, in registration order. */
  projections(): readonly Projection<unknown>[];
}

export interface LedgerApplyOptions {
  /**
   * The set is heterogeneous by construction — seven reducers over seven
   * unrelated state types — so the element type is the top one. `Projection` is
   * declared with *methods* rather than function-typed properties, which makes
   * its parameter position bivariant, which is what lets a
   * `Projection<PlanProjection>` sit in this array at all. `state()` recovers
   * the concrete type through the projection object's own identity.
   */
  readonly projections: readonly Projection<unknown>[];
  /** One call per event actually applied — the debug ring's feed (KAR-16.4). */
  readonly onApplied?: (event: Event) => void;
  /** A projection that threw. Diagnostics; the stream carries on regardless. */
  readonly onProjectionError?: (projection: string, event: Event, error: unknown) => void;
}

export interface LedgerApply {
  /** Opens a panel's projection set, or returns the one already open. */
  watch(runId: string): RunLedger;
  /** Closes it. The server-side filter is `../api/multiplex.ts`'s business. */
  unwatch(runId: string): void;
  ledger(runId: string): RunLedger | undefined;
  /** The runs with a panel open. */
  runs(): readonly string[];
  /**
   * Routes one event to the run that owns it. Returns whether it was applied —
   * `false` for a duplicate, and for a run nothing is watching.
   */
  apply(event: Event): boolean;
}

export function createLedgerApply(options: LedgerApplyOptions): LedgerApply {
  const registered = options.projections;
  const runs = new Map<string, MutableRunLedger>();

  return {
    runs: () => [...runs.keys()],
    ledger: (runId) => runs.get(runId),
    unwatch(runId) {
      runs.delete(runId);
    },
    watch(runId) {
      const existing = runs.get(runId);
      if (existing !== undefined) return existing;
      const fresh = openRunLedger(runId, registered);
      runs.set(runId, fresh);
      return fresh;
    },
    apply(event) {
      const run = runs.get(event.runId);
      // A frame for a run nothing is watching is dropped rather than opening a
      // panel for it: the filter belongs to the server, and a subscription the
      // tab has since closed keeps delivering until the daemon is told.
      if (run === undefined) return false;
      if (!run.absorb(event, options.onProjectionError)) return false;
      options.onApplied?.(event);
      return true;
    },
  };
}

interface MutableRunLedger extends RunLedger {
  absorb(event: Event, onError: LedgerApplyOptions['onProjectionError']): boolean;
}

function openRunLedger(
  runId: string,
  registered: readonly Projection<unknown>[],
): MutableRunLedger {
  const states = new Map<Projection<unknown>, unknown>(
    registered.map((projection) => [projection, projection.create()] as const),
  );
  let seq = 0;
  let count = 0;

  return {
    runId,
    projections: () => registered,
    appliedSeq: () => seq,
    appliedCount: () => count,
    // The cast is the other half of the `Map<Projection<unknown>, unknown>`
    // above: the value was produced by this very projection's `create`, so the
    // pairing is sound and only the map's value type has forgotten it.
    state: <S>(projection: Projection<S>) => states.get(projection) as S,
    absorb(event, onError) {
      // Strictly greater than what this run has folded. Not a successor check —
      // see the module docblock, and `test/no-gap-detection.test.ts`.
      if (event.seq <= seq) return false;

      for (const projection of registered) {
        try {
          projection.apply(states.get(projection), event);
        } catch (error) {
          onError?.(projection.name, event, error);
        }
      }
      seq = event.seq;
      count += 1;
      return true;
    },
  };
}
