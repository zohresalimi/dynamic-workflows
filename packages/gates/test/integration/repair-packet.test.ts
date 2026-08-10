/**
 * KAR-12.5 test plan #9 — the "repair attempt 2" packet archetype, built from
 * a verdict a real gate actually produced.
 *
 * The golden is over the **manifest shape** — segment ids, kinds and pinned
 * flags — rather than over the rendered bytes, and the choice is the point.
 * What AC3 and AC6 assert is *what is in the packet*: one finding, the files it
 * names, the failing command's output as a handle, the previous attempt's
 * verdict, and no transcript. A golden over the text would break on every
 * TypeScript patch release and be re-approved without being read, which is the
 * failure mode a snapshot has instead of a bug.
 *
 * Integration rather than unit because the verdict is not hand-written: a real
 * `tsc` runs over a real type error in a real worktree, and the finding, its
 * blob anchor and the evidence handle are whatever that produced. A packet
 * assembled from a fabricated verdict cannot show that the fields the builder
 * reads are the fields a gate fills in.
 *
 * Verifies: EPIC-12-S31 · AC3, AC6
 */
import { type NodeId, type TaskSpec, TaskSpecSchema, type VerdictV3 } from '@DeFlow/core';
import { it, makeRepo, repoRoot } from '@DeFlow/testkit';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { loadGateDefinition } from '../../src/definition.ts';
import { buildRepairPacket, REPAIR_SEGMENT_IDS } from '../../src/index.ts';
import { runGate } from '../../src/run-gate.ts';
import { realClock } from './support/clock.ts';

const SPEC_HASH = `sha256-${'ab'.repeat(32)}`;
const PRODUCER = 'impl-1' as NodeId;
const GATE_NODE = 'gate-typecheck' as NodeId;
const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

const spec: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Give the date picker a typed public surface',
  scope: { included: ['src'] },
  nonGoals: ['Rewriting the payment gateway integration'],
  constraints: ['must not change the public API of the ui package'],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-3', statement: 'The date picker compiles under strict TypeScript' },
  ],
  knownFailureModes: [
    { id: 'fm-1', description: 'the codemod drops modifiers', detection: 'the date picker suite' },
  ],
  approvedBy: { at: '2026-08-06T09:00:00Z', via: 'ui' },
  specHash: `sha256-${'0'.repeat(64)}`,
});

const YAML = `id: typecheck
kind: deterministic
title: TypeScript project check
run: ${TSC} -p tsconfig.json --noEmit --pretty false
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-3]
severityFloor: error
`;

const SOURCE = 'export const first: number = "not a number";\n';

interface FailedGate {
  readonly verdict: VerdictV3;
  readonly worktree: string;
}

/** A real failing typecheck, so the finding and its evidence handle are the
 * runner's rather than a fixture author's. */
async function failingGate(tmp: string): Promise<FailedGate> {
  const worktree = join(tmp, 'wt');
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  await makeRepo({
    dir: worktree,
    files: {
      'src/one.ts': SOURCE,
      'tsconfig.json': JSON.stringify({
        compilerOptions: { target: 'es2024', module: 'nodenext', strict: true, noEmit: true },
        include: ['src'],
      }),
    },
  });

  const run = await runGate({
    definition: loadGateDefinition('.DeFlow/gates/typecheck.yaml', YAML),
    worktree,
    repoRoot: worktree,
    node: GATE_NODE,
    evaluatedNode: PRODUCER,
    specHash: SPEC_HASH,
    dataDir,
    clock: realClock,
    scrubbedEnv: [],
  });

  expect(run.outcome).toBe('fail');
  expect(run.evidence).not.toBeNull();
  return { verdict: run.verdict, worktree };
}

/** The manifest as AC3 asks it to be read: ids, kinds and pinned flags. */
const manifestOf = (segments: readonly { id: string; kind: string; pinned: boolean }[]) =>
  segments.map(
    (segment) => `${segment.pinned ? 'pinned ' : '       '}${segment.kind}  ${segment.id}`,
  );

suite('the "repair attempt 2" packet archetype (test plan #9)', () => {
  it('matches the golden manifest for the archetype', async ({ tmp }) => {
    const { verdict, worktree } = await failingGate(tmp);
    const finding = verdict.findings[0];
    if (finding === undefined) throw new Error('the gate reported no finding');

    const { packet } = await buildRepairPacket({
      runId: 'run_20260806T090000Z_5c1d2e',
      node: `fix-${finding.id}` as NodeId,
      attempt: 2,
      builtAtEvent: 42,
      gate: verdict.gate,
      spec,
      finding,
      files: [{ path: 'src/one.ts', text: await readFile(join(worktree, 'src/one.ts'), 'utf8') }],
      evidence: verdict.findings[0]?.evidence[0] ?? `artifact://${'a'.repeat(64)}`,
      pathScopes: ['src/one.ts'],
      permission: 'worktree',
      target: { provider: 'claude', model: 'the-model', maxContext: 200_000 },
      previousVerdicts: [verdict],
    });

    expect(manifestOf(packet.segments)).toMatchInlineSnapshot(`
      [
        "pinned pinned.spec  pinned-spec-goal",
        "pinned pinned.spec  pinned-spec-criteria",
        "pinned pinned.constraints  pinned-constraints-safety",
        "pinned pinned.pathscope  pinned-pathscope",
        "pinned pinned.constraints  pinned-constraints-permission",
        "       fact  repair-finding",
        "       fact  repair-attempt-1-verdict",
        "       retrieved  repair-file-0",
        "       artifact.handle  repair-evidence",
      ]
    `);
  });

  it('carries the real finding id and no second finding', async ({ tmp }) => {
    const { verdict, worktree } = await failingGate(tmp);
    const finding = verdict.findings[0];
    if (finding === undefined) throw new Error('the gate reported no finding');

    const { packet } = await buildRepairPacket({
      runId: 'run_20260806T090000Z_5c1d2e',
      node: `fix-${finding.id}` as NodeId,
      attempt: 2,
      builtAtEvent: 42,
      gate: verdict.gate,
      spec,
      finding,
      files: [{ path: 'src/one.ts', text: await readFile(join(worktree, 'src/one.ts'), 'utf8') }],
      evidence: finding.evidence[0] ?? `artifact://${'a'.repeat(64)}`,
      pathScopes: ['src/one.ts'],
      permission: 'worktree',
      target: { provider: 'claude', model: 'the-model', maxContext: 200_000 },
      previousVerdicts: [verdict],
    });

    const findingSegment = packet.segments.find(
      (segment) => segment.id === REPAIR_SEGMENT_IDS.finding,
    );
    expect(findingSegment?.text).toContain(finding.id);
    // tsc's own words reach the fix node — the packet is narrow, not vague.
    expect(findingSegment?.text).toContain('ts2322');

    // AC6: the previous verdict is there as findings, and nothing that could
    // have come from a transcript is.
    const carried = packet.segments.find((segment) => segment.id === 'repair-attempt-1-verdict');
    expect(carried?.text).toContain(finding.id);
    expect(carried?.text).toContain(verdict.summary);
    expect(packet.segments.some((segment) => segment.kind === 'history.summary')).toBe(false);
  });
});
