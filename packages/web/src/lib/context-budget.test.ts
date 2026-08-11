/**
 * KAR-17.4 — the context-budget derivation, without a chart.
 *
 * Verifies: EPIC-17-S17 (scenarios 1, 2 and 4), EPIC-17-S18 (scenarios 1 and 2),
 * EPIC-17-S19 (scenario 3) · AC1, AC2, AC4, AC5, AC8, AC10
 *
 * Test plan rows 1, 2 and 3. These are the three the epic asks to be provable
 * *without* a browser, because each of them is a rule about arithmetic that a
 * screenshot cannot check: the stack order, the null that must survive, and a
 * budget line that is a property of the budget rather than of the data.
 *
 * The recordings are folded through the real `applyContext`, so what is asserted
 * here is the same view model the component receives — not a hand-built one that
 * agrees with the derivation by construction. The two hand-built packets are the
 * exceptions and they earn it: no fixture mixes token-counting methods in one
 * packet, and AC8's *"estimated and vendor-reported are never one number"* has
 * nothing to say until one does.
 */
import { expect, it, describe as suite } from 'vitest';
import { compactionRun, happyPath12 } from '../../test/fixture-events.ts';
import {
  applyContext,
  type ContextProjection,
  emptyContext,
  type PacketVM,
  packetKey,
  type SegmentVM,
} from '../ledger/projections/context.ts';
import {
  type BudgetChartVM,
  budgetChart,
  DEFAULT_BUDGET_FRACTION,
  MAX_BUDGET_FRACTION,
  VENDOR_POST_COUNT_UNAVAILABLE,
} from './context-budget.ts';

/** The named recording, folded through the projection the chart reads. */
function contextOf(events: readonly ReturnType<typeof happyPath12>[number][]): ContextProjection {
  const state = emptyContext();
  for (const event of events) applyContext(state, event);
  return state;
}

const chartOf = (events: readonly ReturnType<typeof happyPath12>[number][]): BudgetChartVM =>
  budgetChart(contextOf(events));

/** A packet built by hand, for the two rules no recording exercises. */
function packet(input: {
  readonly nodeId: string;
  readonly attempt?: number;
  readonly builtAtSeq: number;
  readonly limitTokens: number;
  readonly fraction?: number;
  readonly segments: readonly SegmentVM[];
}): PacketVM {
  const byKind: Record<string, number> = {};
  for (const segment of input.segments) {
    byKind[segment.kind] = (byKind[segment.kind] ?? 0) + segment.tokens.estimated;
  }
  return {
    nodeId: input.nodeId,
    attempt: input.attempt ?? 0,
    builtAtSeq: input.builtAtSeq,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: input.limitTokens * 2 },
    budget: { fraction: input.fraction ?? DEFAULT_BUDGET_FRACTION, limitTokens: input.limitTokens },
    totals: {
      tokens: input.segments.reduce((sum, one) => sum + one.tokens.estimated, 0),
      byKind,
    },
    segments: input.segments,
    renderedPromptHandle:
      'artifact://0000000000000000000000000000000000000000000000000000000000000000',
    pinnedDigests: input.segments.filter((one) => one.pinned).map((one) => one.contentHash),
    violated: false,
    violation: null,
  };
}

function segment(input: {
  readonly id: string;
  readonly kind: SegmentVM['kind'];
  readonly tokens: number;
  readonly method: string;
  readonly sourceEvent: number;
  readonly pinned?: boolean;
}): SegmentVM {
  return {
    id: input.id,
    kind: input.kind,
    sourceEvent: input.sourceEvent,
    contentHash: `sha256-${input.id}`,
    tokens: { estimated: input.tokens, method: input.method },
    pinned: input.pinned ?? input.kind.startsWith('pinned.'),
    compactable: !(input.pinned ?? input.kind.startsWith('pinned.')),
  };
}

