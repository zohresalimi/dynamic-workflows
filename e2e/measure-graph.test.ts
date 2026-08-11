/**
 * KAR-16.6 AC3/AC4 — the 400-node measurement, re-taken and enforced.
 *
 * Verifies: EPIC-16-S36 · AC3, AC4
 *
 * A3-2 is rated **High** because the frontend's performance ceiling is an
 * extrapolation from a different library and it gates F10.4. The answer is a
 * measurement (`pnpm measure:graph`, `docs/measurements/vue-flow-400.md`) — and
 * a measurement nobody re-takes is a comment. So this spec re-runs the whole
 * thing: a real `vite build` of the harness, a real static server, a real
 * `DeFlow replay stress-400 --speed max` daemon, a real headless Chromium, a
 * scripted pan and a scripted zoom, with culling off and on.
 *
 * **What it asserts, and why it is not flaky.** The committed budget is the p95
 * frame time the recorded run measured. A re-run fails only if it exceeds the
 * *widest* of three numbers:
 *
 * - the recorded p95 × the recorded tolerance (×2 — a doubling is not jitter);
 * - a 32 ms floor, so a fast recording machine cannot set an unreachable bar;
 * - three times **this run's own idle frame p95**, measured on the same page,
 *   on the same machine, seconds earlier.
 *
 * The third is the one that matters on a laptop running the rest of the suite:
 * it compares the graph against the machine rather than against a constant, in
 * the same way EPIC-05 measured its two timing budgets. A regression in the
 * renderer moves the first number and not the third; a loaded box moves both.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it, describe as suite } from 'vitest';
import {
  budgetOf,
  FIXTURE,
  type GraphBudget,
  type GraphMeasurement,
  MEASUREMENT_JSON,
  MEASUREMENT_MD,
  measureGraph,
  REPRODUCE,
} from '../packages/web/scripts/measure-graph.ts';

const repoRoot = new URL('../', import.meta.url);

let committed: { budget: GraphBudget; measurement: GraphMeasurement };
let measured: GraphMeasurement;

beforeAll(async () => {
  committed = JSON.parse(
    await readFile(fileURLToPath(new URL(MEASUREMENT_JSON, repoRoot)), 'utf8'),
  ) as { budget: GraphBudget; measurement: GraphMeasurement };
  measured = await measureGraph();
}, 600_000);

/** The widest of the three ceilings — see the file comment. */
function ceiling(recorded: number, budget: GraphBudget, idleP95: number): number {
  return Math.max(recorded * budget.tolerance, budget.floorMs, idleP95 * 3);
}

suite('EPIC-16-S36 — the measurement run', () => {
  it('measures the committed fixture, at four hundred nodes', () => {
    expect(committed.measurement.fixture).toBe(FIXTURE);
    const full = measured.passes.find((pass) => !pass.culling);
    expect(full?.nodes ?? 0).toBeGreaterThanOrEqual(400);
  });

  it('records all four numbers, with culling on and with it off', () => {
    expect(measured.passes.map((pass) => pass.culling)).toEqual([false, true]);
    for (const pass of measured.passes) {
      expect(pass.layoutMs, 'ELK reported no time at all').toBeGreaterThan(0);
      expect(pass.firstPaintMs).toBeGreaterThan(0);
      // A frame series of one sample is not a median of anything.
      expect(pass.pan.samples).toBeGreaterThan(5);
      expect(pass.zoom.samples).toBeGreaterThan(5);
    }
  });

  it('names the machine, the browser and the command in the committed file', async () => {
    const file = await readFile(fileURLToPath(new URL(MEASUREMENT_MD, repoRoot)), 'utf8');

    expect(file).toContain(committed.measurement.machine.cpu);
    expect(file).toContain(committed.measurement.chromium);
    expect(file).toContain(committed.measurement.takenAt);
    expect(file).toContain(REPRODUCE);
    // The decision the number drives, recorded rather than remembered.
    expect(file).toContain('What the number decides');
  });
});

suite('EPIC-16-S36 — the number is enforced, not filed', () => {
  it('keeps the p95 frame time during a scripted pan inside the budget', () => {
    const limit = ceiling(committed.budget.p95PanMs, committed.budget, measured.idle.p95Ms);

    for (const pass of measured.passes) {
      expect(
        pass.pan.p95Ms,
        `pan p95 with culling ${pass.culling ? 'on' : 'off'} was ${pass.pan.p95Ms.toFixed(1)} ms ` +
          `against a ceiling of ${limit.toFixed(1)} ms (recorded ${committed.budget.p95PanMs} ms, ` +
          `idle p95 this run ${measured.idle.p95Ms.toFixed(1)} ms). Re-run \`${REPRODUCE}\` if ` +
          'this is a deliberate change.',
      ).toBeLessThanOrEqual(limit);
    }
  });

  it('keeps the p95 frame time during a scripted zoom inside the budget', () => {
    const limit = ceiling(committed.budget.p95ZoomMs, committed.budget, measured.idle.p95Ms);

    for (const pass of measured.passes) {
      expect(
        pass.zoom.p95Ms,
        `zoom p95 with culling ${pass.culling ? 'on' : 'off'} was ${pass.zoom.p95Ms.toFixed(1)} ms ` +
          `against a ceiling of ${limit.toFixed(1)} ms`,
      ).toBeLessThanOrEqual(limit);
    }
  });

  it('has a budget that is this measurement’s own shape, not a hand-typed number', () => {
    // The budget file is generated by the same function the script uses, so a
    // hand-edited ceiling — the tempting fix for a red build — does not match.
    const shape = budgetOf(committed.measurement);

    expect(committed.budget.tolerance).toBe(shape.tolerance);
    expect(committed.budget.floorMs).toBe(shape.floorMs);
    expect(committed.budget.p95PanMs).toBe(shape.p95PanMs);
    expect(committed.budget.p95ZoomMs).toBe(shape.p95ZoomMs);
  });
});
