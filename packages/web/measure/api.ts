/**
 * The measurement harness's contract, as types only.
 *
 * Imported by three files that must agree and cannot share a runtime: the page
 * (`./main.ts`, in a browser), the script that drives it
 * (`../scripts/measure-graph.ts`, in Node) and the two specs that assert on the
 * result. Keeping it here rather than in `./main.ts` is what lets the Node side
 * name these shapes without importing a module that touches `document` on load.
 *
 * The e2e slice compiles without the DOM lib, so everything the page knows
 * about the DOM is answered *in the page* and handed back as data — the same
 * shape `e2e/spike-s3-elk-worker.test.ts` uses, for the same reason.
 */
export interface RenderRequest {
  /** Raw envelopes, exactly as `…/events` returned them. */
  readonly events: readonly unknown[];
  readonly onlyRenderVisibleElements: boolean;
  /** Render only the first `n` nodes — the small-graph control. */
  readonly limit?: number;
}

export interface RenderResult {
  readonly nodes: number;
  readonly edges: number;
  /** What ELK took, off the main thread, as the canvas reported it. */
  readonly layoutMs: number;
  /** Mount → every node of the graph on screen. */
  readonly firstPaintMs: number;
  readonly unreadableEvents: number;
}

/** What actually reached the DOM, read in the page. */
export interface DrawnGraph {
  readonly count: number;
  /** The first node's accessible name, as a screen reader would hear it. */
  readonly firstLabel: string;
  /** The first node's title, as the caller's `#node` slot rendered it. */
  readonly firstTitle: string;
  /** `'stub'` when the swapped-in renderer drew this, `'vue-flow'` otherwise. */
  readonly renderer: string;
}

/**
 * KAR-17.9 test plan row 7 — render the **memory** graph through the facade.
 *
 * The same harness, the same `GraphCanvas`, a different projection: the
 * blackboard folded from the same recording and aggregated by
 * `../src/ledger/projections/memory-graph.ts`. What it exists to prove is that
 * the second graph surface goes through the facade as completely as the first —
 * a renderer swap that left the memory view broken would be a swap that is not
 * a one-file change.
 */
export interface MemoryRenderRequest {
  readonly events: readonly unknown[];
  /** A producing node to expand, so fact nodes are drawn as well as bubbles. */
  readonly expand?: string;
}

export interface MemoryRenderResult {
  /** Facts on the blackboard the recording folded to. */
  readonly facts: number;
  /** Nodes drawn: bubbles, plus the expanded producer's page of facts. */
  readonly drawn: number;
  /** Of those, how many are facts rather than aggregate bubbles. */
  readonly drawnFacts: number;
  /** Every node body's `data-memory-kind`, in the order they were drawn. */
  readonly kinds: readonly string[];
  /** `'stub'` when the swapped-in renderer drew this, `'vue-flow'` otherwise. */
  readonly renderer: string;
  /** The first bubble's accessible name, as a screen reader would hear it. */
  readonly firstLabel: string;
}

export interface MeasureApi {
  render(request: RenderRequest): Promise<RenderResult>;
  renderMemory(request: MemoryRenderRequest): Promise<MemoryRenderResult>;
  /** Starts sampling animation frames. */
  startFrames(): void;
  /** Stops sampling and returns the intervals, in milliseconds. */
  stopFrames(): number[];
  drawn(): DrawnGraph;
}

/** The one global the harness exposes. */
export interface MeasureGlobal {
  __deflowMeasure: MeasureApi;
}
