/**
 * KAR-02.6 — `ContextPacket` and typed segments (docs/04-domain-model.md §6).
 *
 * Verifies: EPIC-02-S17, EPIC-02-S18 · AC1-AC7
 */
import { expect, it, describe as suite } from 'vitest';
import {
  ContextPacketSchema,
  packetTotalsAreConsistent,
  renderOrderOf,
  SegmentSchema,
  TokenCountSchema,
} from './context-packet.ts';

const digest = (byte: string): string => `sha256-${byte.repeat(64)}`;

const segment = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'seg-brief',
  kind: 'task.brief',
  sourceEvent: 10,
  contentHash: digest('a'),
  text: 'do the thing',
  tokens: { estimated: 40, method: 'gpt-tokenizer/o200k_base' },
  pinned: false,
  compactable: true,
  ...overrides,
});

const target = { provider: 'claude-code', model: 'claude-sonnet-4-6', maxContext: 200000 };
const budget = { fraction: 0.5, limitTokens: 100000 };

const packet = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaId: 'DeFlow.contextpacket.v1',
  runId: 'run_20260802T141133Z_9f2a1c',
  nodeId: 'recon-auth-surface',
  attempt: 1,
  builtAtEvent: 30,
  target,
  budget,
  segments: [segment()],
  totals: {
    tokens: 40,
    byKind: {
      'pinned.constraints': 0,
      'pinned.spec': 0,
      'pinned.pathscope': 0,
      'task.brief': 40,
      fact: 0,
      'artifact.handle': 0,
      retrieved: 0,
      'history.summary': 0,
      'tool.output': 0,
    },
  },
  renderedPromptHandle: `artifact://${'b'.repeat(64)}`,
  pinnedDigests: [],
  ...overrides,
});

suite('TokenCount.method is mandatory (AC5)', () => {
  it('throws on a TokenCount missing method', () => {
    expect(() => TokenCountSchema.parse({ estimated: 4210 })).toThrow();
  });

  it('accepts one of the three closed methods', () => {
    for (const method of ['gpt-tokenizer/o200k_base', 'heuristic', 'vendor-reported']) {
      expect(TokenCountSchema.safeParse({ estimated: 10, method }).success).toBe(true);
    }
  });

  it('rejects a method outside the closed set', () => {
    expect(TokenCountSchema.safeParse({ estimated: 10, method: 'guess' }).success).toBe(false);
  });
});

suite('pinned implies not compactable, one way only (AC2)', () => {
  it('rejects pinned: true with compactable: true', () => {
    const result = SegmentSchema.safeParse(segment({ pinned: true, compactable: true }));
    expect(result.success).toBe(false);
  });

  it('accepts pinned: true with compactable: false', () => {
    const result = SegmentSchema.safeParse(segment({ pinned: true, compactable: false }));
    expect(result.success).toBe(true);
  });

  it('accepts pinned: false with compactable: false — the implication is one-way', () => {
    const result = SegmentSchema.safeParse(segment({ pinned: false, compactable: false }));
    expect(result.success).toBe(true);
  });

  it('accepts pinned: false with compactable: true', () => {
    const result = SegmentSchema.safeParse(segment({ pinned: false, compactable: true }));
    expect(result.success).toBe(true);
  });
});