/** A projection holding only the packets given, for the hand-built cases. */
const projectionOf = (packets: readonly PacketVM[]): ContextProjection => ({
  appliedSeq: 0,
  packets: new Map(packets.map((one) => [packetKey(one.nodeId, one.attempt), one])),
  compactions: [],
  violations: [],
});

suite('KAR-17.4 test 1 — the stack input builder (AC1)', () => {
  it('draws one bar per node invocation, in seq order', () => {
    const chart = chartOf(happyPath12());

    expect(chart.bars.map((bar) => bar.invocation)).toEqual([
      'impl-login#0',
      'impl-signup#0',
      'review-security#0',
    ]);
    expect(chart.bars.map((bar) => bar.builtAtSeq)).toEqual([21, 40, 62]);
  });

  it('stacks the kinds in the order they render in the prompt, pinned first', () => {
    const [bar] = chartOf(happyPath12()).bars;

    // Prompt order is pinned-first-then-`sourceEvent` (`renderOrderOf`), and
    // this recording is what makes that assertion mean something: the packet's
    // own `totals.byKind` — and `SEGMENT_KINDS` — start
    // `pinned.constraints, pinned.spec`, while the prompt starts
    // `pinned.spec, pinned.constraints`, because `pinned-spec-goal` is the
    // first pinned segment in the packet. A stack built from `Object.keys`
    // gets this backwards and nothing else in the chart would show it.
    expect(bar?.bands.map((band) => band.kind)).toEqual([
      'pinned.spec',
      'pinned.constraints',
      'pinned.pathscope',
      'task.brief',
      'fact',
      'artifact.handle',
      'retrieved',
      'history.summary',
      'tool.output',
    ]);
  });

  it('puts every pinned kind at the base, below every unpinned one', () => {
    for (const bar of chartOf(happyPath12()).bars) {
      const pinnedTop = Math.max(...bar.bands.filter((band) => band.pinned).map((band) => band.to));
      const unpinnedBase = Math.min(
        ...bar.bands.filter((band) => !band.pinned).map((band) => band.from),
      );

      expect(pinnedTop).toBeLessThanOrEqual(unpinnedBase);
      expect(bar.bands[0]?.from).toBe(0);
    }
  });

  it('carries each kind band from the packet totals rather than re-deriving one', () => {
    const context = contextOf(happyPath12());
    const chart = budgetChart(context);

    for (const bar of chart.bars) {
      const held = context.packets.get(bar.invocation) as PacketVM;
      for (const band of bar.bands) {
        expect(band.to - band.from, band.kind).toBe(held.totals.byKind[band.kind]);
        expect(
          band.slices.reduce((sum, slice) => sum + slice.tokens, 0),
          band.kind,
        ).toBe(held.totals.byKind[band.kind]);
      }
      // A single-method packet has exactly one figure, and it is the packet's.
      expect(bar.totals).toEqual([{ method: 'heuristic', tokens: held.totals.tokens }]);
      expect(bar.stacked).toBe(held.totals.tokens);
    }
  });

  it('leaves out the kinds the packet recorded a zero for', () => {
    // The compaction fixture's packet carries an explicit 0 for six of the nine
    // kinds. A zero-height rect is a rect a reader can hover and a colour in a
    // legend for something that is not there.
    const [bar] = chartOf(compactionRun()).bars;

    expect(bar?.bands.map((band) => band.kind)).toEqual([
      'pinned.spec',
      'pinned.constraints',
      'pinned.pathscope',
      'artifact.handle',
    ]);
  });

  it('keeps every slice addressable — kind, tokens, method and sourceEvent (AC7)', () => {
    const [bar] = chartOf(happyPath12()).bars;
    const first = bar?.bands[0]?.slices[0];

    expect(first).toEqual({
      segmentId: 'pinned-spec-goal',
      kind: 'pinned.spec',
      pinned: true,
      tokens: 46,
      method: 'heuristic',
      sourceEvent: 4,
      from: 0,
      to: 46,
    });
  });
});

