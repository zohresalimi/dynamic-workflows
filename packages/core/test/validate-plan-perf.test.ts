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
 * node — quadruples it.
 *
 * Measured 2026-08-08, on the shipped implementation: 0.40 ms for 200 children
 * and 0.79 ms for 400 — a ratio of 1.97, and two orders of magnitude under
 * AC12's 100 ms. The ratio is also what caught the one real super-linearity in
 * this path: `topoSort` re-sorted its whole ready set on every push, which a
 * 400-wide fan-out makes O(n² log n) and which read as 0.64 / 1.63 ms, a ratio
 * of 2.55. Binary insertion took it back to linear; a flat wall-clock assertion
 * would have passed throughout.
 *
 * **The ceiling is 2.5, not the 3.0 it was written with.** 3.0 sat above the
 * 2.55 that regression read, so the assertion did not in fact separate the two
 * cases its own paragraph credits it with separating — anything up to a 3x
 * blowup passed. It could not safely be tightened while the statistic was a
 * median, because the median's spread under load reached 2.31 on honest code
 * (see `timeBoth`). On the fastest-sample statistic the honest reading is
 * 1.95-2.05 from idle through 6x oversubscription, so 2.5 clears it by 22% and
 * still lands under the 2.67 an injected super-linearity of that same magnitude
 * reads. Regressions milder than 2.5x slip through; that is the honest limit of
 * a two-point ratio, and the batch backstop below is what covers the rest.
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

const ITERATIONS = 50;

function fastest(values: number[]): number {
  return Math.min(...values);
}

/**
 * Both graphs timed alternately, and reported as the **fastest** sample of each.
 *
 * **Alternating**, because timing one batch and then the other lets V8 go on
 * optimising between them and the drift lands entirely on whichever went
 * second.
 *
 * **Fastest, not median.** This started as a median, on the reasoning that a
 * median is immune to the one stall a sum is dominated by. That is true of an
 * *occasional* stall and false of the case this suite actually runs in: nested
 * inside `test/integration/project-slices.test.ts`, the unit slice is re-run as
 * a subprocess while the full suite saturates the box, so descheduling is not
 * an outlier but the common case, and the median sits in the contaminated bulk
 * rather than on the clean floor. Worse, the contamination is *biased*: the
 * subject's window is twice the control's, so it is twice as likely to contain
 * a preemption, and the ratio drifts upward. Measured on this machine, 30
 * alternating samples, against 24 and 48 spinning CPU burners on 8 cores:
 *
 * | statistic | idle      | 3x load   | 6x load   | with a real super-linearity |
 * | --------- | --------- | --------- | --------- | --------------------------- |
 * | median    | 1.96-2.01 | 1.80-2.31 | 1.72-2.16 | 2.58-2.62                   |
 * | fastest   | 1.97-1.99 | 1.95-2.05 | 1.96-2.00 | 2.67-2.68                   |
 *
 * The median's spread under load overlaps the band a genuine regression reads
 * in; the minimum's does not. That overlap is not theoretical — it is what went
 * red here, at a control of 0.54 ms against a subject of 2.16 ms, a ratio of
 * 4.0 on an implementation that had not changed.
 *
 * A minimum is the right estimator because the quantity wanted is CPU cost, and
 * scheduling noise is strictly additive: it can only ever make a sample slower,
 * never faster. The fastest of 50 is therefore the sample that came closest to
 * running uninterrupted, and it recovers the same number under 6x
 * oversubscription that it reads on an idle box. Note this *tightens* the
 * instrument rather than relaxing it — the budget below came down with it.
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
  return { controlMs: fastest(controls), subjectMs: fastest(subjects) };
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
    ).toBeLessThan(controlMs * 2.5);

    // The backstop for a blowup no ratio would notice, because it would slow
    // both halves equally. AC12's budget is 100 ms for one validation, and
    // `subjectMs` is one validation — the fastest of the 50 timed — so 100 ms
    // is AC12's own number applied unchanged, with two orders of magnitude of
    // headroom above an honest reading of well under a millisecond. Being a
    // floor rather than an average, it cannot go red on a slow box; only work
    // that is genuinely there in every sample can reach it, which is the point.
    expect(subjectMs).toBeLessThan(100);
  });
});
