/**
 * KAR-16.4 — `useRunStore`: a **thin reactive shell** over the seven
 * projections (docs/12-frontend-architecture.md §3.3, §4, §5).
 *
 * There is no domain logic in this file and there must never be any. Every fold
 * lives in `../ledger/projections/`, every fan-out lives in `../ledger/apply.ts`,
 * and what is left here is three things and nothing else: a `shallowRef` per
 * projection state, an integer version counter per projection, and `computed`
 * selectors that read the counter to derive a view-model array. If you find
 * yourself reaching for an `if` about an event kind here, it belongs next door.
 *
 * ## The four performance rules, and the third is the one people get backwards
 *
 * 1. **`shallowRef`, never `reactive()`.** Deep reactivity over a few thousand
 *    ledger-derived objects is the single most likely cause of missing NF3's
 *    *UI interactive < 1s*: Vue walks thousands of objects installing proxies.
 *    A `shallowRef` tracks one reference instead.
 * 2. **`markRaw` on anything a foreign library holds.** Vue Flow nodes, ELK
 *    graph inputs, `xterm` `Terminal`s, d3 scales. A Vue proxy around an object
 *    a foreign library runs identity comparisons on is very hard to see and
 *    very easy to avoid — `adopt()` and `adoptTerminal()` below are the seam.
 * 3. **Mutate the underlying `Map`, then bump a counter.** Reassigning a
 *    2,000-entry array on every `node.progress` event is *worse* than the deep
 *    reactivity you were avoiding. The projections mutate in place and this
 *    store increments an integer; the `computed` selectors depend on the
 *    integer, not on a new array identity.
 *
 * ## The four memory rules
 *
 * - **Never retain the raw event array.** `applyEvent` folds the envelope and
 *   drops it. The only structure that keeps one is `ring`, and it is a fixed
 *   2,000-slot circular buffer (`../ledger/ring.ts`) whose overwritten slot is
 *   released — which `./useRunStore.test.ts` asserts with a `WeakRef` and a
 *   forced GC, because *unbounded retention has no visible symptom until the
 *   tab dies at hour four of a real run*.
 * - **Cap unbounded per-node collections.** `node.progress` and stdout go to
 *   the terminal's xterm buffer and nowhere else. Nothing here accumulates a
 *   payload per event: the store's object count is a function of node count and
 *   fact count, never of event count.
 * - **Scrubbing must not replay from `seq` 0 in the browser.** `scrubTo()` is
 *   one `GET …/snapshot?seq=N` through `../api/scrub.ts` — the only module
 *   either client materialises a position with — and it then re-watches the
 *   projection set at that `seq`, so an event below it cannot be folded even if
 *   a backfill offers one.
 * - **Ship a dev-only assertion.** `counts()` is what `../app/leak-assert.ts`
 *   prints every sixty seconds in dev, and it is wired at the composition root
 *   behind `import.meta.env.DEV` so the tag never reaches production.
 *
 * ## What a scrub position is, and is not
 *
 * A snapshot is the *server's* fold: a `RunState` from `@DeFlow/core`, held in
 * `runState`. It is not the seven projections — those answer questions
 * (`RunState` carries no timeline lanes, no packet segments, no taints) that
 * the snapshot endpoint does not answer, and inventing them from it would be
 * this store deriving domain state, which is the one thing it may not do. So a
 * scrubbed position renders from `runState`, and the seven projections re-base
 * at the snapshot's `seq` and fold the tail forward from there.
 */
import type { Event, EventKind, RunState } from '@DeFlow/core';
import { defineStore } from 'pinia';
import { computed, markRaw, type Ref, ref, type ShallowRef, shallowRef } from 'vue';
import type { ApiClient } from '../api/client.ts';
import { createScrubber, type Scrubber, type ScrubPosition } from '../api/scrub.ts';
import { createLedgerApply, type LedgerApply, type RunLedger } from '../ledger/apply.ts';
import {
  type BlackboardProjection,
  blackboardProjection,
  type ContextProjection,
  type CostProjection,
  contextProjection,
  costProjection,
  type GatesProjection,
  gatesProjection,
  type PlanHistoryProjection,
  type PlanProjection,
  PROJECTIONS,
  type ProjectionModule,
  planHistoryProjection,
  planProjection,
  type TimelineProjection,
  timelineProjection,
} from '../ledger/projections/index.ts';
import {
  EVENT_KIND_OWNERS,
  PROJECTION_NAMES,
  type ProjectionName,
} from '../ledger/projections/kinds.ts';
import { createEventRing, DEBUG_RING_CAP } from '../ledger/ring.ts';
import type { PlanEdgeVM, PlanNodeVM, TimelineSpanVM } from '../ledger/vm.ts';
import {
  copy,
  copySpan,
  edgeUnchanged,
  memoise,
  shallowUnchanged,
  spanUnchanged,
} from './memoise.ts';