suite('KAR-17.4 test 2 — a partial fidelity keeps its null (AC4, AC10)', () => {
  const marks = () => chartOf(compactionRun()).bars[0]?.compactions ?? [];

  it('annotates the exact compaction with before, after, the delta and the original', () => {
    const exact = marks().find((mark) => mark.fidelity === 'exact');

    expect(exact?.before).toBe(3165);
    expect(exact?.after).toBe(211);
    expect(exact?.saved).toBe(2954);
    expect(exact?.droppedSegments).toEqual(['build-log']);
    expect(exact?.originalHandle).toBe(
      'artifact://820c387f09b46c3598f167ef8c9ded9fbc14167219492bbc88b8561a768d226a',
    );
    expect(exact?.gapLabel).toBeNull();
  });

  it('renders the vendor compaction as a gap and never as a number', () => {
    const partial = marks().find((mark) => mark.fidelity === 'partial');

    expect(partial?.after).toBeNull();
    expect(partial?.saved).toBeNull();
    expect(partial?.gapLabel).toBe(VENDOR_POST_COUNT_UNAVAILABLE);
    // The `after` bar the component draws carries no value at all — this is
    // `?? 0` creeping back in, caught one level below the DOM.
    expect(partial?.chart.bars[1]?.value).toBeNull();
    expect(partial?.chart.bars[1]?.style).toBe('gap');
  });

  it('surfaces pinnedKept as the integrity check’s own evidence (AC5)', () => {
    for (const mark of marks()) {
      expect(mark.pinnedKept).toHaveLength(5);
      expect(mark.pinnedKept[0]).toMatch(/^sha256-/);
    }
  });

  it('handles both fidelities in one bar with no branch of its own (AC10)', () => {
    expect(marks().map((mark) => mark.fidelity)).toEqual(['exact', 'partial']);
    expect(marks().map((mark) => mark.seq)).toEqual([2, 3]);
  });

  it('never loses a compaction whose invocation was never recorded', () => {
    const context = contextOf(compactionRun());
    const chart = budgetChart({ ...context, packets: new Map() });

    expect(chart.bars).toHaveLength(0);
    expect(chart.unattached.map((mark) => mark.seq)).toEqual([2, 3]);
  });
});

suite('KAR-17.4 test 3 — the budget line is the budget, not the tallest bar (AC2)', () => {
  it('keeps the line at limitTokens even when every bar is far below it', () => {
    const chart = chartOf(happyPath12());

    // 290 tokens against a 100,000-token budget. A scale fitted to the data
    // would put the tallest bar at the top and the budget line off the chart
    // entirely, which is the failure this row is written against: headroom
    // disappears and every run looks equally close to its limit.
    expect(chart.domainMax).toBe(100_000);
    expect(chart.budgetLine).toBe(1);
    expect(chart.bars[0]?.stacked).toBe(290);
    expect(chart.bars[0]!.stacked / chart.domainMax).toBeLessThan(0.01);
  });

  it('does not move the line when a taller bar arrives under the limit', () => {
    const under = budgetChart(
      projectionOf([
        packet({
          nodeId: 'a',
          builtAtSeq: 1,
          limitTokens: 100_000,
          segments: [
            segment({
              id: 's',
              kind: 'task.brief',
              tokens: 60_000,
              method: 'heuristic',
              sourceEvent: 1,
            }),
          ],
        }),
      ]),
    );

    expect(under.domainMax).toBe(100_000);
    expect(under.budgetLine).toBe(1);
    expect(under.bars[0]?.overBudget).toBe(false);
  });

  it('grows the domain — and drops the line — for a bar that broke its budget', () => {
    const over = budgetChart(
      projectionOf([
        packet({
          nodeId: 'a',
          builtAtSeq: 1,
          limitTokens: 100_000,
          segments: [
            segment({
              id: 's',
              kind: 'task.brief',
              tokens: 120_000,
              method: 'heuristic',
              sourceEvent: 1,
            }),
          ],
        }),
      ]),
    );

    expect(over.domainMax).toBe(120_000);
    expect(over.budgetLine).toBeCloseTo(100_000 / 120_000, 10);
    expect(over.bars[0]?.overBudget).toBe(true);
  });

  it('states the fraction, and says when one is outside the policy', () => {
    expect(DEFAULT_BUDGET_FRACTION).toBe(0.5);
    expect(MAX_BUDGET_FRACTION).toBe(0.6);

    const chart = budgetChart(
      projectionOf([
        packet({
          nodeId: 'a',
          builtAtSeq: 1,
          limitTokens: 100_000,
          fraction: 0.5,
          segments: [
            segment({
              id: 's',
              kind: 'task.brief',
              tokens: 10,
              method: 'heuristic',
              sourceEvent: 1,
            }),
          ],
        }),
        packet({
          nodeId: 'b',
          builtAtSeq: 2,
          limitTokens: 140_000,
          fraction: 0.7,
          segments: [
            segment({
              id: 't',
              kind: 'task.brief',
              tokens: 10,
              method: 'heuristic',
              sourceEvent: 1,
            }),
          ],
        }),
      ]),
    );

    expect(chart.bars.map((bar) => bar.fractionWithinPolicy)).toEqual([true, false]);
  });
});

