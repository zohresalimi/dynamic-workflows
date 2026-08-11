/**
 * KAR-17.1 AC8 — `onlyRenderVisibleElements` is set **per the measurement**.
 *
 * Verifies: EPIC-17-S4 (scenario 1, the configuration clause) · AC8
 *
 * > On `stress-400`, the view meets the budget recorded in
 * > `docs/measurements/vue-flow-400.md`, **with `onlyRenderVisibleElements` set
 * > per that measurement**.
 *
 * The first half of that sentence is `e2e/measure-graph.test.ts`: it re-runs
 * the whole 400-node measurement against a real `DeFlow replay stress-400`
 * daemon and fails if the p95 frame time regresses. This file is the second
 * half, and it is a different claim — that the **default the application ships
 * with** is the one the measurement's numbers actually argue for.
 *
 * Nothing else checks that, and the way it breaks is quiet: somebody flips the
 * flag because culling *sounds* faster, every existing spec stays green (both
 * settings render a correct graph), the frame budget still passes because both
 * passes were inside it — and the plan graph now re-mounts every node body as
 * it scrolls into view, so the state chip and the streaming badge flicker on
 * every pan. The measurement file says exactly that, and says the flag stays
 * off *because* the measured pass without culling met the budget.
 *
 * So the assertion is a derivation rather than a duplicated constant: read the
 * committed numbers, work out which pass the recorded budget admits, and
 * require `defaults.ts` to agree. Re-measure and the default follows; flip the
 * default by hand and this fails naming the file that decides it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { GRAPH_DEFAULTS } from '../packages/web/src/components/graph/defaults.ts';

interface Pass {
  readonly culling: boolean;
  readonly nodes: number;
  readonly pan: { readonly p95Ms: number };
  readonly zoom: { readonly p95Ms: number };
}

interface Committed {
  readonly budget: {
    readonly p95PanMs: number;
    readonly p95ZoomMs: number;
    readonly tolerance: number;
    readonly floorMs: number;
  };
  readonly measurement: { readonly passes: readonly Pass[] };
}

const MEASUREMENT = 'docs/measurements/vue-flow-400.json';

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL(`../${MEASUREMENT}`, import.meta.url)), 'utf8'),
) as Committed;

/** The ceiling the e2e spec holds a re-run to, ignoring that run's own idle. */
const ceiling = (recorded: number): number =>
  Math.max(recorded * committed.budget.tolerance, committed.budget.floorMs);

suite('AC8 — the culling default is a conclusion, not a preference', () => {
  it('reads a measurement with both passes in it', () => {
    // The control: a derivation from an empty file would "agree" with anything.
    expect(committed.measurement.passes).toHaveLength(2);
    expect(committed.measurement.passes.map((pass) => pass.culling).toSorted()).toEqual([
      false,
      true,
    ]);
    for (const pass of committed.measurement.passes) expect(pass.nodes).toBeGreaterThanOrEqual(400);
  });

  it('names the file the numbers live in, so a re-run knows what to update', () => {
    expect(GRAPH_DEFAULTS.measuredBy).toContain('docs/measurements/vue-flow-400');
  });

  it('leaves culling off exactly while the uncalled pass meets the budget', () => {
    const uncalled = committed.measurement.passes.find((pass) => !pass.culling) as Pass;

    // *"`onlyRenderVisibleElements` stays off by default"* is true only for as
    // long as four hundred nodes render inside the budget **without** it.
    // Culling is not free — every node body re-mounts as it scrolls into view,
    // so the state chip and the streaming badge flicker during a pan — so the
    // rule is: off while it can be, on the moment the numbers say otherwise.
    const affordable =
      uncalled.pan.p95Ms <= ceiling(committed.budget.p95PanMs) &&
      uncalled.zoom.p95Ms <= ceiling(committed.budget.p95ZoomMs);

    expect(
      GRAPH_DEFAULTS.onlyRenderVisibleElements,
      affordable
        ? `${MEASUREMENT} says 400 nodes render inside the budget with culling off, so ` +
            'the plan graph must not pay for culling — see "What the number decides".'
        : `${MEASUREMENT} no longer meets the budget without culling. Per that file and ` +
            'roadmap §3, culling becomes the default and KAR-17.9 slips to M2.',
    ).toBe(!affordable);
  });
});
