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

export interface MeasureApi {
  render(request: RenderRequest): Promise<RenderResult>;
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
