/**
 * KAR-10.2 AC9 — what the framing agent is given, and everything it is not.
 *
 * Verifies: EPIC-10-S12 · AC9 · test plan #9
 */
import { expect, it, describe as suite } from 'vitest';
import vue3Migration from '../test/fixtures/specs/vue3-migration.json' with { type: 'json' };
import type { Constraint } from './constraint.ts';
import { renderOrderOf } from './context-packet.ts';
import {
  buildFramingPacket,
  ForeignSegmentInFramingPacket,
  FRAMING_SEGMENT_KINDS,
  type FramingPacketInput,
} from './framing-packet.ts';
import { EventSeqSchema } from './ids.ts';
import { contextSegment } from './pinned-set.ts';
import { TaskSpecSchema } from './task-spec.ts';

const RAW_TASK = 'Migrate the design system to Vue 3. Keep the public component API stable.';

const CONSTRAINTS: Constraint[] = [
  { form: 'forbid', subject: 'write to the repository', forbidden: ['any path'] },
  { form: 'require', statement: 'never commit a credential' },
];

const base: FramingPacketInput = {
  runId: 'run_20260807T101500Z_ac1002',
  nodeId: 'framing',
  attempt: 0,
  builtAtEvent: 4,
  target: { provider: 'claude', model: 'claude-sonnet-4-6', maxContext: 200_000 },
  task: { text: RAW_TASK, sourceEvent: 1 },
  constraints: CONSTRAINTS,
};

suite('EPIC-10-S12 — the framing agent inherits no other node’s context (AC9)', () => {
  it('carries the raw task verbatim and the pinned safety constraints', async () => {
    const packet = await buildFramingPacket(base);

    const brief = packet.segments.find((segment) => segment.kind === 'task.brief');
    expect(brief?.text).toContain(RAW_TASK);
    expect(
      packet.segments.filter((segment) => segment.pinned).map((segment) => segment.id),
    ).toEqual(['pinned-constraints-safety', 'pinned-constraints-permission']);
    expect(
      packet.segments.find((segment) => segment.id === 'pinned-constraints-safety')?.text,
    ).toContain('never commit a credential');
    // AC1 — the level the packet states is the level the node is scheduled at.
    expect(
      packet.segments.find((segment) => segment.id === 'pinned-constraints-permission')?.text,
    ).toContain('read');
  });

  it('pins nothing derived from a spec, because the spec is what this node produces', async () => {
    const packet = await buildFramingPacket(base);

    expect(packet.segments.map((segment) => segment.kind)).not.toContain('pinned.spec');
  });

  it('contains no history.summary segment at all', async () => {
    const packet = await buildFramingPacket(base);

    expect(packet.segments.map((segment) => segment.kind)).not.toContain('history.summary');
    expect(packet.totals.byKind['history.summary']).toBe(0);
  });

  it('refuses a supplied segment whose kind is not one framing may carry', async () => {
    const foreign = await contextSegment({
      id: 'history-attempt-0',
      kind: 'history.summary',
      text: 'The first framing attempt said …',
      sourceEvent: EventSeqSchema.parse(3),
    });

    await expect(buildFramingPacket({ ...base, segments: [foreign] })).rejects.toBeInstanceOf(
      ForeignSegmentInFramingPacket,
    );
    expect(FRAMING_SEGMENT_KINDS).not.toContain('history.summary');
  });

  it('carries the rejected spec and the rejection reason on a second attempt', async () => {
    const rejected = TaskSpecSchema.parse(vue3Migration);
    const packet = await buildFramingPacket({
      ...base,
      attempt: 1,
      rejected: {
        spec: rejected,
        reason: 'The criteria do not mention the date picker at all.',
        sourceEvent: 9,
      },
    });

    const text = packet.segments.map((segment) => segment.text).join('\n');
    expect(text).toContain(rejected.goal);
    expect(text).toContain('The criteria do not mention the date picker at all.');
    // Still no transcript: the *spec* is carried, the turns that produced it
    // are not.
    expect(packet.segments.map((segment) => segment.kind)).not.toContain('history.summary');
  });

  it('every segment’s sourceEvent is an event of this run, and pinned render first', async () => {
    const packet = await buildFramingPacket({
      ...base,
      attempt: 1,
      rejected: {
        spec: TaskSpecSchema.parse(vue3Migration),
        reason: 'not specific enough',
        sourceEvent: 9,
      },
    });

    expect(packet.segments.map((segment) => segment.sourceEvent).toSorted((a, b) => a - b)).toEqual(
      [1, 4, 4, 9],
    );
    const order = renderOrderOf(packet).map((segment) => segment.pinned);
    expect(order).toEqual([...order].toSorted((a, b) => Number(b) - Number(a)));
  });

  it('is a DeFlow.contextpacket.v1 whose pinnedDigests match its pinned segments', async () => {
    const packet = await buildFramingPacket(base);

    expect(packet.schemaId).toBe('DeFlow.contextpacket.v1');
    expect(packet.pinnedDigests.toSorted()).toEqual(
      packet.segments
        .filter((segment) => segment.pinned)
        .map((segment) => segment.contentHash)
        .toSorted(),
    );
  });
});
