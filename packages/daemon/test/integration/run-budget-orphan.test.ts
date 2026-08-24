/**
 * KAR-23.12 — `run_20260824T143505Z_3a7365`, reproduced through `drive.ts` in
 * four hundred milliseconds.
 *
 * The incident's ledger: `run.aborted { outcome: failed }` at 15:22:33 while a
 * node was working, and that node's own `node.completed` at 15:22:48. No
 * `node.failed` anywhere in the run, every event at epoch 718 — one daemon
 * life, no restart, nothing failed, and the run is recorded as having failed.
 *
 * The bug lives in the **seam** between `executeRun` and `executeOneRun`, which
 * is why this file drives the real driver rather than the loop:
 *
 *   1. `executeRun`'s whole-run deadline expires while the node is in flight
 *      and it throws `the run wedged`.
 *   2. `executeOneRun` catches, logs, and in its `finally` clears `executing`
 *      and sets `settledAtHead` — the in-flight promise is now an orphan
 *      nobody is holding.
 *   3. The orphan keeps appending `node.progress`. The head moves past
 *      `settledAtHead`, so `executeRuns` re-enters — with a **fresh empty**
 *      in-flight set.
 *   4. `decide()` correctly withholds the running node, so `commands.length
 *      === 0 && inflight.size === 0`, and that reads as *"the run is over"*.
 *      `concludeRun` finds a node that is not `completed` and writes
 *      `run.aborted { failed }`.
 *
 * Four nodes survived that and the fifth did not, because it is a race at node
 * boundaries. Here it is not a race: the budget is fifty milliseconds and the
 * node takes four hundred.
 *
 * Nothing is stubbed below `createRunExecution` — the same shipped caller
 * `createLiveRunExecution` builds on — because the claim is about how the
 * driver, the executor and a performer that outlives one dispatch fit together.
 *
 * Verifies: KAR-23.12
 */
import type { Db, NodeId, RunId, StartNode } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema, seededRandom } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger, readRange } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { createRunDriver } from '../../src/drive.ts';
import { createEffectRunner } from '../../src/effects/durable.ts';
import { createRunExecution } from '../../src/pipeline/run-execution.ts';

const RUN: RunId = RunIdSchema.parse('run_20260824T143505Z_3a7365');
const SLOW: NodeId = NodeIdSchema.parse('implement-the-frame');
const NEXT: NodeId = NodeIdSchema.parse('review-the-frame');

const T0 = 1_756_045_505_000;
const EPOCH = 718;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const node = (id: NodeId, deps: readonly NodeId[] = []): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'tool',
  tool: { kind: 'script', run: 'true' },
  effectClass: 'pure',
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 1, backoff: { base: 3_600_000, cap: 7_200_000, jitter: 'full' } },
  budget: {},
});

const PLAN = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-24T14:35:05.000Z',
  nodes: [node(SLOW), node(NEXT, [SLOW])],
  edges: [{ from: SLOW, to: NEXT, kind: 'control' }],
};

