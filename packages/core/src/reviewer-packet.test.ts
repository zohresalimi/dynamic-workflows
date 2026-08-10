/**
 * KAR-12.2 AC10 — what the reviewer gets, and the one thing it never gets.
 *
 * F6.1's "no implicit context inheritance" is doing real work here rather than
 * being a slogan: *a reviewer that has read the producer's rationale is primed
 * to accept it* (docs/10-verification-gates.md §3.3). The producer's transcript
 * is the single most natural thing to hand a reviewer and the single thing that
 * voids F7.2, so it is refused at construction rather than merely left out of a
 * default.
 *
 * Every assertion is on the **manifest** — the segment records that go into
 * `context.built` — because that is the ledger event NF10 traces the claim to.
 * A debug log saying the packet looked right proves nothing about a run read
 * back next week.
 *
 * Verifies: EPIC-12-S16 · AC10
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { type EventSeq, EventSeqSchema } from './ids.ts';
import { contextSegment } from './pinned-set.ts';
import {
  buildReviewerPacket,
  REVIEW_DIFF_SEGMENT_ID,
  ReviewerContextInherited,
  type ReviewerPacketInput,
  reviewerGateSegmentId,
} from './reviewer-packet.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);
const baseSpec: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));

function approvedSpec(): TaskSpec {
  const draft = structuredClone(baseSpec);
  draft.nonGoals = ['Rewriting the payment gateway integration'];
  draft.constraints = ['must not change the public API of @voyado/ui'];
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

const seq = (value: number): EventSeq => EventSeqSchema.parse(value);

const DIFF = '--- a/src/router/guards.ts\n+++ b/src/router/guards.ts\n@@ -1 +1 @@\n-old\n+new\n';

function input(overrides: Partial<ReviewerPacketInput> = {}): ReviewerPacketInput {
  return {
    runId: 'run_20260806T090000Z_5c1d2e',
    nodeId: 'design-review',
    attempt: 0,
    builtAtEvent: seq(60),
    target: { provider: 'the-other-one', model: 'a-model', maxContext: 200_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'read' },
      sourceEvent: seq(9),
    },
    producer: { node: 'implement-1', transcriptEvents: [seq(31), seq(32)] },
    diff: { text: DIFF, sourceEvent: seq(44) },
    gateOutput: [
      { gate: 'typecheck', text: 'tsc: no errors', sourceEvent: seq(50) },
      { gate: 'merge-conflict', text: 'merge-tree: clean', sourceEvent: seq(52) },
    ],
    ...overrides,
  };
}

suite('the reviewer packet manifest (AC10 · test plan #9)', () => {
  it('pins the spec goal and the acceptance criteria, first and verbatim', async () => {
    const { packet } = await buildReviewerPacket(input());
    const ids = packet.segments.map((segment) => segment.id);

    expect(ids.slice(0, 2)).toEqual(['pinned-spec-goal', 'pinned-spec-criteria']);
    expect(packet.segments.slice(0, 2).every((segment) => segment.pinned)).toBe(true);
    // Pinned implies never compactable, which is what "verbatim" rests on.
    expect(packet.segments.filter((s) => s.pinned).every((s) => !s.compactable)).toBe(true);
  });

  it('carries the unified diff of the producer branch', async () => {
    const { packet } = await buildReviewerPacket(input());
    const diff = packet.segments.find((segment) => segment.id === REVIEW_DIFF_SEGMENT_ID);

    expect(diff).toBeDefined();
    expect(diff?.sourceEvent).toBe(44);
  });

  it('carries a segment per deterministic and structural gate output', async () => {
    const { packet } = await buildReviewerPacket(input());
    const ids = packet.segments.map((segment) => segment.id);

    expect(ids).toContain(reviewerGateSegmentId('typecheck'));
    expect(ids).toContain(reviewerGateSegmentId('merge-conflict'));
  });

  it('contains no segment whose provenance is the producer transcript', async () => {
    const { packet } = await buildReviewerPacket(input());
    const producerEvents = new Set([31, 52 + 1000]);

    expect(
      packet.segments.some((segment) => producerEvents.has(segment.sourceEvent as number)),
    ).toBe(false);
    expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
  });
});

suite('the transcript is refused, not merely omitted (AC10)', () => {
  it('refuses a segment sourced from an event of the producer transcript', async () => {
    const smuggled = await contextSegment({
      id: 'producer-notes',
      kind: 'tool.output',
      text: "the producer's own reasoning, relabelled",
      sourceEvent: seq(31),
    });

    await expect(buildReviewerPacket(input({ extra: [smuggled] }))).rejects.toThrow(
      ReviewerContextInherited,
    );
  });

  it('refuses a history summary, which is the transcript compacted', async () => {
    const summary = await contextSegment({
      id: 'earlier-turns',
      kind: 'history.summary',
      text: 'what the producer decided and why',
      sourceEvent: seq(99),
    });

    await expect(buildReviewerPacket(input({ extra: [summary] }))).rejects.toThrow(
      ReviewerContextInherited,
    );
  });

  it('names the segment and the reason, so the refusal is actionable', async () => {
    const summary = await contextSegment({
      id: 'earlier-turns',
      kind: 'history.summary',
      text: 'what the producer decided and why',
      sourceEvent: seq(99),
    });

    await expect(buildReviewerPacket(input({ extra: [summary] }))).rejects.toThrow(/earlier-turns/);
  });

  it('admits an unrelated segment from an event the producer did not write', async () => {
    const fact = await contextSegment({
      id: 'dependency-versions',
      kind: 'fact',
      text: 'vue 3.5.13, vue-router 4.5.0',
      sourceEvent: seq(12),
    });

    const { packet } = await buildReviewerPacket(input({ extra: [fact] }));
    expect(packet.segments.map((segment) => segment.id)).toContain('dependency-versions');
  });
});

suite('a packet that could not judge anything is refused too (AC10)', () => {
  it('refuses a reviewer packet whose diff is empty', async () => {
    // Omitting it is a type error; an empty one reaches the same place, which
    // is a reviewer judging a description of a change rather than the change.
    await expect(
      buildReviewerPacket(input({ diff: { text: '   \n', sourceEvent: seq(44) } })),
    ).rejects.toThrow(/diff/);
  });

  it('refuses a reviewer packet with no gate output at all', async () => {
    // A review that never saw the deterministic tier is a review of code whose
    // compile status it is guessing at.
    await expect(buildReviewerPacket(input({ gateOutput: [] }))).rejects.toThrow(/gate/);
  });
});
