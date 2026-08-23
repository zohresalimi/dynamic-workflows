/**
 * The retry ceiling and backoff every node inherits, as plain numbers.
 *
 * ## Why they live in a file of their own
 *
 * `DEFAULT_RETRY_POLICY` is assembled from these in `./plan-graph.ts`, three
 * lines under the schema it defaults — which is where the next person editing
 * the shape will read it, and where it stayed until KAR-27.3.
 *
 * What changed is who else needs the number. `./pre-execution-turn.ts` renders
 * *"attempt 2 of 3"*, and that projection is folded in the **browser** as well
 * as in the daemon (`packages/web/src/ledger/projections/liveTurn.ts`).
 * `plan-graph.ts` is one of the largest zod modules in this package; importing
 * it for one integer put the whole of zod into the web application's initial
 * chunk and blew EPIC-16-S5's 220 KB budget by eighteen kilobytes
 * (`packages/web/test/integration/bundle-budget.test.ts` is what said so).
 *
 * The alternative was a second `3` written down in the projection, and a second
 * spelling of a policy constant is exactly the drift that makes *"attempt 2 of
 * 3"* say `3` on one surface and `5` on another the day somebody raises it. A
 * two-constant module with no dependencies costs nothing and keeps one number.
 */

/**
 * F7.5's surgical-repair cap: three attempts, then the node fails for good.
 *
 * `packages/daemon/src/pipeline/turn-failure.ts` bounds a pre-execution turn by
 * this same policy, which is what makes it the honest denominator for the
 * status label's *"attempt N of 3"*.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** docs/05-durable-execution.md §10.3's backoff: 2 s, capped at five minutes,
 * full jitter. */
export const DEFAULT_BACKOFF = Object.freeze({
  base: 2000,
  cap: 300_000,
  jitter: 'full' as const,
});
