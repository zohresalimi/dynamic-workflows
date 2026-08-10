/**
 * KAR-16.3 — `context.ts`, the F10.3 / F10.5 projection.
 *
 * Verifies: EPIC-16-S18 · AC5, AC6
 *
 * Folded over two fixtures, and which one answers which question matters. The
 * compaction pair is a **recording**: `packages/ledger/scripts/build-compaction-fixture.ts`
 * demoted a real oversized body through the real packet builder, and the
 * `vendor.session` half carries the `pre_tokens` the committed `compact_boundary`
 * stream really has. A hand-written object that happened to say `null` would
 * prove nothing about what DeFlow writes.
 */
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import { applyContext, type ContextProjection, emptyContext, SEGMENT_KINDS } from './context.ts';

const compaction = (): ContextProjection => fold('compaction', emptyContext, applyContext);
const happy = (): ContextProjection => fold('happy-path-12', emptyContext, applyContext);

suite('EPIC-16-S18 — two fidelities, two honest renderings (AC5)', () => {
  it('keeps after === null and droppedSegments empty for the vendor.session compaction', () => {
    const vendor = compaction().compactions.find((mark) => mark.scope === 'vendor.session');

    expect(vendor?.fidelity).toBe('partial');
    // Not 0, not an interpolation, not `before`. The chart renders the gap as a
    // gap because the projection carried a gap.
    expect(vendor?.after).toBeNull();
    expect(vendor?.after).not.toBe(0);
    expect(vendor?.droppedSegments).toEqual([]);
    expect(vendor?.before).toBe(167_000);
  });

  it('keeps an exact before/after with a populated droppedSegments[] and pinnedKept[]', () => {
    const packet = compaction().compactions.find((mark) => mark.scope === 'DeFlow.packet');

    expect(packet?.fidelity).toBe('exact');
    expect(typeof packet?.after).toBe('number');
    expect(packet?.before).toBeGreaterThan(packet?.after ?? 0);
    expect(packet?.droppedSegments.length).toBeGreaterThan(0);
    expect(packet?.pinnedKept.length).toBeGreaterThan(0);
    expect(packet?.demotedToHandles.length).toBeGreaterThan(0);
  });

  it('says how much each mark actually saved, and refuses to say for a partial one', () => {
    const marks = compaction().compactions;
    const packet = marks.find((mark) => mark.scope === 'DeFlow.packet');
    const vendor = marks.find((mark) => mark.scope === 'vendor.session');

    expect(packet?.saved).toBe((packet?.before ?? 0) - (packet?.after ?? 0));
    // A delta computed from a missing post-count is the fabrication AC5 names.
    expect(vendor?.saved).toBeNull();
  });
});

suite('EPIC-16-S18 — segment totals reconcile (AC6)', () => {
  it('sums every packet’s segments to totals.tokens', () => {
    const packets = [...happy().packets.values()];

    expect(packets.length).toBeGreaterThan(0);
    for (const held of packets) {
      const sum = held.segments.reduce((total, segment) => total + segment.tokens.estimated, 0);
      expect(sum).toBe(held.totals.tokens);
    }
  });

  it('matches the per-kind sums against totals.byKind for all nine SegmentKinds', () => {
    for (const held of happy().packets.values()) {
      for (const kind of SEGMENT_KINDS) {
        const sum = held.segments
          .filter((segment) => segment.kind === kind)
          .reduce((total, segment) => total + segment.tokens.estimated, 0);
        expect(held.totals.byKind[kind] ?? 0).toBe(sum);
      }
    }
  });

  it('carries the builder’s totals rather than re-deriving them', () => {
    // The two are the same number in two places — the inspector's header and
    // its stacked bar — and they can only disagree if one is recomputed.
    const built = ledger('happy-path-12').find((event) => event.kind === 'context.built');
    if (built?.kind !== 'context.built') throw new Error('the fixture must build a packet');

    const held = happy().packets.get(`${built.payload.node}#${built.payload.attempt}`);
    expect(held?.totals).toEqual(built.payload.packet.totals);
  });

  it('holds all nine kinds in at least one packet, so the assertion above has teeth', () => {
    const kinds = new Set(
      [...happy().packets.values()].flatMap((held) => held.segments.map((one) => one.kind)),
    );

    expect([...kinds].toSorted()).toEqual([...SEGMENT_KINDS].toSorted());
  });
});

suite('EPIC-16-S18 — a pin that did not survive', () => {
  it('marks the node’s packet violated, naming the digests and the segments', () => {
    const state = happy();
    const held = state.packets.get('impl-login#0');

    expect(held?.violated).toBe(true);
    expect(held?.violation?.segmentIds).toEqual(['pinned-spec-goal']);
    expect(held?.violation?.missingDigests[0]).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('lists the violation on the projection, so a view need not scan every packet', () => {
    expect(happy().violations.map((one) => one.node)).toEqual(['impl-login']);
  });

  it('leaves every other packet unviolated', () => {
    const violated = [...happy().packets.values()].filter((held) => held.violated);

    expect(violated).toHaveLength(1);
  });
});

suite('AC11 — an unknown kind is ignored, without throwing and without mutating', () => {
  it('leaves the projection byte-identical', () => {
    const state = happy();
    const before = structuredClone(state);

    expect(() => {
      applyContext(state, unknownKind(9_100, ledger('happy-path-12')[0]?.runId ?? ''));
    }).not.toThrow();

    expect({ ...state, appliedSeq: before.appliedSeq }).toEqual(before);
  });
});
