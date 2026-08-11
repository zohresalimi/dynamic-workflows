/**
 * KAR-17.2 — the union layout, computed **once per version pair** and cached
 * under the `unionLayoutKey` the diff endpoint returns
 * (docs/12-frontend-architecture.md §6.2).
 *
 * Verifies: EPIC-17-S6, EPIC-17-S11 · AC3, AC6
 *
 * This is the load-bearing piece of the whole scrubber, and it is one idea:
 *
 * > Lay out the graph containing every node and edge in **either** version, once,
 * > and render both versions at those coordinates.
 *
 * The property that buys is AC3 — *"nothing moves"* — and the view's entire
 * value depends on it. A implementation that laid each version out
 * independently would satisfy every other criterion in this story and be
 * worthless: on a real 40-node replan the reflow between two adjacent versions
 * is larger than the eye can track, so the operator ends up doing the visual
 * diff by hand, which is the thing the view exists to remove.
 *
 * ## The key is the server's, and it is a key and nothing else
 *
 * `unionLayoutKey` comes back on `GET /api/runs/:id/plans/diff` as
 * `<runId>:union:v<from>-v<to>` (KAR-11.5 AC4). The server computes **no x/y** —
 * it names a pair, and the coordinates are this tab's. It is also marked
 * unversioned on the response (`x-deflow-unversioned`), so nothing here may
 * parse it: it is compared, never read.
 *
 * ## Three things the naive cache gets wrong
 *
 * 1. **The in-flight entry.** A scrub that asks again before the first answer
 *    lands is two ELK calls for one pair. The promise is cached, not the result.
 * 2. **The identity of the answer.** Callers hand these positions to
 *    `GraphCanvas`'s `positions` prop, and a *new* `Map` with the same numbers
 *    in it is a new prop identity, which re-renders four hundred nodes for a
 *    drawing that did not change. The same `Map` comes back every time.
 * 3. **The bound.** A nine-hour run with forty replans has thirty-nine adjacent
 *    pairs plus whatever non-adjacent comparisons were asked for, and an
 *    unbounded `Map` of position sets is precisely the per-run accumulation
 *    KAR-16.4 exists to prevent. Least-recently-used, with a cap that is far
 *    more than a scrub session touches.
 */
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import {
  createLayoutEngine,
  LAYOUT_OPTIONS,
  type LayoutEngine,
  type NodePosition,
} from './layout.ts';

export type UnionPositions = ReadonlyMap<string, NodePosition>;

/**
 * The options the union layout is computed with.
 *
 * The live graph's options, unchanged, and that is the point of stating them
 * here rather than passing nothing: a reader looking for where the
 * interactive-constraint recipe was smuggled in finds this constant, and
 * `./union-layout.test.ts` asserts its absence.
 *
 * **The interactive-ELK experiment is not here and does not need to be.** The
 * commonly-written recipe — each surviving node's previous layer index as
 * `layering.layerChoiceConstraint`, its in-layer index as
 * `crossingMinimization.positionChoiceConstraint` — does not work as written,
 * for three independent reasons S3 measured on elkjs 0.12.0: those options are
 * consumed only under `org.eclipse.elk.interactiveLayout = true`,
 * `semiInteractive` reads `org.eclipse.elk.position` instead, and constraint
 * enforcement is a known elkjs weak spot (A3-5). None of that matters, because
 * the union graph is sufficient on its own — which is the claim EPIC-17-S11
 * exists to keep true.
 */
export const UNION_LAYOUT_OPTIONS: Readonly<Record<string, string>> = LAYOUT_OPTIONS;

/**
 * How many version pairs' coordinates are kept.
 *
 * Sized for a scrub session rather than for a run: an operator steps through
 * adjacent pairs and compares a handful of non-adjacent ones, and thirty-two is
 * comfortably past that while staying a fixed, small number of position maps.
 */
const DEFAULT_CAPACITY = 32;

export interface UnionLayoutCache {
  /**
   * The coordinates for one version pair.
   *
   * `key` is the endpoint's `unionLayoutKey`; `nodes` and `edges` are the union
   * graph (`../../lib/plan-diff.ts`), in the order ELK's `considerModelOrder`
   * should read them.
   */
  positionsFor(
    key: string,
    nodes: readonly PlanNodeVM[],
    edges: readonly PlanEdgeVM[],
  ): Promise<UnionPositions>;
  /** How many times the engine was actually asked. AC6's counter. */
  readonly layouts: number;
  /** How many pairs are held. */
  readonly size: number;
  readonly capacity: number;
  /** Terminates the worker, when this cache owns one. */
  dispose(): void;
}

export interface UnionLayoutOptions {
  readonly capacity?: number;
}

/**
 * A cache over one layout engine.
 *
 * The engine is a parameter so a caller can share the one its canvas already
 * owns — and so a spec can wrap the real one and count what crosses to the
 * worker. Omitted, this creates and owns one, and `dispose()` terminates it.
 */
export function createUnionLayoutCache(
  engine?: LayoutEngine,
  options: UnionLayoutOptions = {},
): UnionLayoutCache {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  const owned = engine === undefined;
  const layoutEngine = engine ?? createLayoutEngine(UNION_LAYOUT_OPTIONS);

  /**
   * `unionLayoutKey` → the promise of its coordinates.
   *
   * A `Map` is insertion-ordered, which is the whole of the LRU: a hit deletes
   * and re-sets, so the first key is always the least recently used one.
   */
  const held = new Map<string, Promise<UnionPositions>>();
  let layouts = 0;

  const touch = (key: string, value: Promise<UnionPositions>): Promise<UnionPositions> => {
    held.delete(key);
    held.set(key, value);
    while (held.size > capacity) {
      const oldest = held.keys().next();
      if (oldest.done === true) break;
      held.delete(oldest.value);
    }
    return value;
  };

  return {
    get layouts() {
      return layouts;
    },
    get size() {
      return held.size;
    },
    capacity,

    positionsFor(key, nodes, edges): Promise<UnionPositions> {
      const existing = held.get(key);
      if (existing !== undefined) return touch(key, existing);

      layouts += 1;
      const pending = layoutEngine
        .layout(nodes, edges)
        .then((result) => result.positions)
        .catch((cause: unknown) => {
          // A failed layout must not be cached: the next scrub over this pair
          // would otherwise re-throw an error from a worker that has since
          // recovered, for the rest of the tab's life.
          held.delete(key);
          layouts -= 1;
          throw cause;
        });

      return touch(key, pending);
    },

    dispose(): void {
      held.clear();
      if (owned) layoutEngine.dispose();
    },
  };
}
