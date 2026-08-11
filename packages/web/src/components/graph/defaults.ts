/**
 * KAR-16.6 AC9 — the renderer's three knobs, defaulted from the measurement.
 *
 * > `onlyRenderVisibleElements`, `elevateNodesOnSelect` and `nodeExtent` are
 * > configurable through the facade's props, **defaulting from the measurement
 * > rather than from taste**.
 *
 * So they live in a file of their own, next to the facade, with the run that
 * decided them named in `measuredBy`. `docs/measurements/vue-flow-400.md` is
 * the record: the machine, the Chromium build, the fixture, the four numbers
 * with culling on and off, and the command that reproduces them.
 *
 * Re-run `pnpm measure:graph` when the Vue or Vue Flow pin moves and change
 * these if the numbers changed — 3.6's reactivity rewrite could shift them
 * either way, and Vue Flow's store leans hard on the internals 3.6 rewrites.
 */
export interface GraphDefaults {
  /**
   * Cull nodes outside the viewport.
   *
   * Measured off by default: with 400 nodes the p95 frame time during a
   * scripted pan stayed inside the budget without it, and culling costs a
   * visible re-mount of every node body as it scrolls into view — which for
   * this graph means the streaming badge and the state chip flicker on pan.
   * The number that would flip this is in the measurement file.
   */
  readonly onlyRenderVisibleElements: boolean;
  /** A selected node draws over its neighbours rather than under them. */
  readonly elevateNodesOnSelect: boolean;
  /** Where the measurement that set these lives. */
  readonly measuredBy: string;
}

export const GRAPH_DEFAULTS: GraphDefaults = {
  onlyRenderVisibleElements: false,
  elevateNodesOnSelect: true,
  measuredBy: 'docs/measurements/vue-flow-400.md',
};