suite('budget.fraction is capped at 0.6 and defaults to 0.5 (AC3)', () => {
  it.each([
    [0.5, true],
    [0.6, true],
    [0.61, false],
    [0.9, false],
  ])('fraction=%s -> ok=%s', (fraction, ok) => {
    const result = ContextPacketSchema.safeParse(packet({ budget: { ...budget, fraction } }));
    expect(result.success).toBe(ok);
  });

  it('rejects 0.61 naming 0.6 in the message', () => {
    const result = ContextPacketSchema.safeParse(packet({ budget: { ...budget, fraction: 0.61 } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toContain('0.6');
    }
  });

  it('defaults fraction to 0.5 when omitted', () => {
    const result = ContextPacketSchema.parse(packet({ budget: { limitTokens: 100000 } }));
    expect(result.budget.fraction).toBe(0.5);
  });
});

suite('pinnedDigests are derivable from the segments (AC4)', () => {
  it('accepts one digest per pinned segment matching contentHash', () => {
    const pinnedSeg = segment({
      id: 'seg-pinned',
      kind: 'pinned.spec',
      contentHash: digest('c'),
      pinned: true,
      compactable: false,
    });
    const result = ContextPacketSchema.safeParse(
      packet({
        segments: [segment(), pinnedSeg],
        totals: {
          tokens: 80,
          byKind: {
            'pinned.constraints': 0,
            'pinned.spec': 40,
            'pinned.pathscope': 0,
            'task.brief': 40,
            fact: 0,
            'artifact.handle': 0,
            retrieved: 0,
            'history.summary': 0,
            'tool.output': 0,
          },
        },
        pinnedDigests: [digest('c')],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a packet with no pinnedDigests entry for a pinned segment', () => {
    const pinnedSeg = segment({
      id: 'seg-pinned',
      kind: 'pinned.spec',
      contentHash: digest('c'),
      pinned: true,
      compactable: false,
    });
    const result = ContextPacketSchema.safeParse(
      packet({ segments: [pinnedSeg], pinnedDigests: [] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a packet whose pinnedDigests carries an extra digest', () => {
    const result = ContextPacketSchema.safeParse(
      packet({ segments: [segment()], pinnedDigests: [digest('c')] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a mismatched digest for a pinned segment', () => {
    const pinnedSeg = segment({
      id: 'seg-pinned',
      kind: 'pinned.spec',
      contentHash: digest('c'),
      pinned: true,
      compactable: false,
    });
    const result = ContextPacketSchema.safeParse(
      packet({ segments: [pinnedSeg], pinnedDigests: [digest('d')] }),
    );
    expect(result.success).toBe(false);
  });
});

suite('packetTotalsAreConsistent (AC1)', () => {
  it('returns consistent: true for a hand-built 6-segment packet whose totals reconcile', () => {
    const segments = [
      segment({
        id: 's1',
        kind: 'pinned.spec',
        sourceEvent: 1,
        pinned: true,
        compactable: false,
        tokens: { estimated: 100, method: 'heuristic' },
      }),
      segment({
        id: 's2',
        kind: 'pinned.constraints',
        sourceEvent: 2,
        pinned: true,
        compactable: false,
        tokens: { estimated: 50, method: 'heuristic' },
      }),
      segment({
        id: 's3',
        kind: 'task.brief',
        sourceEvent: 3,
        tokens: { estimated: 200, method: 'heuristic' },
      }),
      segment({
        id: 's4',
        kind: 'fact',
        sourceEvent: 4,
        tokens: { estimated: 30, method: 'heuristic' },
      }),
      segment({
        id: 's5',
        kind: 'fact',
        sourceEvent: 5,
        tokens: { estimated: 20, method: 'heuristic' },
      }),
      segment({
        id: 's6',
        kind: 'artifact.handle',
        sourceEvent: 6,
        tokens: { estimated: 10, method: 'heuristic' },
      }),
    ];
    const p = ContextPacketSchema.parse(
      packet({
        segments,
        totals: {
          tokens: 410,
          byKind: {
            'pinned.constraints': 50,
            'pinned.spec': 100,
            'pinned.pathscope': 0,
            'task.brief': 200,
            fact: 50,
            'artifact.handle': 10,
            retrieved: 0,
            'history.summary': 0,
            'tool.output': 0,
          },
        },
        pinnedDigests: [segments[0]?.contentHash, segments[1]?.contentHash],
      }),
    );
    const result = packetTotalsAreConsistent(p);
    expect(result.consistent).toBe(true);
    expect(p.totals.tokens).toBe(p.segments.reduce((sum, s) => sum + s.tokens.estimated, 0));
    expect(p.totals.byKind.fact).toBe(
      p.segments.filter((s) => s.kind === 'fact').reduce((sum, s) => sum + s.tokens.estimated, 0),
    );
  });

  it('is not left to the builder: a doctored totals.tokens is caught', () => {
    const p = ContextPacketSchema.parse(packet());
    const doctored = { ...p, totals: { ...p.totals, tokens: p.totals.tokens + 100 } };
    const result = packetTotalsAreConsistent(doctored);
    expect(result.consistent).toBe(false);
    if (!result.consistent) expect(result.path).toBe('totals.tokens');
  });

  it('catches a doctored totals.byKind entry once totals.tokens itself reconciles', () => {
    const p = ContextPacketSchema.parse(
      packet({
        segments: [
          segment(),
          segment({ id: 'seg-2', kind: 'fact', tokens: { estimated: 0, method: 'heuristic' } }),
        ],
      }),
    );
    const doctored = {
      ...p,
      totals: {
        ...p.totals,
        byKind: {
          ...p.totals.byKind,
          fact: 999,
          'artifact.handle': p.totals.byKind['artifact.handle'] - 999,
        },
      },
    };
    const result = packetTotalsAreConsistent(doctored);
    expect(result.consistent).toBe(false);
    if (!result.consistent) expect(result.path).toBe('totals.byKind.fact');
  });
});

suite('renderOrderOf (AC6)', () => {
  it('places pinned segments first, and history.summary in the chronological position of what it replaced', () => {
    // Insertion order deliberately scrambles the chronology: the summary
    // (sourceEvent 5, replacing turns whose events were 3-7) is listed
    // before an earlier task.brief (sourceEvent 2) and both pinned segments
    // carry the *latest* sourceEvent of all — a naive "insertion order" or
    // "pinned-then-array-order" implementation would misplace them.
    const summary = segment({
      id: 'seg-summary',
      kind: 'history.summary',
      sourceEvent: 5,
      tokens: { estimated: 60, method: 'heuristic' },
    });
    const brief = segment({
      id: 'seg-brief-early',
      kind: 'task.brief',
      sourceEvent: 2,
      tokens: { estimated: 40, method: 'heuristic' },
    });
    const toolOutput = segment({
      id: 'seg-tool',
      kind: 'tool.output',
      sourceEvent: 8,
      tokens: { estimated: 15, method: 'heuristic' },
    });
    const pinnedSpec = segment({
      id: 'seg-pinned-spec',
      kind: 'pinned.spec',
      sourceEvent: 20,
      pinned: true,
      compactable: false,
      tokens: { estimated: 100, method: 'heuristic' },
    });
    const pinnedConstraints = segment({
      id: 'seg-pinned-constraints',
      kind: 'pinned.constraints',
      sourceEvent: 21,
      pinned: true,
      compactable: false,
      tokens: { estimated: 50, method: 'heuristic' },
    });

    const p = ContextPacketSchema.parse(
      packet({
        segments: [summary, brief, toolOutput, pinnedSpec, pinnedConstraints],
        totals: {
          tokens: 265,
          byKind: {
            'pinned.constraints': 50,
            'pinned.spec': 100,
            'pinned.pathscope': 0,
            'task.brief': 40,
            fact: 0,
            'artifact.handle': 0,
            retrieved: 0,
            'history.summary': 60,
            'tool.output': 15,
          },
        },
        pinnedDigests: [pinnedSpec.contentHash, pinnedConstraints.contentHash],
      }),
    );

    const order = renderOrderOf(p).map((s) => s.id);
    expect(order).toEqual([
      'seg-pinned-spec',
      'seg-pinned-constraints',
      'seg-brief-early',
      'seg-summary',
      'seg-tool',
    ]);
  });
});

suite('sourceEvent is click-through-able (AC7)', () => {
  it('every Segment carries an EventSeq sourceEvent', () => {
    const s = SegmentSchema.parse(segment({ sourceEvent: 42 }));
    expect(s.sourceEvent).toBe(42);
  });

  it('rejects a non-integer sourceEvent', () => {
    expect(SegmentSchema.safeParse(segment({ sourceEvent: 1.5 })).success).toBe(false);
  });
});

suite('round trip', () => {
  it('a full ContextPacket survives JSON.stringify/parse unchanged', () => {
    const p = ContextPacketSchema.parse(packet());
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