suite('AC8 — an estimate and a vendor figure are never one number', () => {
  const mixed = () =>
    budgetChart(
      projectionOf([
        packet({
          nodeId: 'a',
          builtAtSeq: 1,
          limitTokens: 100_000,
          segments: [
            segment({
              id: 'p1',
              kind: 'pinned.spec',
              tokens: 100,
              method: 'gpt-tokenizer/o200k_base',
              sourceEvent: 1,
            }),
            segment({
              id: 'h1',
              kind: 'history.summary',
              tokens: 40,
              method: 'heuristic',
              sourceEvent: 2,
            }),
            segment({
              id: 'h2',
              kind: 'history.summary',
              tokens: 900,
              method: 'vendor-reported',
              sourceEvent: 3,
            }),
          ],
        }),
      ]),
    );

  it('reports the bar total once per method rather than once', () => {
    expect(mixed().bars[0]?.totals).toEqual([
      { method: 'gpt-tokenizer/o200k_base', tokens: 100 },
      { method: 'heuristic', tokens: 40 },
      { method: 'vendor-reported', tokens: 900 },
    ]);
  });

  it('splits a single kind whose segments were counted two different ways', () => {
    const band = mixed().bars[0]?.bands.find((one) => one.kind === 'history.summary');

    expect(band?.totals).toEqual([
      { method: 'heuristic', tokens: 40 },
      { method: 'vendor-reported', tokens: 900 },
    ]);
    expect(band?.slices.map((slice) => slice.method)).toEqual(['heuristic', 'vendor-reported']);
  });
});

suite('AC6 — a pin integrity violation lands on its own invocation', () => {
  it('marks the invocation with the missing digests and the segment ids', () => {
    const chart = budgetChart(
      contextOf(happyPath12()),
      new Map([
        [
          'impl-login#0',
          {
            reason: 'safety.pin-integrity-violated',
            class: 'permanent',
            message: 'a pinned constraint segment did not survive re-injection',
            evidence: [],
          },
        ],
      ]),
    );
    const bar = chart.bars.find((one) => one.invocation === 'impl-login#0');

    expect(bar?.violation?.missingDigests).toEqual([
      'sha256-aacd366f09f3c8b831f0d2f385eed98ddd6698b8591b2f081bd160f09bf15375',
    ]);
    expect(bar?.violation?.segmentIds).toEqual(['pinned-spec-goal']);
    expect(bar?.failure?.reason).toBe('safety.pin-integrity-violated');
  });

  it('leaves every other invocation unmarked, so the absence means something', () => {
    const chart = chartOf(happyPath12());

    expect(chart.bars.filter((bar) => bar.violation !== null).map((bar) => bar.invocation)).toEqual(
      ['impl-login#0'],
    );
  });
});