/**
 * The four counters `../app/leak-assert.ts` prints, and the four candidates
 * EPIC-16-S27 names when a soak fails on heap growth — in that order.
 */
export interface RunStoreCounts {
  /** Bounded by the plan. */
  readonly nodes: number;
  /** Bounded by the plan. */
  readonly facts: number;
  /** Envelopes *retained*, which is the ring's length and never the run's. */
  readonly events: number;
  /** Live `Terminal` instances this store adopted and has not disposed. */
  readonly terminals: number;
  /** Reported so raising the ring's cap is visible in the log, not quiet. */
  readonly ringCap: number;
}

/** What the store needs of an `xterm` `Terminal`: that it can be disposed. */
export interface DisposableTerminal {
  dispose(): void;
}

export interface OpenOptions {
  /**
   * The client `scrubTo()` hydrates through. Passed rather than injected so a
   * spec can assert *which request the store made*, and so `packages/cli` can
   * drive the same store against a `--daemon` of its own.
   */
  readonly client?: ApiClient;
  /**
   * How far past a held snapshot `scrubTo()` may fold client-side. `0` — the
   * default — means never, which is the rule for a scrubber over a long run.
   */
  readonly replayWindow?: number;
}

export const useRunStore = defineStore('run', () => {
  // ── the seven containers ───────────────────────────────────────────────────
  //
  // `shallowRef`, so Vue tracks one reference per projection instead of walking
  // a 400-node graph installing proxies. Each holds the state object owned by
  // the `RunLedger` below; the projections mutate it in place and the counter
  // beside it is what a `computed` depends on.
  const plan = shallowRef<PlanProjection>(planProjection.create());
  const planHistory = shallowRef<PlanHistoryProjection>(planHistoryProjection.create());
  const blackboard = shallowRef<BlackboardProjection>(blackboardProjection.create());
  const context = shallowRef<ContextProjection>(contextProjection.create());
  const gates = shallowRef<GatesProjection>(gatesProjection.create());
  const cost = shallowRef<CostProjection>(costProjection.create());
  const timeline = shallowRef<TimelineProjection>(timelineProjection.create());

  /**
   * The same seven, keyed by name for the paths that treat them uniformly —
   * `rebase()` and `close()`, which touch all of them and know none of them.
   *
   * The value types are erased for the same reason `PROJECTIONS`'s element type
   * is `ProjectionModule<never>`: the set is heterogeneous by construction —
   * seven reducers over seven unrelated state types — and the concrete type is
   * recovered through the module object's own identity by `RunLedger.state()`,
   * never through this record. The refs above are the typed surface; these two
   * are the loop.
   */
  const containers = {
    plan,
    planHistory,
    blackboard,
    context,
    gates,
    cost,
    timeline,
  } as unknown as Record<ProjectionName, ShallowRef<unknown>>;

  const modules = {
    plan: planProjection,
    planHistory: planHistoryProjection,
    blackboard: blackboardProjection,
    context: contextProjection,
    gates: gatesProjection,
    cost: costProjection,
    timeline: timelineProjection,
  } as unknown as Record<ProjectionName, ProjectionModule<unknown>>;

  /** One integer per projection. The whole of this store's change detection. */
  const versions = Object.fromEntries(PROJECTION_NAMES.map((name) => [name, ref(0)])) as Record<
    ProjectionName,
    Ref<number>
  >;

  // ── position ───────────────────────────────────────────────────────────────
  const runId = ref<string | null>(null);
  const seq = ref(0);
  const applied = ref(0);
  const runState = shallowRef<RunState | null>(null);
  const hydratedFromSeq = ref(0);
  /**
   * The smallest `seq` folded since the last hydrate, or `null` for none.
   *
   * This is AC7's assertion made observable rather than inferred: after a scrub
   * to `N` it must be strictly greater than `N`, on a run of any length.
   */
  const lowestSeqAppliedSinceHydrate = ref<number | null>(null);

  // ── the bounded debug ring ─────────────────────────────────────────────────
  //
  // `markRaw`, because a Pinia setup store is a `reactive()` over what it
  // returns, and a deep proxy over two thousand envelopes is precisely the cost
  // rule 1 exists to avoid. Its version counter is how a debug pane depends on
  // it without Vue ever looking inside.
  const ring = markRaw(createEventRing<Event>(DEBUG_RING_CAP));
  const ringVersion = ref(0);

  // ── the memoised view models the selectors hand out ───────────────────────
  //
  // Declared here rather than beside the selectors because `rebase()` clears
  // them: they describe a projection set, and a scrub replaces that set.
  const nodeSnapshots = markRaw(new Map<string, PlanNodeVM>());
  const edgeSnapshots = markRaw(new Map<string, PlanEdgeVM>());
  const spanSnapshots = markRaw(new Map<string, TimelineSpanVM>());

  // ── foreign-library instances ──────────────────────────────────────────────
  const terminals = markRaw(new Map<string, DisposableTerminal>());

  let ledger: LedgerApply | null = null;
  let watched: RunLedger | null = null;
  let scrubber: Scrubber | null = null;

  /** The projections a kind is folded into. `[]` for one no view projects. */
  const ownersOf = (kind: EventKind): readonly ProjectionName[] =>
    (EVENT_KIND_OWNERS as Record<string, readonly ProjectionName[]>)[kind] ?? [];

  const bump = (name: ProjectionName): void => {
    versions[name].value += 1;
  };

  const bumpAll = (): void => {
    for (const name of PROJECTION_NAMES) bump(name);
  };

  /**
   * Points the containers at a fresh projection set folded to `fromSeq`.
   *
   * Both `open()` and `scrubTo()` go through here, which is what makes "nothing
   * below the snapshot is applied" one line rather than a rule to remember: the
   * floor lives in the dispatcher, not in a guard at every call site.
   */
  function rebase(id: string, fromSeq: number): void {
    const apply = createLedgerApply({
      projections: PROJECTIONS,
      // The ring is the *only* retention. Nothing else in this store holds the
      // envelope past the end of `applyEvent`.
      onApplied: (event) => {
        ring.push(event);
        ringVersion.value += 1;
      },
    });
    const run = apply.watch(id, { fromSeq });

    for (const name of PROJECTION_NAMES) {
      containers[name].value = run.state(modules[name]);
    }

    ledger = apply;
    watched = run;
    // The snapshot caches belong to the projection set that was just replaced.
    // `memoise` prunes them on the next read, but only for a caller that reads;
    // a tab that scrubbed and then closed the panel would hold a plan's worth
    // of view models for a projection set nobody can reach.
    nodeSnapshots.clear();
    edgeSnapshots.clear();
    spanSnapshots.clear();
    seq.value = fromSeq;
    hydratedFromSeq.value = fromSeq;
    lowestSeqAppliedSinceHydrate.value = null;
    ring.clear();
    ringVersion.value += 1;
    bumpAll();
  }

  /** Opens the store on a run. Idempotent for the run already open. */
  function open(id: string, options: OpenOptions = {}): void {
    if (runId.value !== null && runId.value !== id) close();
    if (runId.value !== id) {
      runId.value = id;
      rebase(id, 0);
    }
    scrubber =
      options.client === undefined
        ? scrubber
        : createScrubber(options.client, id, { replayWindow: options.replayWindow ?? 0 });
  }

  /**
   * Closes it, and **disposes every terminal it adopted**.
   *
   * An undisposed `Terminal` is one of the four things EPIC-16-S27's soak
   * counts, and it is the one a component can leak silently: the panel closes,
   * the DOM node goes, and the xterm buffer plus its WebGL context stay.
   */
  function close(): void {
    disposeAllTerminals();
    if (ledger !== null && runId.value !== null) ledger.unwatch(runId.value);
    ledger = null;
    watched = null;
    scrubber = null;
    runId.value = null;
    runState.value = null;
    for (const name of PROJECTION_NAMES) {
      containers[name].value = modules[name].create();
    }
    seq.value = 0;
    applied.value = 0;
    hydratedFromSeq.value = 0;
    lowestSeqAppliedSinceHydrate.value = null;
    ring.clear();
    ringVersion.value += 1;
    bumpAll();
  }

  /**
   * Folds one envelope, and drops it.
   *
   * Returns whether it was applied — `false` for a duplicate, for an event at
   * or below the hydrated floor, and for a run this store is not showing. The
   * drop is reported rather than swallowed so a panel can tell "nothing new"
   * from "nothing arrived" (docs/11 §5).
   */
  function applyEvent(event: Event): boolean {
    if (ledger === null || runId.value === null || event.runId !== runId.value) return false;
    if (!ledger.apply(event)) return false;

    seq.value = event.seq;
    applied.value += 1;
    const lowest = lowestSeqAppliedSinceHydrate.value;
    if (lowest === null || event.seq < lowest) lowestSeqAppliedSinceHydrate.value = event.seq;
    for (const name of ownersOf(event.kind)) bump(name);
    return true;
  }

  /**
   * Hydrates the position at `seq` from `GET …/snapshot?seq=N` and re-bases the
   * projections there. `'head'` is the run's head — how a tab returns to live.
   *
   * One request, and the fold is the server's: SQLite reduced 10,000
   * control-plane events to state in **29 ms** (verified 2026-08-02), and the
   * same fold in JavaScript freezes the tab on a multi-hour run.
   */
  async function scrubTo(target: number | 'head'): Promise<ScrubPosition | null> {
    const id = runId.value;
    if (scrubber === null || id === null) return null;

    const position = await scrubber.positionAt(target);
    rebase(id, position.seq);
    runState.value = position.state;
    return position;
  }

  // ── selectors ──────────────────────────────────────────────────────────────
  //
  // Each reads its projection's counter and derives an array of **snapshots**,
  // reusing the previous snapshot object for every entry whose contents did not
  // change. That last clause is the whole design, and it is worth being precise
  // about why, because the obvious two alternatives are both wrong:
  //
  // - **Handing out the projection's live objects** costs nothing to build and
  //   never updates the screen. The projection mutates a node in place, so the
  //   prop a child component holds is the same reference it already had, Vue's
  //   `shouldUpdateComponent` skips it, and the node's phase changes everywhere
  //   except in the DOM. `./run-store-rendering.test.ts` is that failure caught.
  // - **Rebuilding a fresh object per node per event** updates the screen and
  //   re-renders all four hundred components for one node's progress event.
  //
  // Memoising by content gets both: exactly the changed node's child is patched,
  // and the array's other entries are the identical objects they were. The cost
  // is one array plus a shallow compare per node — paid **per render, not per
  // event**, because a `computed` is lazy and Vue batches: fifty progress events
  // in one tick recompute this once. That is the reading of docs/12 §4's *"do
  // not reassign a 2,000-entry array on every node.progress event"* that
  // survives contact with a renderer.
  //
  // The snapshots are frozen, which is also what keeps them off Vue's proxy
  // path: `reactive()` returns a non-extensible object unchanged.
  const planNodes = computed<readonly PlanNodeVM[]>(() => {
    void versions.plan.value;
    return memoise(nodeSnapshots, plan.value.nodes, shallowUnchanged, copy);
  });

  const planEdges = computed<readonly PlanEdgeVM[]>(() => {
    void versions.plan.value;
    return memoise(edgeSnapshots, plan.value.edges, edgeUnchanged, copy);
  });

  const timelineSpans = computed<readonly TimelineSpanVM[]>(() => {
    void versions.timeline.value;
    return memoise(spanSnapshots, timeline.value.spans, spanUnchanged, copySpan);
  });

  // ── foreign libraries ──────────────────────────────────────────────────────

  /**
   * Marks `value` as off-limits to Vue and hands it back.
   *
   * The seam rule 2 is about: everything given to Vue Flow, ELK, xterm or d3
   * goes through here or through `adoptTerminal`, so "is this a proxy?" is
   * answered once, in one place, instead of at four call sites that each looked
   * fine in review.
   */
  const adopt = <T extends object>(value: T): T => markRaw(value);

  /** Adopts a terminal under `key`, replacing and disposing any it displaces. */
  function adoptTerminal<T extends DisposableTerminal>(key: string, terminal: T): T {
    disposeTerminal(key);
    terminals.set(key, markRaw(terminal));
    return terminal;
  }

  function disposeTerminal(key: string): void {
    const held = terminals.get(key);
    if (held === undefined) return;
    terminals.delete(key);
    held.dispose();
  }

  function disposeAllTerminals(): void {
    for (const key of [...terminals.keys()]) disposeTerminal(key);
  }

  /** The four counters, sampled. Cheap: every one is a `.size`. */
  const counts = (): RunStoreCounts => ({
    nodes: plan.value.nodes.size,
    facts: blackboard.value.facts.size,
    events: ring.size,
    terminals: terminals.size,
    ringCap: ring.cap,
  });

  return {
    // state
    runId,
    seq,
    applied,
    runState,
    hydratedFromSeq,
    lowestSeqAppliedSinceHydrate,
    ring,
    ringVersion,
    plan,
    planHistory,
    blackboard,
    context,
    gates,
    cost,
    timeline,

    // change detection
    version: (name: ProjectionName): number => versions[name].value,
    /** The `shallowRef` itself, for the spec that asserts it is one. */
    containerFor: (name: ProjectionName): ShallowRef<unknown> => containers[name],
    bump,

    // selectors
    planNodes,
    planEdges,
    timelineSpans,

    // lifecycle
    open,
    close,
    applyEvent,
    scrubTo,
    appliedCount: () => watched?.appliedCount() ?? 0,

    // foreign libraries and diagnostics
    adopt,
    adoptTerminal,
    disposeTerminal,
    disposeAllTerminals,
    counts,
  };
});

export type RunStore = ReturnType<typeof useRunStore>;
