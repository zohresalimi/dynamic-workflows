/**
 * KAR-12.5 AC3, AC6 — the fix node's packet, which is narrow by construction
 * rather than by instruction (docs/10-verification-gates.md §7).
 *
 * `buildRepairPacket` takes no caller-supplied segment array. That is the
 * mechanism: there is no parameter through which a producer transcript, a
 * second finding or a session summary could arrive, so "it contains no
 * producer transcript" is a property of the type rather than a discipline
 * somebody has to remember. The tests below assert the manifest that reaches
 * `context.built`, which is where AC3 says the claim has to be checkable.
 *
 * Pure: `buildPacket` tokenises through the injected estimator and hashes in
 * memory. Nothing here spawns, reads a file or opens a database — so it is a
 * unit test, per docs/14-testing-strategy.md §2. The *archetype golden* built
 * from a real failing gate lives in ../test/integration/repair-packet.test.ts.
 *
 * Verifies: EPIC-12-S30 (third scenario), EPIC-12-S31 · AC3, AC6
 */
import {
  type FindingV2,
  type GateId,
  type Handle,
  type NodeId,
  type TaskSpec,
  TaskSpecSchema,
  type VerdictV3,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { buildRepairPacket, REPAIR_SEGMENT_IDS } from './repair-packet.ts';

const GATE = 'typecheck' as GateId;
const PRODUCER = 'impl-1' as NodeId;
const EVIDENCE = `artifact://${'a'.repeat(64)}` as Handle;

const spec: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Migrate the date picker to the Vue 3 composition API',
  scope: { included: ['packages/ui'] },
  nonGoals: ['Rewriting the payment gateway integration'],
  constraints: ['must not change the public API of the ui package'],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-3', statement: 'The date picker compiles under strict TypeScript' },
  ],
  knownFailureModes: [
    {
      id: 'fm-1',
      description: 'the codemod silently drops v-model modifiers',
      detection: 'the date picker test suite',
    },
  ],
  approvedBy: { at: '2026-08-06T09:00:00Z', via: 'ui' },
  specHash: `sha256-${'0'.repeat(64)}`,
});

const finding = (id: string, overrides: Partial<FindingV2> = {}): FindingV2 =>
  ({
    id,
    severity: 'blocker',
    message: "ts2345: Argument of type 'string' is not assignable to parameter of type 'Date'",
    evidence: [EVIDENCE],
    location: { file: 'packages/ui/src/DatePicker.vue', line: 88, blobSha: 'b'.repeat(40) },
    ...overrides,
  }) as FindingV2;

const verdict = (findings: readonly FindingV2[]): VerdictV3 =>
  ({
    schemaId: 'DeFlow.verdict.v3',
    outcome: 'fail',
    gate: GATE,
    evaluatedNode: PRODUCER,
    by: { node: 'gate-typecheck', provider: 'deflow', model: 'deterministic-gate' },
    criteria: [{ id: 'ac-3', status: 'unsatisfied' }],
    findings,
    summary: 'the DatePicker still passes a string where a Date is required',
    cost: { durationMs: 1200 },
  }) as unknown as VerdictV3;

const packetInput = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run_20260806T090000Z_5c1d2e',
  node: 'fix-a13f5c2b1e04' as NodeId,
  attempt: 1,
  builtAtEvent: 42,
  gate: GATE,
  spec,
  finding: finding('a13f5c2b1e04'),
  files: [
    { path: 'packages/ui/src/DatePicker.vue', text: 'const value: Date = props.modelValue;\n' },
  ],
  evidence: EVIDENCE,
  pathScopes: ['packages/ui/src/**'],
  permission: 'worktree',
  target: { provider: 'claude', model: 'the-model', maxContext: 200_000 },
  ...overrides,
});

// ── AC3: exactly one finding, and nothing else ───────────────────────────────

