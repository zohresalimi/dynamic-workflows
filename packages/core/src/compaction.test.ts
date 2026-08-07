/**
 * KAR-09.6 — the honest half of F6.6, as a type and a projection.
 *
 * Two properties here are the whole story: a `vendor.session` compaction
 * cannot be spelled `exact` (the `@ts-expect-error` below is the assertion —
 * `pnpm typecheck` fails if that construction ever compiles), and the
 * post-compaction figure recovered from a later turn is carried as
 * `inferred: true` rather than promoted.
 *
 * Verifies: EPIC-09-S30 (payload half), EPIC-09-S31, EPIC-09-S32,
 * EPIC-09-S33 (the model the view is held to), EPIC-09-S35 (the arithmetic) ·
 * AC1, AC2, AC3, AC4, AC5, AC7, AC8 · test plan #2, #8
 */
import { expect, it, describe as suite } from 'vitest';
import {
  AutoCompactDisableRefused,
  type Compaction,
  compactionChart,
  compactionLever,
  compactionTriggerOf,
  compactionView,
  DEFAULT_AUTOCOMPACT_PCT,
  defaultAutoCompactThreshold,
  effectiveWindowOf,
  INFERRED_LABEL,
  overriddenAutoCompactThreshold,
  packetCompaction,
  vendorCompaction,
} from './compaction.ts';
import { type Handle, HandleSchema, type SegmentId, SegmentIdSchema } from './ids.ts';

const handle = (hex: string): Handle =>
  HandleSchema.parse(`artifact://${hex.repeat(64).slice(0, 64)}`);
const segment = (value: string): SegmentId => SegmentIdSchema.parse(value);

const PRE_TOKENS = 167_000;

/** The decoded Claude Code 2.1.220 constants, as the registry carries them. */
const CONSTANTS = { outputReserve: 20_000, autoCompactOffset: 13_000 } as const;

suite('AC3 — the vendor trigger maps into DeFlow vocabulary (EPIC-09-S31)', () => {
  it("maps 'auto' to 'vendor.auto', which says who decided", () => {
    expect(compactionTriggerOf('auto')).toBe('vendor.auto');
  });

  it("maps 'manual' to 'manual' — a human asked, on either side of the wire", () => {
    expect(compactionTriggerOf('manual')).toBe('manual');
  });
});

suite('AC2 — a vendor compaction records what was reported and no more', () => {
  it('carries pre_tokens as before, and nothing where the vendor said nothing', () => {
    const record = vendorCompaction({ trigger: 'auto', preTokens: PRE_TOKENS });

    expect(record).toMatchObject({
      scope: 'vendor.session',
      fidelity: 'partial',
      trigger: 'vendor.auto',
      before: PRE_TOKENS,
      after: null,
      droppedSegments: [],
      demotedToHandles: [],
      originalHandle: null,
    });
  });

  it('AC6 — takes the transcript snapshot handle when one was taken', () => {
    const snapshot = handle('a');
    const record = vendorCompaction({
      trigger: 'manual',
      preTokens: PRE_TOKENS,
      originalHandle: snapshot,
    });

    expect(record.originalHandle).toBe(snapshot);
    expect(record.trigger).toBe('manual');
  });

  it('AC4 — a vendor-scoped event cannot be spelled exact, at the type level', () => {
    // @ts-expect-error — 'exact' belongs to the DeFlow.packet arm only, and the
    // union is what makes "never promoted" a compile error rather than a rule
    // somebody has to remember (EPIC-09-S32, second scenario). The directive
    // sits on the declaration because that is where the assignment is checked.
    const promoted: Compaction = {
      scope: 'vendor.session',
      fidelity: 'exact',
      trigger: 'vendor.auto',
      before: PRE_TOKENS,
      after: null,
      droppedSegments: [],
      demotedToHandles: [],
      pinnedKept: [],
      originalHandle: null,
    };

    expect(promoted.scope).toBe('vendor.session');
  });
});

suite('AC1 — DeFlow’s own compaction knows both ends (EPIC-09-S30)', () => {
  const record = packetCompaction({
    trigger: 'threshold',
    before: 148_000,
    after: 60_000,
    droppedSegments: [segment('history-summary')],
    demotedToHandles: [handle('b')],
    pinnedKept: [`sha256-${'c'.repeat(64)}`],
    originalHandle: handle('d'),
  });

  it('is exact, measured at both ends, and lists the segments by id', () => {
    expect(record.fidelity).toBe('exact');
    expect(record.before).toBe(148_000);
    expect(record.after).toBe(60_000);
    expect(record.droppedSegments).toEqual([segment('history-summary')]);
  });

  it('points at the pre-compaction manifest', () => {
    expect(record.originalHandle).toBe(handle('d'));
  });
});

suite('AC4 — the recovered "after" is inferred, never promoted (EPIC-09-S32)', () => {
  const record = vendorCompaction({ trigger: 'auto', preTokens: PRE_TOKENS });

  it('is null and not inferred until a later turn reports its input tokens', () => {
    const view = compactionView(record);

    expect(view.after).toBeNull();
    expect(view.inferred).toBe(false);
    expect(view.fidelity).toBe('partial');
  });

  it("takes the next envelope's inputTokens as an approximation, flagged", () => {
    const view = compactionView(record, { inputTokens: 84_210 });

    expect(view.after).toBe(84_210);
    expect(view.inferred).toBe(true);
    expect(view.fidelity).toBe('partial');
  });

  it('never flags a measured number as inferred, and never overwrites it', () => {
    const exact = packetCompaction({
      trigger: 'threshold',
      before: 148_000,
      after: 60_000,
      droppedSegments: [],
      demotedToHandles: [],
      pinnedKept: [],
      originalHandle: null,
    });

    const view = compactionView(exact, { inputTokens: 84_210 });

    expect(view.after).toBe(60_000);
    expect(view.inferred).toBe(false);
  });
});

