/**
 * KAR-07.7 — the integration branch and the ordered merge loop, against real
 * git (docs/09-workspace-and-safety.md §7; EPIC-07-S26, S27, S28).
 *
 * Real `git`, hermetically, because every claim §7.1 makes is a claim about
 * what merging really does: that `--no-ff` leaves one merge commit per node
 * branch, that a merge changes every *remaining* branch's conflict count
 * against the integration branch (which is the entire argument for re-sorting),
 * and that the branch a run produces is a branch a human can check out and
 * read. None of those survive a fake git.
 *
 * The fixtures are built so the interesting orders emerge from real merges
 * rather than from a hand-written probe table:
 *
 * - `reorderScene` — n1, n2 and n3 all edit the same region of `shared.ts`,
 *   n4 edits only its own file. Every branch merges cleanly into a fresh
 *   integration branch, so the initial order is completion order; the instant
 *   n1 lands, n2 and n3 start conflicting and n4 does not, and the queue has
 *   to move. That is EPIC-07-S26's second scenario produced rather than
 *   asserted.
 * - `independentScene` — n1 and n2 own a file each, n3 and n4 contend for one.
 *   AC8's shape exactly: N−1 merges, one resolution node, and every node's
 *   change present on the integration branch once the conflict is resolved.
 *
 * `scene()` wraps the injected `run` port and records each argv before
 * delegating to a real `Git`, which is what lets "no invocation pushes the
 * integration branch" and "the resume re-probes before it merges" be
 * assertions about a run in which real git really did the work.
 *
 * Verifies: EPIC-07-S26, EPIC-07-S27, EPIC-07-S28 · AC1-AC8
 */
