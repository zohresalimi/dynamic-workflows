/**
 * KAR-16.6 — graph layout, behind the facade.
 *
 * Verifies: EPIC-16-S37, EPIC-16-S38 · AC5, AC6
 *
 * `GraphCanvas.vue` is the only importer of this module and this module is the
 * only importer of `elkjs`, so "which engine lays the plan out" is a question
 * with one answer in one directory — which is the same promise AC10 makes about
 * the renderer, for the same reason.
 *
 * ## Off the main thread, in the built output
 *
 * The recipe is S3's, verified against `vite build` output served over plain
 * HTTP rather than against a dev server: `./elk.worker.ts?worker` plus ELK's
 * `workerFactory`. `?worker` is what teaches Vite the file is a worker entry,
 * so it gets its own chunk, its own hash and a URL the built bundle already
 * knows. What the application imports is `elk-api.js` — a ~10 KB promise
 * wrapper — and a worker *reference*; the 1.4 MB never enters the module graph
 * of the page. `?worker&inline` would undo exactly that, and elkjs's own
 * `workerUrl` option cannot survive asset hashing at all.
 *
 * ## Stability is model order — and one more option than the plan says
 *
 * `considerModelOrder.strategy = NODES_AND_EDGES` plus a node array in
 * **ledger-insertion order** is the mechanism AC6 names, and on elkjs 0.12.0 it
 * is not sufficient on its own. Measured here on the 60-node fixture:
 * with the strategy set and nothing else, inserting a node reshuffles the
 * existing ones exactly as it does with no options at all. Adding
 * `crossingMinimization.forceNodeModelOrder = true` is what makes it bite, and
 * with both set the pre-existing nodes keep their relative order across the
 * insertion while their coordinates all move.
 *
 * That is the same shape of finding S3 recorded for the constraint options —
 * an option that is accepted, is listed by `knownLayoutOptions()`, and does
 * nothing observable on its own — so it is stated here and asserted by the
 * control in `./layout.test.ts`, which lays the same graph out with
 * `forceNodeModelOrder` off and watches the ordering break.
 *
 * The alternative everybody reaches for does not work at all: S3 executed
 * `layerChoiceConstraint` and `positionChoiceConstraint` on elkjs 0.12.0 and
 * found them inert — inert *with* `interactiveLayout: true` as well, and the
 * one configuration that appears to obey them produces a byte-identical drawing
 * with no constraint at all. So they are absent here on purpose, and
 * `./layout.test.ts` asserts their absence rather than trusting this paragraph.
 *
 * The ordering contract is why `layout()` takes an **array** rather than the
 * projection's `Map`: an array has an order a caller can be held to, and the
 * store's `planNodes` selector already produces it in the order the ledger
 * created the nodes in.
 */
import ElkModule, {
  type ELK,
  type ELKConstructorArguments,
  type ElkNode,
} from 'elkjs/lib/elk-api.js';
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import ElkWorker from './elk.worker.ts?worker';

/**
 * ELK's constructor, under a type TypeScript will accept.
 *
 * `elk-api.js` is UMD — GWT output wrapped for browsers, Node and AMD at once —
 * and its hand-written `.d.ts` declares an ES module `export default`. Under
 * `moduleResolution: nodenext` those two disagree and the compiler resolves the
 * default import to the module *namespace*: correct at runtime (Vite's interop
 * hands back the constructor, which is why every layout spec passes) and not
 * constructable on paper. The cast is that mismatch, named once, rather than an
 * `any` at the call site.
 */
const ElkConstructor = ElkModule as unknown as new (args?: ELKConstructorArguments) => ELK;

/**
 * The box the renderer draws a node at.
 *
 * ELK spaces boxes, not points, so this has to be the size `GraphCanvas`
 * actually renders or the drawing is spaced for a graph nobody sees. It is
 * exported so the component and the engine cannot disagree about it.
 */
export const NODE_SIZE = { width: 224, height: 84 } as const;

