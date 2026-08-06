/**
 * KAR-07.7 test plan row 5 — the resolution node's shape, and above all what
 * its context packet does *not* contain
 * (docs/09-workspace-and-safety.md §7.2; AC5).
 *
 * Written before ./resolution-node.ts exists. §7.2 states the rule twice, in
 * two directions — *never let an agent auto-resolve blind* and *never hand a
 * resolver the whole repository* — and the second one is the one a
 * reimplementation quietly loses, because a packet built by reading the
 * conflicted files off the integration worktree looks right in review and is
 * an order of magnitude more expensive per conflict.
 *
 * So the assertions here are negative on purpose: the packet has exactly two
 * segment kinds, and no file that was not conflicted appears anywhere in it.
 * The positive half — that the hunks are the ones git produced — belongs to
 * the integration spec, where real git produces them.
 *
 * Verifies: EPIC-07-S27 · AC5
 */
import { type PlanGraph, PlanGraphSchema, patchIsWellFormed } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import type { ConflictedFile } from './conflict-hunks.ts';
import {
  type IntentSummary,
  RESOLUTION_SEGMENT_KINDS,
  resolutionNode,
  resolutionNodeId,
} from './resolution-node.ts';

const RUN = 'run_20260806T090000Z_5c1d2e';
const INT = 'DeFlow/int/r1';
const BRANCH = 'DeFlow/r1__n2';
const WORKTREE = '/tmp/repo/.DeFlow/wt/int__r1';

const CONFLICTS: ConflictedFile[] = [
  {
    path: 'src/a.ts',
    hunks: [
      '<<<<<<< DeFlow/int/r1\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> DeFlow/r1__n2',
    ],
  },
];

const INTENTS: IntentSummary[] = [
  {
    nodeId: 'n2',
    text: 'Raise the retry cap to 2 so slow providers get a second chance.',
    sourceEvent: 41,
  },
  { nodeId: 'n1', text: 'Leave the retry cap at 1; the caller already retries.', sourceEvent: 37 },
];

const request = (overrides: Record<string, unknown> = {}) => ({
  runId: RUN,
  nodeId: 'n2',
  branch: BRANCH,
  integrationBranch: INT,
  cwd: WORKTREE,
  conflicts: CONFLICTS,
  intents: INTENTS,
  builtAtEvent: 42,
  target: { provider: 'claude-code', model: 'claude-opus-4', maxContext: 200_000 },
  budgetLimitTokens: 100_000,
  estimate: { costUsd: 0.5, wallClockMs: 120_000 },
  replanDepth: 1,
  ...overrides,
});

/** A one-node graph the patch can be checked against. */
const graph = (): PlanGraph =>
  PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'a'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'b'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-06T09:00:00.000Z',
    nodes: [
      {
        id: 'n2',
        title: 'Widen the retry policy',
        type: 'agent',
        deps: [],
        lifecycle: 'active',
        reads: [],
        writes: [],
        permission: 'worktree',
        pathScopes: { write: ['src/**'] },
        returns: { schemaId: 'DeFlow.finding.v1' },
        brief: 'Widen the retry policy.',
        provider: { prefer: ['claude-code'], requires: [] },
        resume: 'always-replay',
      },
    ],
    edges: [],
  });

suite('EPIC-07-S27: the resolution node is inserted by a patch that names the conflict', () => {
  it('proposes an insert-nodes patch from the scheduler', async () => {
    const spec = await resolutionNode(request());
    expect(spec.patch.proposedBy).toBe('scheduler');
    expect(spec.patch.ops).toHaveLength(1);
    expect(spec.patch.ops[0]?.op).toBe('insert-nodes');
  });

  it('names the conflicting branch and the conflicted path in the reason', async () => {
    const spec = await resolutionNode(request());
    expect(spec.patch.reason).toContain(BRANCH);
    expect(spec.patch.reason).toContain(INT);
    expect(spec.patch.reason).toContain('src/a.ts');
  });

  it('is well formed against the graph it is inserted into', async () => {
    const spec = await resolutionNode(request());
    expect(patchIsWellFormed(spec.patch, graph())).toEqual({ ok: true });
  });

  it('runs at worktree permission, on the integration worktree', async () => {
    const spec = await resolutionNode(request());
    expect(spec.node.permission).toBe('worktree');
    expect(spec.cwd).toBe(WORKTREE);
  });

  it('may write only the conflicted paths', async () => {
    const spec = await resolutionNode(request());
    expect(spec.node.pathScopes.write).toEqual(['src/a.ts']);
  });

  it('derives a stable id from the node whose branch would not merge', () => {
    expect(resolutionNodeId('n2')).toBe(resolutionNodeId('n2'));
    expect(resolutionNodeId('n2')).not.toBe(resolutionNodeId('n3'));
    expect(resolutionNodeId('n2')).toContain('n2');
  });
});

suite('EPIC-07-S27: the packet contains exactly two segment kinds (AC5)', () => {
  it('has exactly the two kinds §7.2 names, and no third', async () => {
    const spec = await resolutionNode(request());
    const kinds = [...new Set(spec.packet.segments.map((segment) => segment.kind))].toSorted();
    expect(kinds).toEqual([...RESOLUTION_SEGMENT_KINDS].toSorted());
    expect(kinds).toHaveLength(2);
  });

  it('carries one hunk segment per conflicted file and one segment per intent', async () => {
    const spec = await resolutionNode(request());
    const byKind = (kind: string) => spec.packet.segments.filter((s) => s.kind === kind);
    expect(byKind('tool.output')).toHaveLength(1);
    expect(byKind('fact')).toHaveLength(2);
  });

  it('contains no repository file that was not conflicted', async () => {
    const spec = await resolutionNode(request());
    const text = spec.packet.segments.map((segment) => segment.text).join('\n');
    for (const untouched of ['src/b.ts', 'README.md', 'package.json', 'src/deep/c.ts']) {
      expect(text).not.toContain(untouched);
    }
    expect(text).toContain('src/a.ts');
  });

  it('contains the conflicted hunk verbatim and both intent summaries', async () => {
    const spec = await resolutionNode(request());
    const text = spec.packet.segments.map((segment) => segment.text).join('\n');
    expect(text).toContain(CONFLICTS[0]?.hunks[0] as string);
    expect(text).toContain(INTENTS[0]?.text as string);
    expect(text).toContain(INTENTS[1]?.text as string);
  });

  it('points each segment at the event it came from', async () => {
    const spec = await resolutionNode(request());
    const intentSegments = spec.packet.segments.filter((segment) => segment.kind === 'fact');
    expect(intentSegments.map((segment) => segment.sourceEvent).toSorted((a, b) => a - b)).toEqual([
      37, 41,
    ]);
  });

  it('refuses anything other than exactly two intent summaries', async () => {
    await expect(resolutionNode(request({ intents: [INTENTS[0]] }))).rejects.toThrow(/exactly two/);
    await expect(
      resolutionNode(request({ intents: [...INTENTS, { ...INTENTS[0], nodeId: 'n3' }] })),
    ).rejects.toThrow(/exactly two/);
  });

  it('refuses to build a resolution packet for a merge that did not conflict', async () => {
    await expect(resolutionNode(request({ conflicts: [] }))).rejects.toThrow(/no conflict/i);
  });

  it('pins nothing, so no segment is silently dropped by compaction', async () => {
    const spec = await resolutionNode(request());
    expect(spec.packet.pinnedDigests).toEqual([]);
    expect(spec.packet.segments.every((segment) => !segment.compactable)).toBe(true);
  });
});