import type { Db, RunId, Verdict } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger, readRange } from '@DeFlow/ledger';
import { GIT_ENV, git, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { createEffectRunner } from '../../src/effects/durable.ts';
import { integrationBranch, nodeBranch } from '../../src/git/branch-name.ts';
import { Git } from '../../src/git/git.ts';
import type { GitPort } from '../../src/git/merge-tree.ts';
import { ConflictProber } from '../../src/workspace/conflict-prober.ts';
import {
  type GateRequest,
  INTEGRATION_NODE_ID,
  IntegrationLoop,
  type MergeCandidate,
  remainingMergeQueue,
} from '../../src/workspace/integration-loop.ts';

const RUN: RunId = RunIdSchema.parse('run_20260806T090000Z_5c1d2e');
const SHORT_RUN = 'r1';
const INT = integrationBranch(SHORT_RUN);
const EPOCH = 7;
const NOW = 1_754_400_000_000;

/** Two well-separated regions, so an edit to one is not folded into a
 * conflict with the other by git's three-line context window. */
const SHARED = [
  'region-a',
  ...Array.from({ length: 12 }, (_, i) => `filler-${i}`),
  'region-b',
].join('\n');

interface BranchEdit {
  readonly node: string;
  /** Repo-relative path this branch rewrites. */
  readonly file: string;
  readonly contents: string;
}

interface SceneOptions {
  readonly edits: readonly BranchEdit[];
  /** Verdicts the gate returns, in order; the last one repeats. */
  readonly verdicts?: readonly Verdict['outcome'][];
}

const verdict = (outcome: Verdict['outcome'], node: string): Verdict =>
  ({
    schemaId: 'DeFlow.verdict.v1',
    outcome,
    gate: 'integration-gate',
    evaluatedNode: NodeIdSchema.parse(node),
    by: { node: NodeIdSchema.parse('integration-gate'), provider: 'claude-code', model: 'fixture' },
    criteria: [{ id: 'builds', status: outcome === 'pass' ? 'satisfied' : 'unsatisfied' }],
    findings:
      outcome === 'pass'
        ? []
        : [{ id: 'f1', severity: 'blocker', message: 'the suite does not build', evidence: [] }],
    summary: `integration gate ${outcome}`,
  }) as Verdict;

interface Scene {
  readonly repo: string;
  readonly worktree: string;
  readonly db: Db;
  readonly calls: string[][];
  readonly git: GitPort;
  readonly loop: IntegrationLoop;
  readonly gateCalls: GateRequest[];
  candidates(...nodes: readonly string[]): MergeCandidate[];
  mergeCalls(): string[][];
  close(): void;
}

async function scene(tmp: string, options: SceneOptions): Promise<Scene> {
  const repo = join(tmp, 'repo');
  await makeRepo({
    dir: repo,
    files: {
      'shared.ts': SHARED,
      'a.ts': 'a\n',
      'b.ts': 'b\n',
      'c.ts': 'c\n',
      'd.ts': 'd\n',
      // Big enough that "an order of magnitude smaller than the whole
      // repository" is a real comparison rather than an artefact of a
      // three-line fixture.
      'big.ts': Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n'),
    },
  });

  for (const edit of options.edits) {
    await git(repo, ['checkout', '-b', nodeBranch(SHORT_RUN, edit.node), 'main']);
    await writeFile(join(repo, edit.file), edit.contents);
    await git(repo, ['commit', '-am', `${edit.node} rewrites ${edit.file}`]);
    await git(repo, ['checkout', 'main']);
  }

  const wrapped = new Git(repo, { env: GIT_ENV });
  const calls: string[][] = [];
  const recording: GitPort = {
    run: (args, opts) => {
      calls.push([...args]);
      return wrapped.run(args, opts);
    },
  };

  const db = openLedger(tmp);
  const clock = new TestClock(NOW);
  const gateCalls: GateRequest[] = [];
  const outcomes = [...(options.verdicts ?? ['pass'])];

  const loop = new IntegrationLoop({
    git: recording,
    db,
    clock,
    epoch: EPOCH,
    effects: createEffectRunner({ db, clock, daemonStartedAt: NOW, epoch: EPOCH }),
    prober: new ConflictProber({ git: recording, db, clock, epoch: EPOCH }),
    gate: {
      evaluate: (request) => {
        gateCalls.push(request);
        const outcome =
          outcomes.length > 1 ? (outcomes.shift() as Verdict['outcome']) : outcomes[0];
        return Promise.resolve(verdict(outcome as Verdict['outcome'], request.mergedNode));
      },
    },
    resolution: {
      target: { provider: 'claude-code', model: 'fixture', maxContext: 200_000 },
      budgetLimitTokens: 100_000,
      estimate: { costUsd: 0.5, wallClockMs: 120_000 },
      replanDepth: 1,
    },
  });

  return {
    repo,
    worktree: IntegrationLoop.worktreePathFor(repo, SHORT_RUN),
    db,
    calls,
    git: recording,
    loop,
    gateCalls,
    candidates: (...nodes) =>
      nodes.map((node, index) => ({
        nodeId: node,
        branch: nodeBranch(SHORT_RUN, node),
        completedAt: NOW + (index + 1) * 1_000,
      })),
    mergeCalls: () => calls.filter((argv) => argv[0] === 'merge'),
    close: () => {
      db.close();
    },
  };
}

/** The `node.completed` events the blackboard's intent summaries are read
 * from — the only place this run's intents exist until EPIC-09. */
function recordIntents(db: Db, nodes: readonly string[]): void {
  appendEvents(
    db,
    nodes.map((node) => ({
      runId: RUN,
      ts: NOW,
      kind: 'node.completed',
      v: 1,
      epoch: EPOCH,
      nodeId: NodeIdSchema.parse(node),
      attempt: 1,
      payload: {
        node,
        attempt: 1,
        result: {
          status: 'completed',
          output: { summary: `${node} rewrote its own region of the shared file` },
          outputSchemaId: 'DeFlow.finding.v1',
          usage: { inputTokens: 10, outputTokens: 10 },
          costUsd: 0,
          producedFacts: [],
          artifacts: [],
        },
      },
    })),
  );
}

const events = (db: Db, kind: string): Record<string, unknown>[] =>
  readRange(db, RUN, 0, 500)
    .events.filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

/** The run, exactly as the loop is given it — the worktree path is an input,
 * composed by the caller. */
const runOf = (repo: string) => ({
  runId: RUN,
  shortRunId: SHORT_RUN,
  integrationBranch: INT,
  baseRef: 'main',
  worktree: IntegrationLoop.worktreePathFor(repo, SHORT_RUN),
});

const start = (s: Scene) => s.loop.start(runOf(s.repo));

// ── EPIC-07-S26 ─────────────────────────────────────────────────────────────

/** n1, n2 and n3 contend for `region-a`; n4 owns `d.ts`. */
const REORDER_EDITS: BranchEdit[] = [
  { node: 'n1', file: 'shared.ts', contents: SHARED.replace('region-a', 'region-a by n1') },
  { node: 'n2', file: 'shared.ts', contents: SHARED.replace('region-a', 'region-a by n2') },
  { node: 'n3', file: 'shared.ts', contents: SHARED.replace('region-a', 'region-a by n3') },
  { node: 'n4', file: 'd.ts', contents: 'd by n4\n' },
];

suite('EPIC-07-S26: the integration branch is created at run start (AC1)', () => {
  it('creates DeFlow/int/<runId> from the base ref, as a journaled effect', async ({ tmp }) => {
    const s = await scene(tmp, { edits: REORDER_EDITS });
    await start(s);

    expect(await git(s.repo, ['rev-parse', INT])).toBe(await git(s.repo, ['rev-parse', 'main']));
    // The journal, not a log line: the effect row is what makes a restart able
    // to tell "I created it" from "I was about to".
    expect(events(s.db, 'effect.started').map((payload) => payload.kind)).toContain('git');
    expect(events(s.db, 'effect.completed')).toHaveLength(1);
    s.close();
  });

  it('is idempotent — a second start after a crash does not fail', async ({ tmp }) => {
    const s = await scene(tmp, { edits: REORDER_EDITS });
    await start(s);
    await start(s);
    expect(await git(s.repo, ['rev-parse', '--verify', INT])).toMatch(/^[0-9a-f]{40}$/);
    s.close();
  });

  it('records the integration worktree as a domain fact', async ({ tmp }) => {
    const s = await scene(tmp, { edits: REORDER_EDITS });
    await start(s);
    const created = events(s.db, 'workspace.worktree_created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ node: INTEGRATION_NODE_ID, branch: INT, baseRef: 'main' });
    s.close();
  });
});

suite('EPIC-07-S26: after each merge the queue is re-probed and re-sorted (AC2, AC3)', () => {
  it('re-sorts, records both orders, and takes the newly-cheapest branch next', async ({ tmp }) => {
    const s = await scene(tmp, { edits: REORDER_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);

    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));

    const reordered = events(s.db, 'workspace.merge_queue_reordered');
    // Every branch is clean against a fresh integration branch, so the first
    // order is completion order — and n1 landing is what makes n2 and n3
    // expensive and leaves n4 alone.
    expect(reordered[0]).toMatchObject({
      mergedNode: 'n1',
      before: ['n2', 'n3', 'n4'],
      after: ['n4', 'n2', 'n3'],
    });
    expect(outcome.merged.map((merge) => merge.nodeId)).toEqual(['n1', 'n4']);
    expect(outcome.status).toBe('conflict');
    s.close();
  });

  it('emits one reorder event per merge, including the one that empties the queue', async ({
    tmp,
  }) => {
    const s = await scene(tmp, {
      edits: [
        { node: 'n1', file: 'a.ts', contents: 'a by n1\n' },
        { node: 'n2', file: 'b.ts', contents: 'b by n2\n' },
      ],
    });
    await start(s);
    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2'));

    expect(outcome.status).toBe('integrated');
    const reordered = events(s.db, 'workspace.merge_queue_reordered');
    expect(reordered).toHaveLength(2);
    expect(reordered[1]).toMatchObject({ before: [], after: [] });
    expect(remainingMergeQueue(s.db, RUN)).toEqual([]);
    s.close();
  });

  it('runs the gate against the integration branch between merges (AC4)', async ({ tmp }) => {
    const s = await scene(tmp, {
      edits: [
        { node: 'n1', file: 'a.ts', contents: 'a by n1\n' },
        { node: 'n2', file: 'b.ts', contents: 'b by n2\n' },
      ],
    });
    await start(s);
    await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2'));

    expect(s.gateCalls.map((call) => call.mergedNode)).toEqual(['n1', 'n2']);
    expect(s.gateCalls.every((call) => call.integrationBranch === INT)).toBe(true);
    expect(s.gateCalls.every((call) => call.cwd === s.worktree)).toBe(true);
    // Recorded before the next merge begins, which is what makes the verdict
    // readable in the timeline at the point it was taken.
    expect(events(s.db, 'gate.evaluated')).toHaveLength(2);
    s.close();
  });
});

suite('EPIC-07-S26: merges are --no-ff and name their provenance (AC6)', () => {
  it('leaves one merge commit per node branch, naming the run and the node', async ({ tmp }) => {
    const s = await scene(tmp, {
      edits: [
        { node: 'n1', file: 'a.ts', contents: 'a by n1\n' },
        { node: 'n2', file: 'b.ts', contents: 'b by n2\n' },
        { node: 'n3', file: 'c.ts', contents: 'c by n3\n' },
      ],
    });
    await start(s);
    await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3'));

    const merges = (await git(s.repo, ['log', '--merges', '--format=%s', INT]))
      .split('\n')
      .filter((line) => line !== '');
    expect(merges).toHaveLength(3);
    for (const node of ['n1', 'n2', 'n3']) {
      expect(merges.some((subject) => subject.includes(`node=${node}`))).toBe(true);
    }
    expect(merges.every((subject) => subject.includes(`run=${SHORT_RUN}`))).toBe(true);

    // Every node's change is on the branch — the run's output is this branch.
    const diff = await git(s.repo, ['diff', '--name-only', `main..${INT}`]);
    expect(diff.split('\n').toSorted()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(s.mergeCalls().every((argv) => argv.includes('--no-ff'))).toBe(true);
    s.close();
  });
});

// ── EPIC-07-S27 ─────────────────────────────────────────────────────────────

/** AC8's shape: n1 and n2 own a file each, n3 and n4 contend for one. */
const INDEPENDENT_EDITS: BranchEdit[] = [
  { node: 'n1', file: 'a.ts', contents: 'a by n1\n' },
  { node: 'n2', file: 'b.ts', contents: 'b by n2\n' },
  { node: 'n3', file: 'shared.ts', contents: SHARED.replace('region-a', 'region-a by n3') },
  { node: 'n4', file: 'shared.ts', contents: SHARED.replace('region-a', 'region-a by n4') },
];

suite('EPIC-07-S27: a conflicting merge spawns a narrow resolution node (AC5, AC8)', () => {
  it('merges N-1 branches and spawns exactly one resolution node', async ({ tmp }) => {
    const s = await scene(tmp, { edits: INDEPENDENT_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);

    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));

    expect(outcome.status).toBe('conflict');
    expect(outcome.merged.map((merge) => merge.nodeId)).toEqual(['n1', 'n2', 'n3']);
    expect(events(s.db, 'plan.patch.proposed')).toHaveLength(1);
    s.close();
  });

  it('scopes the resolution node to the integration worktree at worktree permission', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { edits: INDEPENDENT_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);
    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));

    if (outcome.status !== 'conflict') throw new Error('expected a conflict');
    expect(outcome.resolution.node.permission).toBe('worktree');
    expect(outcome.resolution.cwd).toBe(s.worktree);
    expect(outcome.resolution.patch.reason).toContain('shared.ts');
    s.close();
  });

  it('builds a packet of exactly the conflicted hunks and the two intents', async ({ tmp }) => {
    const s = await scene(tmp, { edits: INDEPENDENT_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);
    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));
    if (outcome.status !== 'conflict') throw new Error('expected a conflict');

    const { packet } = outcome.resolution;
    expect([...new Set(packet.segments.map((segment) => segment.kind))].toSorted()).toEqual([
      'fact',
      'tool.output',
    ]);
    const text = packet.segments.map((segment) => segment.text).join('\n');
    // The conflicting node and the already-merged counterpart, and those two
    // only — n1 and n2 merged cleanly and have nothing to say about this hunk.
    expect(text).toContain('n4 rewrote');
    expect(text).toContain('n3 rewrote');
    expect(text).not.toContain('n1 rewrote');
    expect(text).not.toContain('n2 rewrote');
    // The conflicted region, and no line of the file that merged fine.
    expect(text).toContain('region-a by n3');
    expect(text).toContain('region-a by n4');
    expect(text).not.toContain('filler-6');
    s.close();
  });

  it('never hands the resolver the whole repository', async ({ tmp }) => {
    const s = await scene(tmp, { edits: INDEPENDENT_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);
    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));
    if (outcome.status !== 'conflict') throw new Error('expected a conflict');

    const text = outcome.resolution.packet.segments.map((segment) => segment.text).join('\n');
    for (const untouched of ['a.ts', 'b.ts', 'big.ts', 'README.md']) {
      expect(text).not.toContain(untouched);
    }

    // The order-of-magnitude claim, against the same heuristic applied to
    // every tracked file in the repository.
    const tracked = (await git(s.repo, ['ls-files'])).split('\n').filter((path) => path !== '');
    let wholeRepoChars = 0;
    for (const path of tracked)
      wholeRepoChars += (await readFile(join(s.repo, path), 'utf8')).length;
    expect(outcome.resolution.packet.totals.tokens * 10).toBeLessThan(
      Math.ceil(wholeRepoChars / 4),
    );
    s.close();
  });

  it('assembles the same packet every time', async ({ tmp }) => {
    const s = await scene(tmp, { edits: INDEPENDENT_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);
    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));
    if (outcome.status !== 'conflict') throw new Error('expected a conflict');

    expect(
      outcome.resolution.packet.segments.map((segment) => ({
        kind: segment.kind,
        text: segment.text,
      })),
    ).toMatchSnapshot();
    s.close();
  });

  it('produces an integration branch with every node change once the conflict is resolved', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { edits: INDEPENDENT_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);
    const first = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));
    if (first.status !== 'conflict') throw new Error('expected a conflict');

    // The merge git could not finish is still open in the integration
    // worktree — which is exactly why §7.2 puts the resolution node there.
    expect(await git(s.worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).toMatch(
      /^[0-9a-f]{40}$/,
    );

    // The resolution node's own turn, played by the spec: it rewrites only the
    // conflicted file and concludes the merge. `--no-edit` keeps DeFlow's own
    // message, so the resolved merge carries the same provenance as the three
    // that needed no help.
    await writeFile(
      join(s.worktree, 'shared.ts'),
      SHARED.replace('region-a', 'region-a by n3 and n4'),
    );
    await git(s.worktree, ['add', '-A']);
    await git(s.worktree, ['commit', '--no-edit']);

    // AC8: N−1 clean merges, one resolution, and every node's change present.
    const merges = (await git(s.repo, ['log', '--merges', '--format=%s', INT]))
      .split('\n')
      .filter((line) => line !== '');
    expect(merges).toHaveLength(4);
    for (const node of ['n1', 'n2', 'n3', 'n4']) {
      expect(merges.some((subject) => subject.includes(`node=${node}`))).toBe(true);
    }

    const names = (await git(s.repo, ['diff', '--name-only', `main..${INT}`]))
      .split('\n')
      .toSorted();
    expect(names).toEqual(['a.ts', 'b.ts', 'shared.ts']);
    const shared = await git(s.repo, ['show', `${INT}:shared.ts`]);
    expect(shared).toContain('region-a by n3 and n4');
    expect(shared).not.toContain('<<<<<<<');
    s.close();
  });

  it('never resolves a conflict automatically', async ({ tmp }) => {
    const s = await scene(tmp, { edits: INDEPENDENT_EDITS });
    recordIntents(s.db, ['n1', 'n2', 'n3', 'n4']);
    await start(s);
    await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3', 'n4'));

    const forbidden = ['-X', '--strategy=ours', '--strategy=theirs', '-Xours', '-Xtheirs'];
    for (const argv of s.calls) {
      for (const arg of argv) expect(forbidden).not.toContain(arg);
    }
    s.close();
  });
});

