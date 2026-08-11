/**
 * EPIC-17-S35 — **the five-minute diagnosis, end to end.** The epic's
 * Definition of Done, and PRD §12's *median time-to-diagnose a failed run under
 * five minutes*.
 *
 * Verifies: EPIC-17-S35 (all three scenarios) · KAR-17.1, KAR-17.2, KAR-17.3,
 * KAR-17.4, KAR-17.6, KAR-17.7, KAR-17.8
 *
 * This file exists because seven stories each verified their own view and
 * nothing verified the **journey between them**. The scenario is not an
 * illustration: PRD §13's mitigation for *"the visualisation is pretty but not
 * diagnostic"* is *measure it — if it doesn't drop, the views are wrong*, and
 * this is where that measurement is taken and enforced.
 *
 * The walk itself is `./support/diagnosis-walk.ts`, shared with
 * `pnpm measure:diagnosis` so the number this spec asserts and the number the
 * committed document reports come from one function rather than from two that
 * agree today.
 *
 * ## What is asserted, in three layers
 *
 * 1. **The chain holds.** Every clause of the main scenario, over the fixture
 *    it was written for: the plan graph's four state counts, criterion `ac-3`
 *    unsatisfied with `import-boundary` as its gate and its summary verbatim,
 *    the blocker inline at `packages/ui/src/Button.vue:42`, the packet's
 *    per-segment counts and the provenance row naming `n-recon`, the
 *    `context.compacted` at `exact` fidelity that dropped the fact segment
 *    while keeping every pin, the split reason, the RFC 6902 re-route, and
 *    three attempt bars on the timeline.
 * 2. **The measurement is repeated, not anecdotal.** Three fixtures with three
 *    different root causes, and a spec that proves the two excluded corpus
 *    entries are genuinely undiagnosable rather than inconvenient.
 * 3. **The number is a gate.** The median is asserted against PRD §12's five
 *    minutes, and against a regression ceiling derived from the committed
 *    record and this run's own control walk.
 *
 * ## Two departures from the scenario's prose, both forced by the domain
 *
 * The flow file has been amended for both, with the reason recorded there:
 *
 * - **Node and criterion ids are kebab-case.** `NodeIdSchema` and
 *   `CriterionIdSchema` are `/^[a-z0-9][a-z0-9-]{0,62}$/`, so the scenario's
 *   `n_impl_3` and `AC-3` are ids this system cannot mint. They are `n-impl-3`
 *   and `ac-3`.
 * - **`confidence` is an enum, not a number.** `FactSchema.provenance.confidence`
 *   is `asserted | verified | speculative`; the scenario's *"confidence 0.6"*
 *   is recorded as `speculative`, the band it falls in.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, expect, it, describe as suite } from 'vitest';
import { repoRoot } from './support/daemon.ts';
import {
  budgetOf,
  CASES,
  CHECKPOINTS,
  type CheckpointResult,
  type DiagnosisBudget,
  type DiagnosisMeasurement,
  MEASUREMENT_JSON,
  MEASUREMENT_MD,
  measureDiagnosis,
  REPRODUCE,
  TARGET_MS,
  type Walk,
} from './support/diagnosis-walk.ts';

let committed: { budget: DiagnosisBudget; measurement: DiagnosisMeasurement };
let measured: DiagnosisMeasurement;
let scenario: Walk;

const stop = (walk: Walk, name: string): CheckpointResult => {
  const found = walk.checkpoints.find((point) => point.name === name);
  if (found === undefined) throw new Error(`${walk.fixture} never reached ${name}`);
  return found;
};

beforeAll(async () => {
  committed = JSON.parse(await readFile(join(repoRoot, MEASUREMENT_JSON), 'utf8')) as {
    budget: DiagnosisBudget;
    measurement: DiagnosisMeasurement;
  };
  measured = await measureDiagnosis();
  const found = measured.walks.find((walk) => walk.fixture === 'five-minute-diagnosis');
  if (found === undefined) throw new Error('the scenario’s own fixture was not walked');
  scenario = found;
}, 900_000);

suite('EPIC-17-S35 — 0:00, orientation: the plan graph', () => {
  it('draws 22 nodes — 18 passed, 1 failed, 2 abandoned, 1 awaiting-human', () => {
    const point = stop(scenario, 'plan-graph');

    expect(point.readout.nodes).toBe(22);
    expect(point.readout.states).toEqual({
      passed: 18,
      failed: 1,
      abandoned: 2,
      'awaiting-human': 1,
    });
  });

  it('makes the failed node identifiable by its own state, not by elimination', () => {
    // Colour, glyph and label are one `data-state` in the DOM and three
    // signals on screen (`StateChip.vue`, `state-palette.ts`): the assertion
    // that matters here is that exactly one node carries `failed` and it is
    // the one the diagnosis is about.
    expect(stop(scenario, 'plan-graph').readout.failedState).toBe('failed');
  });
});

suite('EPIC-17-S35 — 0:20, what failed and against what: the criteria board', () => {
  it('shows ac-3 unsatisfied, with import-boundary as the gate that spoke', () => {
    const board = stop(scenario, 'criteria-board').readout as {
      status: string;
      statement: string;
      evidence: { gate: string; outcome: string; summary: string }[];
    };

    expect(board.status).toBe('unsatisfied');
    expect(board.statement).toBe('no component may import from @voyado/ui/internal');
    expect(board.evidence).toHaveLength(1);
    expect(board.evidence[0]?.gate).toBe('import-boundary');
    expect(board.evidence[0]?.outcome).toBe('fail');
  });

  it('reads the verdict summary verbatim', () => {
    const board = stop(scenario, 'criteria-board').readout as {
      evidence: { summary: string }[];
    };

    expect(board.evidence[0]?.summary).toBe('3 files import from the internal namespace');
  });

  it('offers the first finding as a link that carries the file AND the line', () => {
    const board = stop(scenario, 'criteria-board').readout as {
      evidence: { findings: { id: string; diffHref: string }[] }[];
    };
    const first = board.evidence[0]?.findings[0];

    expect(first?.id).toBe('f-import-boundary-1');
    // The row's red in EPIC-17-S24 and the reason stop 3 is a click rather
    // than a typed URL: a link with a file and no line lands the operator at
    // the top of a diff and leaves them to hunt.
    expect(first?.diffHref).toContain('node=n-impl-3');
    expect(first?.diffHref).toContain('file=packages/ui/src/Button.vue');
    expect(first?.diffHref).toContain('line=42');
  });
});

suite('EPIC-17-S35 — 0:50, where exactly: the diff line', () => {
  it('opens on Button.vue with the blocker inline at line 42', () => {
    const diff = stop(scenario, 'diff-line').readout as {
      present: boolean;
      file: string;
      severity: string;
      message: string;
      extendsTheLine: boolean;
      onScreen: boolean;
    };

    expect(diff.present).toBe(true);
    expect(diff.file).toBe('packages/ui/src/Button.vue');
    expect(diff.severity).toBe('blocker');
    expect(diff.message).toContain('@voyado/ui/internal');
    // In the per-line extend slot under line 42, not appended after the hunk.
    expect(diff.extendsTheLine).toBe(true);
    // And on screen without the operator scrolling for it.
    expect(diff.onScreen).toBe(true);
  });
});

suite('EPIC-17-S35 — 1:30, was the agent wrong or was it told the wrong thing', () => {
  it('lists the packet’s segments with per-segment token counts that sum to the header', () => {
    const inspector = stop(scenario, 'node-inspector').readout as {
      status: string;
      total: number;
      segmentTokens: number[];
      attempts: string[];
    };

    expect(inspector.status).toBe('built');
    expect(inspector.segmentTokens.length).toBeGreaterThan(0);
    expect(inspector.segmentTokens.reduce((sum, count) => sum + count, 0)).toBe(inspector.total);
    // Three attempts to choose between — the failure was not a one-off.
    expect(inspector.attempts).toEqual(['0', '1', '2']);
  });

  it('shows it read decision/import-policy, written by n-recon', () => {
    const inspector = stop(scenario, 'node-inspector').readout as {
      provenance: { key: string; writer: string; confidence: string }[];
    };
    const policy = inspector.provenance.find((row) => row.key.includes('decision/import-policy'));

    expect(policy, 'the provenance table names no import-policy fact').toBeDefined();
    expect(policy?.writer).toContain('n-recon');
    // The scenario says "0.6"; the domain's confidence is a three-value enum,
    // so the fixture records the band and the flow file says so.
    expect(policy?.confidence).toBe('speculative');
  });
});

suite('EPIC-17-S35 — 2:20, what did compaction do to it', () => {
  it('sits a compaction mark between the attempts, at exact fidelity', () => {
    const budget = stop(scenario, 'context-budget').readout as {
      bars: string[];
      marks: { fidelity: string; dropped: string[]; pinnedKept: number }[];
    };

    // One bar per invocation: three attempts, three bars.
    expect(budget.bars.length).toBeGreaterThanOrEqual(3);
    expect(budget.marks).toHaveLength(1);
    expect(budget.marks[0]?.fidelity).toBe('exact');
  });

  it('names the dropped segment and shows the pinned spec survived', () => {
    const budget = stop(scenario, 'context-budget').readout as {
      marks: { dropped: string[]; pinnedKept: number }[];
    };
    const mark = budget.marks[0];

    // The honest conclusion the scenario asks the view to make available: the
    // constraint that went missing was a FACT, and every pin is still there —
    // a plan defect in the node's `reads`, not a pinning failure.
    expect(mark?.dropped.join(' ')).toContain('fact-import-policy');
    expect(mark?.pinnedKept ?? 0).toBeGreaterThan(0);
  });
});

suite('EPIC-17-S35 — 3:10, why was this node here at all', () => {
  it('reads the split reason on the version that introduced the node', () => {
    const scrub = stop(scenario, 'plan-scrubber').readout as { version: string; reason: string };

    expect(scrub.version).toBe('2');
    expect(scrub.reason).toContain(
      'Recon found 3 additional packages; splitting the migration node',
    );
  });

  it('shows the next version’s provider re-route as its RFC 6902 patch', () => {
    const scrub = stop(scenario, 'plan-scrubber').readout as {
      patch: { node: string; ops: string };
    };

    expect(scrub.patch.node).toBe('n-impl-3');
    expect(scrub.patch.ops).toContain('"op": "replace"');
    expect(scrub.patch.ops).toContain('/provider');
    expect(scrub.patch.ops).toContain('codex');
  });
});

suite('EPIC-17-S35 — 3:50, what did it cost and where did the time go', () => {
  it('draws the failed node’s three attempts as three bars, with a cost line', () => {
    const timeline = stop(scenario, 'timeline').readout as {
      bars: number;
      nodeBars: number;
      costLines: number;
    };

    expect(timeline.nodeBars).toBe(3);
    expect(timeline.costLines).toBeGreaterThan(0);
  });
});

suite('EPIC-17-S35 — the whole chain, in one walk', () => {
  it('answers all seven stops on the fixture the scenario was written for', () => {
    expect(
      scenario.checkpoints.filter((point) => !point.answered).map((point) => point.name),
      'a stop with nothing on it breaks the chain: each one hands the next the fact it needs',
    ).toEqual([]);
    expect(scenario.checkpoints.map((point) => point.name)).toEqual([...CHECKPOINTS]);
  });
});

suite('EPIC-17-S35 — the measurement is repeated, not anecdotal', () => {
  it('walks three fixtures with three different root causes', () => {
    expect(measured.walks.map((walk) => walk.fixture)).toEqual(CASES.map((one) => one.fixture));
    expect(new Set(measured.walks.map((walk) => walk.rootCause)).size).toBe(3);
  });

  it('completes every walk, including the two that cannot answer every stop', () => {
    // A fixture with an honest nothing at a stop still has to *reach* it. What
    // would be a failure is a walk that could not get there at all.
    for (const walk of measured.walks) {
      expect(walk.checkpoints, walk.fixture).toHaveLength(CHECKPOINTS.length);
      expect(walk.totalMs, walk.fixture).toBeGreaterThan(0);
    }
  });

  it('excludes the two corpus recordings that cannot be diagnosed, on evidence', async () => {
    // Not a matter of taste. `compaction` holds three `context.*` events and no
    // `run.created`, so it has no plan to orient on and no spec to judge;
    // `crash-resume-seq-gap` records a sequence hole and no failure at all.
    // Asserted here so the measurement document's claim about why they are out
    // is checked rather than believed.
    const kinds = async (fixture: string): Promise<string[]> =>
      (await readFile(join(repoRoot, 'test/fixtures/runs', fixture, 'events.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => (JSON.parse(line) as { kind: string }).kind);

    const [compaction, crash] = await Promise.all([
      kinds('compaction'),
      kinds('crash-resume-seq-gap'),
    ]);

    expect(compaction).not.toContain('run.created');
    expect(compaction).not.toContain('plan.proposed');
    expect(crash).not.toContain('node.failed');
    expect(crash).not.toContain('gate.evaluated');
  });
});

suite('EPIC-17-S35 — the number is a gate on the epic, not a report on it', () => {
  it('keeps the median under PRD §12’s five minutes', () => {
    // The threshold is the published metric. It is not derived from anything
    // measured here and it is not adjustable after the fact — if this fails,
    // PRD §13 says the conclusion is that the views are wrong and the epic is
    // not Done.
    expect(
      measured.medianMs,
      `the median diagnosis walk took ${(measured.medianMs / 1000).toFixed(1)} s across ` +
        `${String(measured.walks.length)} fixtures ` +
        `(${measured.walks.map((walk) => `${walk.fixture} ${(walk.totalMs / 1000).toFixed(1)} s`).join(', ')}). ` +
        'PRD §13: the conclusion is that THE VIEWS ARE WRONG, not that the operator was slow, ' +
        'and the per-checkpoint timings say which one to fix.',
    ).toBeLessThan(TARGET_MS);
  });

  it('keeps the median inside the regression ceiling the committed record sets', () => {
    const budget = committed.budget;
    const ceiling = Math.max(
      budget.medianMs * budget.tolerance,
      budget.floorMs,
      measured.control.totalMs * budget.controlRatio,
    );

    expect(
      measured.medianMs,
      `the median was ${(measured.medianMs / 1000).toFixed(1)} s against a ceiling of ` +
        `${(ceiling / 1000).toFixed(1)} s (recorded ${(budget.medianMs / 1000).toFixed(1)} s, ` +
        `control this run ${(measured.control.totalMs / 1000).toFixed(1)} s). Re-run ` +
        `\`${REPRODUCE}\` if this is a deliberate change.`,
    ).toBeLessThanOrEqual(ceiling);
  });

  it('has a budget that is this measurement’s own shape, not a hand-typed number', () => {
    // The tempting fix for a red build is to widen the ceiling in the JSON.
    // `budgetOf` is the only thing allowed to write it, and everything except
    // the recorded median is a constant declared before any number was taken.
    const shape = budgetOf(committed.measurement);

    expect(committed.budget).toEqual(shape);
    expect(committed.budget.targetMs).toBe(TARGET_MS);
  });

  it('records the date, the machine, the fixtures and the times', async () => {
    const file = await readFile(join(repoRoot, MEASUREMENT_MD), 'utf8');

    expect(file).toContain(committed.measurement.takenAt);
    expect(file).toContain(committed.measurement.machine.cpu);
    expect(file).toContain(committed.measurement.chromium);
    expect(file).toContain(REPRODUCE);
    for (const one of CASES) expect(file).toContain(one.fixture);
    // The honesty section is part of the deliverable, not decoration: the
    // figure is small and it would be easy to read a claim into it that a
    // scripted walk cannot support.
    expect(file).toContain('What this number is **not**');
    expect(file).toContain('It is not a human diagnosis time');
  });
});
