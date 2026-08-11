/**
 * The box a plan node is drawn at — one number, three readers.
 *
 * A module of its own, with **no imports at all**, and that is load-bearing
 * rather than tidy. The three files that need this size are:
 *
 * - `./layout.ts`, which hands it to ELK, because ELK spaces boxes and not
 *   points;
 * - `./PlanNode.vue`, which draws at it;
 * - `./GraphCanvas.vue`, whose fallback column needs it when the layout worker
 *   failed to start.
 *
 * And `GraphCanvas.vue` reaches `./layout.ts` **only through a dynamic
 * `import()`**, so that `elkjs` — 1.4 MB of GWT-transpiled Java — gets a chunk
 * of its own instead of riding into the initial one the landing view pays for
 * (KAR-16.1 AC9, held by `packages/web/test/integration/bundle-budget.test.ts`).
 * Importing a *value* from `layout.ts` at the top of the facade would undo that
 * silently: the module graph would pull the layout module, the layout module
 * pulls elkjs, and the only symptom is a bundle budget failing in a test
 * nobody associates with a two-number constant.
 */
export const NODE_SIZE = { width: 248, height: 108 } as const;

/**
 * The vertical stride of the fallback column: a node plus a gap.
 *
 * Used only when the layout worker could not start — a column is a poor
 * drawing and an honest one — but the gap still has to exist, or the fallback
 * renders twelve overlapping boxes.
 */
export const COLUMN_STRIDE = NODE_SIZE.height + 24;
