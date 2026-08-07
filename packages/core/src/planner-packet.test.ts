/**
 * KAR-10.5 AC7 — the planner reads facts, never a recon transcript.
 *
 * F6.1's rule is *"do not let the planner see another node's transcript"*
 * (docs/06-planning-and-replanning.md §8), and the recon session is the place
 * it is most tempting to break: the transcript is right there and it looks like
 * free context. So the allowlist is structural in the same way
 * `buildFramingPacket`'s is — `history.summary` is not a kind a planner packet
 * has, and a caller that supplies one is refused rather than quietly filtered.
 *
 * The golden snapshot of a whole planner packet built from real recon facts is
 * `packages/daemon/test/integration/recon-survey.test.ts`; these are the rules
 * that hold with no ledger in sight.
 *
 * Verifies: EPIC-10-S24 (second scenario), EPIC-10-S28 (third scenario) · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { contextSegment } from './pinned-set.ts';
import {
  buildPlannerPacket,
  ForeignSegmentInPlannerPacket,
  PLANNER_SEGMENT_KINDS,
} from './planner-packet.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Migrate every component under packages/ui to Vue 3.',
  scope: { included: ['packages/ui'] },
  nonGoals: ['Do not touch packages/legacy.'],
  constraints: ['No new runtime dependency.'],
  priorDecisions: [],
  acceptanceCriteria: [{ id: 'ac-1', statement: 'pnpm typecheck passes.' }],
  knownFailureModes: [],
  approvedBy: { at: '2026-08-07T10:15:00.000Z', via: 'ui' },
  specHash: `sha256-${'1'.repeat(64)}`,
});

const input = () => ({
  runId: 'run_20260807T101500Z_ac1005',
  nodeId: 'planner',
  attempt: 0,
  builtAtEvent: 12,
  target: { provider: 'mock', model: 'mock-1', maxContext: 200_000 },
  spec: SPEC,
  facts: [
    {
      key: 'finding/test-command',
      confidence: 'verified' as const,
      value: { reconKind: 'command', role: 'test', command: 'pnpm test', script: 'vitest run' },
      fromEvidence: ['file://package.json#L5-L5'],
      sourceEvent: 9,
    },
    {
      key: 'scope/touched-paths',
      confidence: 'verified' as const,
      value: { reconKind: 'scope', paths: ['packages/ui'], fileCount: 47 },
      fromEvidence: [`artifact://${'a'.repeat(64)}`],
      sourceEvent: 10,
    },
  ],
});

suite('the planner packet carries facts', () => {
  it('renders one fact segment per recon fact, with its key, confidence and evidence', async () => {
    const packet = await buildPlannerPacket(input());
    const facts = packet.segments.filter((segment) => segment.kind === 'fact');

    expect(facts).toHaveLength(2);
    expect(facts[0]?.text).toContain('finding/test-command');
    expect(facts[0]?.text).toContain('verified');
    expect(facts[0]?.text).toContain('file://package.json#L5-L5');
    expect(facts[1]?.text).toContain('scope/touched-paths');
    // AC3 — the file count the patch policy's blastRadiusFiles reads.
    expect(facts[1]?.text).toContain('47');
    // Each fact's segment points back at the `fact.written` that put it there.
    expect(facts.map((segment) => segment.sourceEvent)).toEqual([9, 10]);
  });

  it('pins the approved spec first, as every other packet does', async () => {
    const packet = await buildPlannerPacket(input());
    expect(packet.segments[0]?.pinned).toBe(true);
    expect(packet.pinnedDigests.length).toBeGreaterThan(0);
  });
});

suite('EPIC-10-S28 — no recon transcript reaches the planner (AC7)', () => {
  it('has no history.summary in its vocabulary at all', () => {
    expect(PLANNER_SEGMENT_KINDS).not.toContain('history.summary');
  });

  it('refuses a supplied history.summary rather than dropping it', async () => {
    const transcript = await contextSegment({
      id: 'recon-transcript',
      kind: 'history.summary',
      text: 'The recon agent said: I looked at package.json and then…',
      sourceEvent: 11 as never,
    });

    await expect(buildPlannerPacket({ ...input(), segments: [transcript] })).rejects.toBeInstanceOf(
      ForeignSegmentInPlannerPacket,
    );
  });

  it('builds a packet whose rendered prompt holds no transcript text', async () => {
    const packet = await buildPlannerPacket(input());
    const rendered = packet.segments.map((segment) => segment.text).join('\n');
    expect(rendered).not.toContain('agent_message_chunk');
    expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
  });
});
