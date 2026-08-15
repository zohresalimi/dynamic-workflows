/**
 * The run's approval-gate node id, as a plain string, in a module that imports
 * nothing.
 *
 * `SPEC_GATE_NODE` in `./spec-approval.ts` is the branded `NodeId` and stays
 * the value nearly everything uses — it is parsed through `NodeIdSchema` at
 * module load, which is what makes a typo here a startup failure rather than a
 * gate nobody can answer. What it costs is `./ids.ts`, and therefore zod.
 *
 * That is a fine price on the daemon and an unaffordable one in the browser's
 * **initial** chunk, which `packages/web/test/integration/bundle-budget.test.ts`
 * holds at 200 KB gzip and explicitly forbids zod from
 * (`expect(holds(initial, 'zod')).toBe(false)`). KAR-22.5's gate panel is in
 * `App.vue`'s eager graph and needs to do exactly one thing with this id —
 * compare against it, to decide which endpoint answers the gate — so the
 * literal it is parsed from lives here, importable without the schema layer.
 *
 * One source, two forms: `./spec-approval.ts` parses **this** constant, so the
 * branded value and the literal cannot drift apart.
 */

/** `spec-approval` — one per run, and well-known. @see ./spec-approval.ts */
export const SPEC_GATE_NODE_ID = 'spec-approval';
