/**
 * KAR-11.2 AC12 / epic test-plan row 13 — a 400-node `map` fan-out validates
 * inside the budget, capability pass included, measured against a control
 * rather than against a wall clock.
 *
 * This lives outside `packages/core/src` for the same reason
 * ./validate-declared-reads-perf.test.ts does: measuring elapsed time needs
 * `performance.now`, and `.oxlintrc.json` refuses that identifier in every file
 * under `packages/core/src`, tests included — *"a clock read wearing a different
 * name"*. `validatePlan` itself stays clock-free; only the test needs a clock,
 * so only the test moves.
 *
 * **AC12 is written as "under 100 ms", and a flat 100 ms would measure the
 * machine.** This suite runs alongside a full vitest run on a box that may be
 * oversubscribed, and the work here is pure CPU — the same failure mode
 * EPIC-05's two timing budgets had and the same correction they took. So the
 * assertion is a *ratio* against a control that shares every cost except the
 * one under test, plus a batch backstop wide enough that only a change in the
 * algorithm's shape can reach it.
 *
 * The control is the same validation over a 200-node fan-out. Everything
 * `validatePlan` does is linear or near-linear in the node count — one
 * `topoSort`, one ancestor pass, one capability pass per agent node — so
 * doubling the fan-out should roughly double the time. An accidental O(n²) —
 * recomputing the read set per node, say, or asking the criteria walk once per
 * node — quadruples it. A ceiling of 3.0 sits above the honest ratio with room
 * for jitter and below the regressed one.
 *
 * Measured 2026-08-08, on the shipped implementation: 0.40 ms for 200 children
 * and 0.79 ms for 400 — a ratio of 1.97, and two orders of magnitude under
 * AC12's 100 ms. The ratio is also what caught the one real super-linearity in
 * this path: `topoSort` re-sorted its whole ready set on every push, which a
 * 400-wide fan-out makes O(n² log n) and which read as 0.64 / 1.63 ms, a ratio
 * of 2.55. Binary insertion took it back to linear; a flat wall-clock assertion
 * would have passed throughout.
 *
 * Verifies: EPIC-11-S6 (fan-out scale), AC12
 */
import { expect, it, describe as suite } from 'vitest';
import { PlanGraphSchema } from '../src/plan-graph.ts';
import { TaskSpecSchema } from '../src/task-spec.ts';
import { type PlanTimeCapability, validatePlan } from '../src/validate-plan.ts';

const CAPS: readonly PlanTimeCapability[] = [
  {
    provider: 'claude',
    version: '2.1.220',
    structuredOutput: true,
    resume: true,
    permissionLevels: ['read', 'worktree', 'worktree+net', 'full'],
    maxContext: 200_000,
  },
];

const SPEC = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'review every file',
  scope: { included: ['the repository'] },
  nonGoals: ['nothing else'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [{ id: 'ac-1', statement: 'every file is reviewed' }],
  knownFailureModes: [],
  approvedBy: null,
  specHash: `sha256-${'2'.repeat(64)}`,
});

function agent(id: string, deps: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    type: 'agent',
    deps,
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: ['packages/**'] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 500 },
    brief: `Do ${id}.`,
    provider: { prefer: ['claude'], requires: [] },
    resume: 'always-replay',
    ...over,
  };
}

/**
 * A 20-deep spine, then `width` children hanging off its tail, each reading the
 * keys the spine writes — so every child has a real, 20-node ancestor set to
 * resolve rather than an empty one. A gate covers the spec's criterion, so
 * the coverage pass runs on a plan it can satisfy rather than short-circuiting
 * into an error list.
 */
function fanOut(width: number): ReturnType<typeof PlanGraphSchema.parse> {
  const nodes: Record<string, unknown>[] = [];
  for (let index = 0; index < 20; index += 1) {
    nodes.push(
      agent(`spine-${index}`, index === 0 ? [] : [`spine-${index - 1}`], {
        writes: [{ kind: 'fact', key: `finding/spine-${index}`, schemaId: 'DeFlow.finding.v1' }],
      }),
    );
  }
  for (let index = 0; index < width; index += 1) {
    nodes.push(
      agent(`child-${index}`, ['spine-19'], {
        // The `<namespace>/*` glob EPIC-09's rule recognises, so every spine
        // write has a reader and neither graph carries an orphan-write warning:
        // this suite measures the checks, not the cost of assembling a
        // 20-entry diagnostics array twice.
        reads: [{ kind: 'fact', key: 'finding/*' }],
      }),
    );
  }
  nodes.push({
    id: 'gate-acceptance',
    title: 'gate-acceptance',
    type: 'gate',
    deps: ['spine-19'],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.verdict.v2', maxTokens: 500 },
    gate: { kind: 'deterministic', gateId: 'typecheck' },
    criteria: ['ac-1'],
    independence: { notSessionOf: [], preferDifferentProvider: true },
  });

  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: 'run_20260808T101500Z_ac1102',
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: SPEC.specHash,
    createdBy: 'planner',
    createdAt: '2026-08-08T10:15:00.000Z',
    nodes,
    edges: [],
  });
}

const run = (plan: ReturnType<typeof PlanGraphSchema.parse>) =>
  validatePlan(plan, SPEC, CAPS, { estimatePacketTokens: () => 0 });

const ITERATIONS = 30;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number);
}

/**
 * Both graphs timed alternately, and reported as medians.
 *
 * **Alternating**, because timing one batch and then the other lets V8 go on
 * optimising between them and the drift lands entirely on whichever went
 * second. **Medians, not totals**, because one validation costs a couple of
 * milliseconds and a scheduler quantum is ten: on an oversubscribed box a
 * single deschedule dumps more time into one bucket than the effect being
 * measured, and a median is immune to the stall a sum is dominated by.
 */
function timeBoth(
  control: ReturnType<typeof PlanGraphSchema.parse>,
  subject: ReturnType<typeof PlanGraphSchema.parse>,
): { controlMs: number; subjectMs: number } {
  const controls: number[] = [];
  const subjects: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const a = performance.now();
    run(control);
    const b = performance.now();
    run(subject);
    const c = performance.now();
    controls.push(b - a);
    subjects.push(c - b);
  }
  return { controlMs: median(controls), subjectMs: median(subjects) };
}

suite('AC12 — a 400-node fan-out validates inside the budget', () => {
  it('scales with the node count rather than with its square', () => {
    const control = fanOut(200);
    const subject = fanOut(400);

    // Warm-up: the first call through carries V8's compilation of the whole
    // module, which would otherwise land on whichever graph went first.
    run(control);
    run(subject);

    // Both graphs are clean, so nothing here is measuring the cost of building
    // a diagnostics array instead of the cost of the checks.
    expect(run(control)).toEqual([]);
    expect(run(subject)).toEqual([]);

    const { controlMs, subjectMs } = timeBoth(control, subject);

    expect(
      subjectMs,
      `200 children took ${controlMs.toFixed(2)} ms, 400 took ${subjectMs.toFixed(2)} ms`,
    ).toBeLessThan(controlMs * 3);

    // The backstop for a blowup no ratio would notice, because it would slow
    // both halves equally. AC12's budget is 100 ms for one validation; this
    // times 30 of them, so 30 x 100 ms is the same budget expressed over the
    // batch, and the assertion is on the median of one — 100 ms with two
    // doublings of headroom above an honest reading of a couple of ms.
    expect(subjectMs).toBeLessThan(100);
  });
});