// ── EPIC-07-S28 ─────────────────────────────────────────────────────────────

suite('EPIC-07-S28: a gate failure halts the loop with the queue intact (AC4)', () => {
  // n2 and n3 own one region each of `shared.ts`, so a repair to region-a
  // makes exactly one of them expensive — which is what turns the recorded
  // order into the wrong order.
  const EDITS: BranchEdit[] = [
    { node: 'n1', file: 'a.ts', contents: 'a by n1\n' },
    { node: 'n2', file: 'shared.ts', contents: SHARED.replace('region-a', 'region-a by n2') },
    { node: 'n3', file: 'shared.ts', contents: SHARED.replace('region-b', 'region-b by n3') },
  ];

  it('stops after the failing gate rather than continuing to merge', async ({ tmp }) => {
    const s = await scene(tmp, { edits: EDITS, verdicts: ['fail'] });
    await start(s);
    const outcome = await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3'));

    expect(outcome.status).toBe('gate-failed');
    expect(outcome.merged.map((merge) => merge.nodeId)).toEqual(['n1']);
    expect(s.mergeCalls()).toHaveLength(1);
    s.close();
  });

  it('records the verdict with its findings, and the remaining queue', async ({ tmp }) => {
    const s = await scene(tmp, { edits: EDITS, verdicts: ['fail'] });
    await start(s);
    await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n2', 'n3'));

    const evaluated = events(s.db, 'gate.evaluated');
    expect(evaluated).toHaveLength(1);
    expect((evaluated[0] as { verdict: Verdict }).verdict.outcome).toBe('fail');
    expect((evaluated[0] as { verdict: Verdict }).verdict.findings).toHaveLength(1);
    expect(remainingMergeQueue(s.db, RUN)).toEqual(['n2', 'n3']);
    s.close();
  });

  it('re-probes and re-sorts on resume rather than trusting the recorded order', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { edits: EDITS, verdicts: ['fail', 'pass'] });
    recordIntents(s.db, ['n1', 'n2', 'n3']);
    await start(s);
    const run = runOf(s.repo);
    await s.loop.integrate(run, s.candidates('n1', 'n2', 'n3'));
    expect(remainingMergeQueue(s.db, RUN)).toEqual(['n2', 'n3']);

    // The repair the operator makes on the integration branch — and it is
    // exactly what makes the recorded order wrong: n2 now conflicts.
    await writeFile(join(s.worktree, 'shared.ts'), SHARED.replace('region-a', 'region-a repaired'));
    await git(s.worktree, ['commit', '-am', 'repair region-a on the integration branch']);
    // n3 owns region-b and is now the cheap one; n2 owns region-a and is not.

    const before = s.calls.length;
    const resumed = await s.loop.integrate(run, s.candidates('n2', 'n3'));
    const sinceResume = s.calls.slice(before);
    const firstMerge = sinceResume.findIndex((argv) => argv[0] === 'merge');
    const firstProbe = sinceResume.findIndex((argv) => argv[0] === 'merge-tree');

    expect(firstProbe).toBeGreaterThanOrEqual(0);
    expect(firstProbe).toBeLessThan(firstMerge);
    // n3 was second in the recorded queue and is merged first, because the
    // order is recomputed rather than replayed.
    expect(resumed.merged.map((merge) => merge.nodeId)).toEqual(['n3']);
    expect(resumed.status).toBe('conflict');
    s.close();
  });

  it('never pushes the integration branch anywhere (AC7)', async ({ tmp }) => {
    const s = await scene(tmp, { edits: EDITS });
    await start(s);
    await s.loop.integrate(runOf(s.repo), s.candidates('n1', 'n3'));

    expect(s.calls.filter((argv) => argv[0] === 'push')).toEqual([]);
    // And the wrapper refuses it mechanically, so it is not merely unused.
    await expect(s.git.run(['push', 'origin', `${INT}:main`])).rejects.toThrow(/default branch/);
    s.close();
  });
});