function seed(db: Db): void {
  appendEvents(db, [
    {
      runId: RUN,
      ts: T0,
      kind: 'run.created',
      v: 1,
      epoch: EPOCH,
      payload: { spec: taskSpec, cwd: '/home/u/proj', repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: RUN,
      ts: T0,
      kind: 'run.spec.approved',
      v: 1,
      epoch: EPOCH,
      payload: { specHash: SPEC_HASH, by: 'ui' },
    },
    {
      runId: RUN,
      ts: T0,
      kind: 'plan.proposed',
      v: 2,
      epoch: EPOCH,
      payload: { version: 1, planHash: PLAN_HASH, graph: PLAN, by: 'planner' },
    },
  ]);
}

const draft = (
  over: Partial<EventDraft> & Pick<EventDraft, 'kind' | 'v' | 'payload'>,
): EventDraft => ({ runId: RUN, ts: T0, epoch: EPOCH, ...over }) as EventDraft;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const kinds = (db: Db): string[] => readRange(db, RUN, 0, 5_000).events.map((event) => event.kind);

const indexOfKind = (db: Db, kind: string): number => kinds(db).indexOf(kind);

/**
 * The performer the incident had: a node that works for far longer than the
 * dispatch budget, is alive throughout, and says so on the log as it goes.
 *
 * The `node.progress` beat is not decoration. It is step 3 above — the thing
 * that moves the head past `settledAtHead` and invites the loop back in while
 * the node is still working.
 */
function slowPerformer(db: Db, workMs: number): (command: StartNode) => Promise<void> {
  return async (command: StartNode): Promise<void> => {
    appendEvents(db, [
      draft({
        kind: 'node.started',
        v: 2,
        nodeId: command.node,
        attempt: command.attempt,
        payload: {
          node: command.node,
          attempt: command.attempt,
          ikey: `${RUN}/${command.node}/${String(command.attempt)}/0`,
          binary: { path: '/bin/true', version: '0.0.0', sha256: 'f'.repeat(64) },
        },
      }),
    ]);

    for (let elapsed = 0; elapsed < workMs; elapsed += 20) {
      await sleep(20);
      appendEvents(db, [
        draft({
          kind: 'node.progress',
          v: 1,
          nodeId: command.node,
          attempt: command.attempt,
          payload: { node: command.node, attempt: command.attempt, phase: 'tool.working' },
        }),
      ]);
    }

    appendEvents(db, [
      draft({
        kind: 'node.completed',
        v: 1,
        nodeId: command.node,
        attempt: command.attempt,
        payload: {
          node: command.node,
          attempt: command.attempt,
          result: {
            status: 'completed',
            output: { summary: `${command.node} done` },
            outputSchemaId: 'DeFlow.finding.v1',
            usage: { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
            costUsd: 0,
            producedFacts: [],
            artifacts: [],
          },
        },
      }),
    ]);
  };
}

suite('KAR-23.12 — a healthy run is never concluded as failed', () => {
  it('never appends run.aborted over a node that is still working', async ({ tmp }) => {
    const db = openLedger(tmp);
    const threw: string[] = [];
    try {
      seed(db);

      const execution = createRunExecution({
        resolve: ({ db: ledger, epoch, daemonStartedAt }) =>
          Promise.resolve({
            perform: slowPerformer(ledger, 400),
            effects: createEffectRunner({
              db: ledger,
              clock: systemClock,
              daemonStartedAt,
              epoch,
            }),
            random: seededRandom(718),
            tickStepMs: 0,
            tickMs: 5,
            // Eight times shorter than one node: on `master` this is the throw
            // that abandons the promise and invites the conclusion.
            budgetMs: 50,
          }),
      });

      const driver = createRunDriver({
        db,
        clock: systemClock,
        epoch: EPOCH,
        executeNodes: async (input) => {
          try {
            await execution.executeNodes(input);
          } catch (error) {
            // `executeOneRun` swallows this into a log line, which is what made
            // the incident silent. Recorded here so the assertion can name it.
            threw.push(String(error));
            throw error;
          }
        },
      });

      const deadline = Date.now() + 15_000;
      for (;;) {
        await driver.tick(systemClock.now());
        const seen = kinds(db);
        if (seen.includes('run.completed') || seen.includes('run.aborted')) break;
        if (Date.now() > deadline) throw new Error(`the run never ended: ${seen.join(' → ')}`);
        await sleep(5);
      }
      await driver.settle();

      const seen = kinds(db);
      // The incident's own shape, and the assertion the whole story is
      // measured by.
      expect(seen, `the ledger was: ${seen.join(' → ')}`).not.toContain('run.aborted');
      expect(seen).toContain('run.completed');
      expect(seen).not.toContain('node.failed');
      // …and it was appended *after* the node ended, not fifteen seconds before.
      expect(indexOfKind(db, 'node.completed')).toBeLessThan(indexOfKind(db, 'run.completed'));
      // Nothing was abandoned: the dispatch never threw at all.
      expect(threw).toEqual([]);
      // The dependent node ran, which it could not have if the run had been
      // concluded over its dependency.
      expect(seen.filter((kind) => kind === 'node.completed')).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
