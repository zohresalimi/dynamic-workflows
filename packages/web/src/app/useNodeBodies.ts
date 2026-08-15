/**
 * KAR-22.3 AC3 — the node-body join, **once per store**.
 *
 * A node body is the join of four projections — the plan node, its timeline
 * span, the last gate verdict against it and its cost bucket — plus the tab's
 * own clock, so a running node's elapsed time moves. `../components/graph/
 * node-body.ts` owns the arithmetic; this owns *who computes it*.
 *
 * It exists because KAR-22.3 renders that join twice: the plan graph draws it
 * as node bodies, and the task board draws it as rows. AC3 says those two "can
 * never disagree", and there are three ways to arrange that, of which only one
 * survives contact with a real run:
 *
 * 1. **Two `computed`s over one store.** Equal by construction in any given
 *    tick — and one memoisation cache per copy, one `useNow` ticker per copy,
 *    and a second place for the next join to be added to only one of them. The
 *    board would lag the graph the first time somebody optimised one of them.
 * 2. **The board reads the graph's array through a prop.** Works, and makes the
 *    board unmountable without the graph — which is exactly what a workspace
 *    with the graph collapsed needs to do.
 * 3. **One shared `computed`, handed to both.** This file. The board and the
 *    graph hold *the same reference*: not two arrays that agree, one array.
 *    "Two views of one projection" becomes a property of the module graph,
 *    which is what `test/one-workspace-surface.test.ts` asserts.
 *
 * ## Why the scope is detached, and refcounted
 *
 * The shared state contains a `useNow` ticker, which is an interval. Created
 * inside the first consumer's component scope it would be *disposed with that
 * component* — so unmounting the graph would freeze the board's clock, which is
 * the kind of bug that gets diagnosed as "the board is stale" three weeks
 * later. So it lives in a detached `effectScope` keyed by the store, and the
 * last consumer to go away stops it. An interval outliving its store is itself
 * a leak, and `../app/leak-assert.ts` would be the thing reporting it.
 */
import { useNow } from '@vueuse/core';
import { type ComputedRef, computed, effectScope, getCurrentScope, onScopeDispose } from 'vue';
import { type NodeBodyVM, toNodeBody } from '../components/graph/node-body.ts';
import { diffPointers } from '../lib/review-index.ts';
import { copy, memoise, shallowUnchanged } from '../stores/memoise.ts';
import { type RunStore, useRunStore } from '../stores/useRunStore.ts';

export type NodeBodies = ComputedRef<ReadonlyMap<string, NodeBodyVM>>;

interface Shared {
  readonly bodies: NodeBodies;
  readonly stop: () => void;
  users: number;
}

/**
 * Keyed by the store instance rather than module-global, because a spec mounts
 * one pinia per case and two of them must not share a ticker or a cache. A
 * `WeakMap` so a torn-down pinia is collectable without anybody deregistering.
 */
const shared = new WeakMap<RunStore, Shared>();

function build(run: RunStore): NodeBodies {
  /**
   * The tab's clock, at one tick a second.
   *
   * A running node's elapsed time has to move, and the only honest source for
   * "how long has this been going" on an *open* span is now. One shared ticker
   * for every surface rather than a timer per node — four hundred intervals is
   * four hundred wakeups a second — and the arithmetic itself takes `now` as a
   * parameter and reads no clock.
   */
  const now = useNow({ interval: 1000 });

  /**
   * Where each node's verdict points into the diff (KAR-17.6 AC1).
   *
   * Cheap enough to be a plain `computed`: it walks the verdict list, which is
   * bounded by the number of gate evaluations in the run, not by the tick.
   */
  const pointers = computed(() => {
    void run.version('gates');
    return diffPointers(run.gates);
  });

  /**
   * The bodies, memoised **by content**.
   *
   * This is the rule that keeps a one-second tick from re-rendering a
   * four-hundred-node graph: `memoise` reuses the previous body object for
   * every node whose rendered values did not change, so a tick patches exactly
   * the nodes that are actually running. `shallowUnchanged` is exactly right
   * because every field of a `NodeBodyVM` is a primitive.
   */
  const cache = new Map<string, NodeBodyVM>();

  return computed<ReadonlyMap<string, NodeBodyVM>>(() => {
    const at = now.value.getTime();
    const live = new Map<string, NodeBodyVM>(
      run.planNodes.map((node) => [
        node.id,
        toNodeBody({
          node,
          span: run.nodeSpans.get(node.id) ?? null,
          verdict: run.nodeVerdicts.get(node.id) ?? null,
          spend: run.nodeSpend.get(node.id) ?? null,
          now: at,
          pointer: pointers.value.get(node.id) ?? null,
        }),
      ]),
    );
    return new Map(memoise(cache, live, shallowUnchanged, copy).map((body) => [body.id, body]));
  });
}

/**
 * The node bodies for the open run — the same object for every caller.
 *
 * Safe to call outside a component scope (a spec asserting the identity, for
 * instance): the refcount is only decremented where there is a scope to hang
 * the disposal on.
 */
export function useNodeBodies(): NodeBodies {
  const run = useRunStore();

  let held = shared.get(run);
  if (held === undefined) {
    const scope = effectScope(true);
    const bodies = scope.run(() => build(run));
    if (bodies === undefined) throw new Error('the node-body scope was stopped before it ran');
    held = {
      bodies,
      stop: () => {
        scope.stop();
        shared.delete(run);
      },
      users: 0,
    };
    shared.set(run, held);
  }

  const entry = held;
  if (getCurrentScope() !== undefined) {
    entry.users += 1;
    onScopeDispose(() => {
      entry.users -= 1;
      if (entry.users <= 0) entry.stop();
    });
  }

  return entry.bodies;
}
