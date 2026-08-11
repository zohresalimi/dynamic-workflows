/**
 * KAR-17.9 AC8 — the scope cut is a decision the numbers make, and it is
 * recorded rather than remembered.
 *
 * Verifies: EPIC-17-S34 · AC8
 *
 * > Given KAR-17.9 has status "Blocked"
 * > Then it stays blocked until `docs/measurements/vue-flow-400.md` exists
 * > And the decision to build or defer is recorded in that file, with the
 * > numbers that drove it
 *
 * The flow file marks that scenario *"automated at: manual (a recorded
 * decision)"*, and a manual check is exactly how a decision becomes folklore:
 * the file says one thing, the repository does another, and the disagreement is
 * discovered by whoever next asks why there are two graph surfaces. So the
 * decision is **derived** here from the committed measurement and checked
 * against what the application actually ships — the same shape as
 * `./graph-culling-default.test.ts`, which does this for the culling default.
 *
 * Re-measure below the budget and this fails, naming the file that decides it
 * and the roadmap paragraph that says what to do: culling becomes the plan
 * graph's default and the memory graph slips to M2, with F10.4's M1 coverage
 * falling to KAR-17.3's provenance table.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

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

const MEASUREMENT_JSON = 'docs/measurements/vue-flow-400.json';
const MEASUREMENT_MD = 'docs/measurements/vue-flow-400.md';

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const committed = JSON.parse(read(MEASUREMENT_JSON)) as Committed;
const record = read(MEASUREMENT_MD);
const router = read('packages/web/src/router/index.ts');

/**
 * Whether the measurement supports a **second** Vue Flow surface.
 *
 * Not the tolerance-based ceiling `./graph-culling-default.test.ts` uses, and
 * the difference matters: that ceiling is derived from the same run it judges —
 * the budget is the worst of the two passes — so it admits any number a
 * re-measurement happens to produce. That is the right test for *"has this
 * regressed"* and the wrong one for *"is a second graph affordable"*.
 *
 * The bar here is absolute and is NF3's: `budget.floorMs` is two frames at
 * 60 Hz, and it is the same comparison the measurement file's own verdict
 * paragraph makes — *"render and interact inside two frames at the 95th
 * percentile with culling off"*. A future re-run that puts the uncalled pass
 * above it flips this, and roadmap §3's recommendation applies.
 */
const uncalled = committed.measurement.passes.find((pass) => !pass.culling) as Pass;
const supported =
  uncalled.pan.p95Ms <= committed.budget.floorMs && uncalled.zoom.p95Ms <= committed.budget.floorMs;

suite('EPIC-17-S34 — the measurement decides whether this view ships at all', () => {
  it('has a measurement to decide from, with four hundred nodes in it', () => {
    // The control. A derivation from an empty file agrees with anything.
    expect(committed.measurement.passes).toHaveLength(2);
    expect(uncalled.nodes).toBeGreaterThanOrEqual(400);
  });

  it('records the decision in the measurement file, beside the number', () => {
    expect(record).toContain('KAR-17.9');
    expect(record).toMatch(
      supported ? /KAR-17\.9[^\n]*(ships|shipped|built)/ : /KAR-17\.9[^\n]*(slips|deferred|M2)/,
    );
  });

  it('ships the memory route exactly while the numbers support it', () => {
    const built = router.includes('MemoryGraphView.vue') && router.includes("name: 'run-memory'");

    expect(
      built,
      supported
        ? `${MEASUREMENT_JSON} says 400 nodes render inside two frames with culling off, so a ` +
            'second graph surface is affordable and KAR-17.9 ships — see "What the number decides".'
        : `${MEASUREMENT_JSON} no longer supports a second graph surface. Per that file and ` +
            'roadmap §3, KAR-17.9 slips to M2 and F10.4’s M1 coverage is KAR-17.3’s provenance ' +
            'table plus the blackboard.ts projection.',
    ).toBe(supported);
  });

  it('keeps the route lazy, whichever way the decision went', () => {
    // AC5, and the reason it survives a re-measure: if the numbers ever stop
    // supporting the view, the thing that has to leave the boot chunk is
    // already outside it.
    expect(router).not.toMatch(/^import MemoryGraphView/m);
  });
});