/**
 * One set of options for every layout, so two layouts are comparable.
 *
 * `elk.algorithm: layered` is load-bearing beyond taste: `considerModelOrder`
 * is a `layered` option, and under any other algorithm it is silently ignored.
 */
export const LAYOUT_OPTIONS: Readonly<Record<string, string>> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'org.eclipse.elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // The half the plan does not name, and the half that does the work — see the
  // module comment. Without it the strategy above is accepted and inert.
  'org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
};

/** Where one node landed. Plain numbers: no ELK type reaches a component. */
export interface NodePosition {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphLayout {
  readonly positions: ReadonlyMap<string, NodePosition>;
  readonly width: number;
  readonly height: number;
  /** Wall-clock milliseconds the engine took. What AC3's number is read off. */
  readonly ms: number;
}

/** The graph as ELK is given it. Structural, so a spec can assert on it. */
export interface ElkGraph {
  readonly id: string;
  readonly layoutOptions: Readonly<Record<string, string>>;
  readonly children: readonly { readonly id: string; width: number; height: number }[];
  readonly edges: readonly {
    readonly id: string;
    readonly sources: readonly string[];
    readonly targets: readonly string[];
  }[];
}

export interface LayoutEngine {
  layout(nodes: readonly PlanNodeVM[], edges: readonly PlanEdgeVM[]): Promise<GraphLayout>;
  /** Terminates the worker. A canvas that unmounts without this leaks one. */
  dispose(): void;
}

/**
 * The plan, in ELK's shape.
 *
 * `nodes` is copied in the order it arrives and never sorted: that order is the
 * ledger's, and it is the input `considerModelOrder` reads. A mapper that
 * walked a `Map` it built for itself would be stable by luck until the day the
 * keys changed shape.
 */
export function toElkGraph(
  nodes: readonly PlanNodeVM[],
  edges: readonly PlanEdgeVM[],
  overrides: Readonly<Record<string, string>> = {},
): ElkGraph {
  const known = new Set(nodes.map((node) => node.id));
  return {
    id: 'root',
    layoutOptions: { ...LAYOUT_OPTIONS, ...overrides },
    children: nodes.map((node) => ({
      id: node.id,
      width: NODE_SIZE.width,
      height: NODE_SIZE.height,
    })),
    // An edge to a node the plan no longer holds makes ELK throw rather than
    // draw, and a replan that abandoned a subtree is exactly when that arrives.
    edges: edges
      .filter((edge) => known.has(edge.from) && known.has(edge.to))
      .map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
}

/** Reads a laid-out ELK graph back into plain positions. */
function positionsOf(laidOut: ElkNode): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
  for (const child of laidOut.children ?? []) {
    positions.set(child.id, {
      id: child.id,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? NODE_SIZE.width,
      height: child.height ?? NODE_SIZE.height,
    });
  }
  return positions;
}

/**
 * A layout engine backed by one worker.
 *
 * Created per canvas rather than as a module singleton: two canvases on one
 * page would otherwise queue behind each other, and a singleton's worker
 * outlives every component that ever used it, which is one of the four things
 * EPIC-16-S27's soak counts.
 */
export function createLayoutEngine(overrides: Readonly<Record<string, string>> = {}): LayoutEngine {
  let worker: Worker | null = null;
  const elk: ELK = new ElkConstructor({
    workerFactory: () => {
      worker = new ElkWorker();
      return worker;
    },
  });

  return {
    async layout(nodes, edges): Promise<GraphLayout> {
      const started = performance.now();
      if (nodes.length === 0) {
        return { positions: new Map(), width: 0, height: 0, ms: performance.now() - started };
      }

      const laidOut = await elk.layout(toElkGraph(nodes, edges, overrides) as ElkNode);
      return {
        positions: positionsOf(laidOut),
        width: laidOut.width ?? 0,
        height: laidOut.height ?? 0,
        ms: performance.now() - started,
      };
    },

    dispose(): void {
      worker?.terminate();
      worker = null;
    },
  };
}