suite('the fix node packet is narrow (EPIC-12-S30, third scenario)', () => {
  it('pins the spec', async () => {
    const { packet } = await buildRepairPacket(packetInput());

    expect(packet.segments.filter((segment) => segment.pinned).length).toBeGreaterThan(0);
    expect(packet.segments.some((segment) => segment.kind === 'pinned.spec')).toBe(true);
  });

  it('carries exactly one Finding', async () => {
    const { packet } = await buildRepairPacket(packetInput());
    const findings = packet.segments.filter((segment) => segment.id === REPAIR_SEGMENT_IDS.finding);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toContain('a13f5c2b1e04');
  });

  it('names the files that Finding names, and no others', async () => {
    const { packet } = await buildRepairPacket(
      packetInput({
        files: [
          { path: 'packages/ui/src/DatePicker.vue', text: 'a\n' },
          { path: 'packages/ui/src/index.ts', text: 'b\n' },
        ],
      }),
    );
    const files = packet.segments.filter((segment) => segment.id.startsWith('repair-file-'));

    expect(files.map((segment) => segment.id)).toEqual(['repair-file-0', 'repair-file-1']);
    expect(files[0]?.text).toContain('packages/ui/src/DatePicker.vue');
  });

  it("carries a handle to the failing command's output artifact", async () => {
    const { packet } = await buildRepairPacket(packetInput());
    const evidence = packet.segments.find((segment) => segment.id === REPAIR_SEGMENT_IDS.evidence);

    expect(evidence?.kind).toBe('artifact.handle');
    expect(evidence?.text).toContain(EVIDENCE);
  });

  it('contains no other finding, whatever the verdict held', async () => {
    const { packet } = await buildRepairPacket(packetInput());
    const rendered = packet.segments.map((segment) => segment.text).join('\n');

    expect(rendered).toContain('a13f5c2b1e04');
    expect(rendered).not.toContain('9c02d7ab3311');
  });

  it('contains no producer transcript: there is no segment kind that could carry one', async () => {
    const { packet } = await buildRepairPacket(packetInput());

    expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
  });
});

// ── AC6: attempt 2 gets the verdicts, never the transcript ───────────────────

suite('attempt 2 receives the previous verdicts (EPIC-12-S31)', () => {
  const attemptTwo = (previous: readonly VerdictV3[]) =>
    buildRepairPacket(packetInput({ attempt: 2, previousVerdicts: previous }));

  it("renders attempt 1's verdict as findings", async () => {
    const { packet } = await attemptTwo([verdict([finding('9c02d7ab3311')])]);
    const carried = packet.segments.filter((segment) =>
      segment.id.startsWith(REPAIR_SEGMENT_IDS.previousAttempt),
    );

    expect(carried).toHaveLength(1);
    expect(carried[0]?.text).toContain('9c02d7ab3311');
  });

  it('repeats the previous summary verbatim, so a shown-not-to-work fix is not retried', async () => {
    const previous = verdict([finding('9c02d7ab3311')]);
    const { packet } = await attemptTwo([previous]);
    const carried = packet.segments.find((segment) =>
      segment.id.startsWith(REPAIR_SEGMENT_IDS.previousAttempt),
    );

    expect(carried?.text).toContain(previous.summary);
  });

  it('carries no segment derived from the previous attempt’s transcript', async () => {
    const { packet } = await attemptTwo([verdict([finding('9c02d7ab3311')])]);

    expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
    expect(packet.segments.every((segment) => !segment.id.includes('transcript'))).toBe(true);
  });

  it('carries one segment per previous attempt, in attempt order', async () => {
    const { packet } = await buildRepairPacket(
      packetInput({
        attempt: 3,
        previousVerdicts: [verdict([finding('9c02d7ab3311')]), verdict([finding('55c1ee900a72')])],
      }),
    );
    const carried = packet.segments.filter((segment) =>
      segment.id.startsWith(REPAIR_SEGMENT_IDS.previousAttempt),
    );

    expect(carried.map((segment) => segment.id)).toEqual([
      'repair-attempt-1-verdict',
      'repair-attempt-2-verdict',
    ]);
  });

  it('says nothing about earlier attempts on attempt 1', async () => {
    const { packet } = await buildRepairPacket(packetInput());

    expect(
      packet.segments.some((segment) => segment.id.startsWith(REPAIR_SEGMENT_IDS.previousAttempt)),
    ).toBe(false);
  });
});