suite('AC5 — the rendering contract, as data (EPIC-09-S33)', () => {
  it('draws an exact compaction as two solid bars with no apology', () => {
    const chart = compactionChart(
      compactionView(
        packetCompaction({
          trigger: 'threshold',
          before: 148_000,
          after: 60_000,
          droppedSegments: [segment('history-summary')],
          demotedToHandles: [handle('b')],
          pinnedKept: [],
          originalHandle: null,
        }),
      ),
    );

    expect(chart.bars.map((bar) => bar.style)).toEqual(['solid', 'solid']);
    expect(chart.bars.every((bar) => bar.label === null)).toBe(true);
    expect(chart.note).toBeNull();
  });

  it('pairs each dropped segment with the handle that resolves it', () => {
    const chart = compactionChart(
      compactionView(
        packetCompaction({
          trigger: 'threshold',
          before: 148_000,
          after: 60_000,
          droppedSegments: [segment('history-summary'), segment('build-log')],
          demotedToHandles: [handle('b'), handle('c')],
          pinnedKept: [],
          originalHandle: null,
        }),
      ),
    );

    expect(chart.dropped).toEqual([
      { segment: segment('history-summary'), handle: handle('b') },
      { segment: segment('build-log'), handle: handle('c') },
    ]);
  });

  it('has nothing to list for a vendor compaction, and says so with an empty list', () => {
    const chart = compactionChart(
      compactionView(vendorCompaction({ trigger: 'auto', preTokens: PRE_TOKENS })),
    );

    expect(chart.dropped).toEqual([]);
  });

  it('draws an inferred after hatched, labelled and explained', () => {
    const chart = compactionChart(
      compactionView(vendorCompaction({ trigger: 'auto', preTokens: PRE_TOKENS }), {
        inputTokens: 84_210,
      }),
    );

    expect(chart.bars[0]).toMatchObject({ slot: 'before', style: 'solid', value: PRE_TOKENS });
    expect(chart.bars[1]).toMatchObject({ slot: 'after', style: 'hatched', value: 84_210 });
    expect(chart.bars[1].label).toBe(INFERRED_LABEL);
    expect(chart.note).toContain('does not report');
    expect(chart.tooltip).toContain('upper bound');
  });

  it('draws an unreported after as a gap, never as a zero', () => {
    const chart = compactionChart(
      compactionView(vendorCompaction({ trigger: 'auto', preTokens: PRE_TOKENS })),
    );

    expect(chart.bars[1]).toMatchObject({ slot: 'after', style: 'gap', value: null });
    expect(JSON.stringify(chart)).not.toContain('"0"');
    expect(chart.note).toContain('does not report');
  });
});

suite('AC7 — the threshold is derived, and the override only moves it earlier', () => {
  const turn = { contextWindow: 200_000, maxOutputTokens: 32_000 } as const;

  it('reserves the output ceiling, capped by the vendor’s own reserve', () => {
    expect(effectiveWindowOf(turn, CONSTANTS)).toBe(180_000);
    expect(effectiveWindowOf({ contextWindow: 200_000, maxOutputTokens: 8_000 }, CONSTANTS)).toBe(
      192_000,
    );
  });

  it('derives the default threshold from the reported window (EPIC-09-S35)', () => {
    expect(defaultAutoCompactThreshold(turn, CONSTANTS)).toBe(167_000);
  });

  it.each([
    [70, 126_000],
    [90, 162_000],
    [95, 167_000],
    [100, 167_000],
  ])('clamps autocompactPct %i to %i', (pct, threshold) => {
    expect(overriddenAutoCompactThreshold(pct, turn, CONSTANTS)).toBe(threshold);
  });

  it('never returns a threshold later than the default, for any percentage', () => {
    const fallback = defaultAutoCompactThreshold(turn, CONSTANTS);
    for (let pct = 1; pct <= 100; pct += 1) {
      expect(overriddenAutoCompactThreshold(pct, turn, CONSTANTS)).toBeLessThanOrEqual(fallback);
    }
  });
});

suite('AC7, AC8 — the lever a node runs with', () => {
  it('defaults a write-capable node to 70%, which compacts earlier', () => {
    expect(compactionLever({ permission: 'worktree' })).toEqual({
      autocompactPct: DEFAULT_AUTOCOMPACT_PCT,
      autoCompactDisabled: false,
    });
  });

  it('takes the configured percentage over the default', () => {
    expect(compactionLever({ permission: 'full', autocompactPct: 55 }).autocompactPct).toBe(55);
  });

  it('leaves a read node at the vendor’s own threshold unless configured', () => {
    expect(compactionLever({ permission: 'read' })).toEqual({
      autocompactPct: null,
      autoCompactDisabled: false,
    });
  });

  it('lets a read node opt out of auto-compaction entirely', () => {
    expect(compactionLever({ permission: 'read', disableAutoCompact: true })).toEqual({
      autocompactPct: null,
      autoCompactDisabled: true,
    });
  });

  it('refuses the opt-out above read, where exhaustion loses written work', () => {
    expect(() => compactionLever({ permission: 'worktree', disableAutoCompact: true })).toThrow(
      AutoCompactDisableRefused,
    );
  });
});
