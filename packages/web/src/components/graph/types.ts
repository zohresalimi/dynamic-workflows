/**
 * KAR-16.6 AC1 — the facade's surface, as types.
 *
 * > Its public props and events are DeFlow types, and **no Vue Flow type
 * > appears in its exported surface**.
 *
 * That claim needs somewhere to live that a swap cannot quietly change, so it
 * lives here: one file, importing `PlanNodeVM` and `PlanEdgeVM` and nothing
 * else, which both `./GraphCanvas.vue` and the stub renderer beside it declare
 * their props from. A renderer that needed one extra option "just for now"
 * would have to add it here, in front of everybody, rather than to a
 * `defineProps` block nobody reads.
 */
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';

/** A pair of corners: `[[minX, minY], [maxX, maxY]]`. */
export type Extent = readonly [readonly [number, number], readonly [number, number]];

/**
 * Where each node goes, as plain numbers.
 *
 * Named rather than written inline because both renderers hold one and the
 * layout produces one, and three spellings of the same map is how a `readonly`
 * drifts off one of them.
 */
export type NodePlacement = ReadonlyMap<string, { readonly x: number; readonly y: number }>;

export interface GraphCanvasProps {
  /** The plan's nodes, in **ledger-insertion order** (see `./layout.ts`). */
  readonly nodes: readonly PlanNodeVM[];
  readonly edges: readonly PlanEdgeVM[];
  /** The node the operator has selected, if any. */
  readonly selected?: string | null;
  /**
   * Per-node cost, already in the money vocabulary its owner uses. The graph
   * renders it in the table and never computes it: four kinds of spend live
   * behind `CostFigures`, and a canvas is the wrong place to pick one.
   */
  readonly costs?: ReadonlyMap<string, string>;
  /**
   * Positions computed elsewhere — the plan-evolution scrubber's union-graph
   * layout (KAR-17.2), laid out once and cached so a surviving node cannot move
   * between versions. Given these, the canvas runs no layout of its own.
   */
  readonly positions?: NodePlacement;
  /** AC9's three knobs, defaulted from `./defaults.ts`. */
  readonly onlyRenderVisibleElements?: boolean;
  readonly elevateNodesOnSelect?: boolean;
  readonly nodeExtent?: Extent;
  readonly fitViewOnInit?: boolean;
}

export interface GraphCanvasEmits {
  /** The operator moved to a node — by click, or by focus traversal. */
  (event: 'select', nodeId: string): void;
  /** The operator opened one: Enter, or a double click. */
  (event: 'activate', nodeId: string): void;
  /** A layout finished. `ms` is what AC3's initial-layout number is read off. */
  (event: 'laid-out', detail: { ms: number; nodes: number }): void;
}

export interface GraphCanvasSlots {
  node(props: { node: PlanNodeVM; selected: boolean }): unknown;
}

/**
 * The accessible name every renderer must give a node
 * (docs/12-frontend-architecture.md §9.3):
 * `` `${node.type} ${node.title}, ${node.state}, ${node.provider}` ``.
 *
 * Here rather than in the component because it is a promise about the *graph*,
 * not about one implementation of it — a screen-reader user must hear the same
 * sentence whichever renderer is drawing. The two nullable halves degrade to
 * words: a node exists in the plan before any `node.started` says what will run
 * it, and "null title, running, null" is worse than saying neither.
 */
export function ariaLabelOf(node: PlanNodeVM): string {
  const kind = node.type ?? 'node';
  const by = node.provider === null ? 'no provider yet' : node.provider;
  return `${kind} ${node.title}, ${node.state}, ${by}`;
}
