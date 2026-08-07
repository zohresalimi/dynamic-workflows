/**
 * KAR-10.2 AC9 — the second framing attempt's packet, against the real ledger
 * the first attempt wrote.
 *
 * The unit suite (`packages/core/src/framing-packet.test.ts`) proves the
 * builder refuses a foreign segment. What only a real ledger can prove is the
 * clause that matters most in practice: **every segment's `sourceEvent` points
 * at an event in this run's ledger.** A packet whose provenance points at a
 * `seq` nobody wrote is a packet whose F10.3 click-through dead-ends, and a
 * builder can satisfy every other assertion in this story while getting that
 * wrong.
 *
 * F6.1 exists *"so that the edges in the plan graph mean something"*. A framing
 * agent that silently inherits the previous attempt's transcript is the
 * smallest possible violation and the easiest to introduce, because "just
 * resume the session" looks like an optimisation.
 *
 * Verifies: EPIC-10-S12 · AC9 · test plan #9
 */
import type { Db, RunId, TaskSpec } from '@DeFlow/core';
import { buildFramingPacket, NodeIdSchema, RunIdSchema, sealTaskSpec } from '@DeFlow/core';
import { appendEvents, openLedger, readRange } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ac1012');
const FRAMING = NodeIdSchema.parse('framing');
const T0 = 1_754_380_800_000;

const RAW_TASK = 'Migrate the design system to Vue 3. Keep the public component API stable.';
const REJECTION = 'The criteria say nothing about the date picker, which is the risky component.';

const REJECTED_DRAFT = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Migrate every component under packages/ui to Vue 3.',
  scope: { included: ['packages/ui'] },
  nonGoals: ['Do not touch packages/legacy.'],
  constraints: ['No new runtime dependency.'],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'pnpm typecheck passes.', verifiedBy: ['typecheck'] },
  ],
  knownFailureModes: [
    {
      id: 'fm-1',
      description: 'A component silently loses its default slot.',
      detection: 'The snapshot suite for that component changes.',
    },
  ],
} as const;

/** The ledger the second attempt inherits: intake, the first attempt's
 * `run.created`, and the operator rejecting the spec it carried. */
function seedRejectedAttempt(db: Db, spec: TaskSpec): { task: number; rejection: number } {
  const seqs = appendEvents(db, [
    {
      runId: RUN,
      ts: T0,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        sha256: 'a'.repeat(64),
        raw: RAW_TASK,
        provenance: { kind: 'text', by: 'ui', submittedAt: T0 },
      },
    },
    {
      runId: RUN,
      ts: T0 + 1_000,
      kind: 'run.created',
      v: 1,
      epoch: 1,
      payload: { spec, cwd: '/srv/project', repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: RUN,
      ts: T0 + 2_000,
      kind: 'human.requested',
      v: 1,
      epoch: 1,
      nodeId: FRAMING,
      attempt: 0,
      payload: {
        node: FRAMING,
        prompt: 'Approve this spec?',
        options: [
          { id: 'approve', label: 'Approve', effect: 'approve' },
          { id: 'reject', label: 'Reject', effect: 'reject' },
        ],
      },
    },
    {
      runId: RUN,
      ts: T0 + 3_000,
      kind: 'human.responded',
      v: 1,
      epoch: 1,
      nodeId: FRAMING,
      attempt: 0,
      payload: {
        node: FRAMING,
        optionId: 'reject',
        text: REJECTION,
        at: new Date(T0 + 3_000).toISOString(),
      },
    },
  ]);
  return { task: seqs[0] as number, rejection: seqs[3] as number };
}

suite('EPIC-10-S12 — a second framing attempt after a rejection', () => {
  it('carries the task, the rejected spec and the reason, and nothing from the transcript', async ({
    tmp,
  }) => {
    await mkdir(join(tmp, 'data'), { recursive: true });
    const db = openLedger(join(tmp, 'data'));
    const spec = await sealTaskSpec(REJECTED_DRAFT);
    const seqs = seedRejectedAttempt(db, spec);
    const built = readRange(db, RUN, 0, 100).events.length;

    const packet = await buildFramingPacket({
      runId: RUN,
      nodeId: FRAMING,
      attempt: 1,
      builtAtEvent: built,
      target: { provider: 'claude', model: 'claude-sonnet-4-6', maxContext: 200_000 },
      task: { text: RAW_TASK, sourceEvent: seqs.task },
      constraints: [{ form: 'require', statement: 'never commit a credential' }],
      rejected: { spec, reason: REJECTION, sourceEvent: seqs.rejection },
    });

    const text = packet.segments.map((entry) => entry.text).join('\n');
    expect(text).toContain(RAW_TASK);
    expect(text).toContain(spec.goal);
    expect(text).toContain(REJECTION);
    expect(text).toContain('never commit a credential');
    expect(packet.segments.map((entry) => entry.kind)).not.toContain('history.summary');

    // Every segment's provenance resolves to an event this run actually wrote.
    const known = new Set(readRange(db, RUN, 0, 100).events.map((event) => event.seq));
    known.add(built);
    for (const entry of packet.segments) {
      expect(known.has(entry.sourceEvent)).toBe(true);
    }
    db.close();
  });

  it('matches the golden packet, with the pinned segments first', async ({ tmp }) => {
    await mkdir(join(tmp, 'data'), { recursive: true });
    const db = openLedger(join(tmp, 'data'));
    const spec = await sealTaskSpec(REJECTED_DRAFT);
    const seqs = seedRejectedAttempt(db, spec);

    const packet = await buildFramingPacket({
      runId: RUN,
      nodeId: FRAMING,
      attempt: 1,
      builtAtEvent: 5,
      target: { provider: 'claude', model: 'claude-sonnet-4-6', maxContext: 200_000 },
      task: { text: RAW_TASK, sourceEvent: seqs.task },
      constraints: [{ form: 'require', statement: 'never commit a credential' }],
      rejected: { spec, reason: REJECTION, sourceEvent: seqs.rejection },
    });

    expect(packet.segments.map((entry) => entry.pinned)).toEqual([true, true, false, false]);
    await expect(JSON.stringify(packet, null, 2)).toMatchFileSnapshot(
      '__snapshots__/packet-framing.json',
    );
    db.close();
  });
});
