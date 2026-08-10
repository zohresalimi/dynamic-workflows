/**
 * KAR-12.1 AC1, AC2 — the ladder, driven by the daemon's own run executor.
 *
 * The short-circuit has an integration spec in `@DeFlow/gates` that calls
 * `runGate` and `decide` by hand. This one asserts the property that spec
 * cannot: that the **executor** — the loop DeFlowd runs, performing gate nodes
 * through `runGateNode` — never puts the review gate in flight once the
 * deterministic gate has failed. The difference matters because "the ladder is
 * advisory" is precisely a bug in the thing that performs commands, not in the
 * thing that returns them.
 *
 * Real repository, real `tsc`, real file-backed ledger, real child processes.
 * The review gate is given a command that would **create a file if it ever
 * ran**, so "never scheduled" is asked of the filesystem rather than inferred
 * from the absence of a log line.
 *
 * Verifies: EPIC-12-S2 · AC1, AC2
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, PlanGraphSchema, RunIdSchema, seededRandom } from '@DeFlow/core';
import { loadGateDefinition } from '@DeFlow/gates';
import { appendEvents, openLedger, readRange } from '@DeFlow/ledger';
import { it, makeRepo, repoRoot } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { createEffectRunner } from '../../src/effects/durable.ts';
import { executeRun } from '../../src/exec/run-executor.ts';
import { gateNodePerformer } from '../../src/gates/gate-performer.ts';

const RUN: RunId = RunIdSchema.parse('run_20260809T111500Z_9a2c4f');
const TYPECHECK: NodeId = NodeIdSchema.parse('gate-typecheck');
const REVIEW: NodeId = NodeIdSchema.parse('gate-review');
const PRODUCER: NodeId = NodeIdSchema.parse('impl-1');
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const NOW = 1_754_320_000_000;
const EPOCH = 5;

const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

const gateNode = (id: string, kind: 'deterministic' | 'adversarial') => ({
  id,
  title: `gate ${id}`,
  type: 'gate',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.verdict.v3', maxTokens: 600 },
  retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  gate:
    kind === 'deterministic'
      ? { kind: 'deterministic', gateId: 'typecheck' }
      : { kind: 'adversarial', brief: 'review the implementation' },
  criteria: ['ac-1'],
  independence: { notSessionOf: ['impl-1'], preferDifferentProvider: true },
});

const yamlFor = (id: string, command: string, parser: string) => `id: ${id}
kind: deterministic
title: gate ${id}
run: ${command}
cwd: worktree
timeout: 120s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: ${parser}
satisfies: [ac-1]
severityFloor: error
`;

suite('a red typecheck never buys a review, in the executor (S2)', () => {
  it('never starts the review gate and leaves the run cost at zero', async ({ tmp }) => {
    const worktree = join(tmp, 'worktree');
    const dataDir = join(tmp, 'data');
    const reviewMarker = join(tmp, 'review-ran');
    await mkdir(dataDir, { recursive: true });
    await makeRepo({ dir: worktree });
    await mkdir(join(worktree, 'src'), { recursive: true });
    await writeFile(join(worktree, 'src', 'app.ts'), 'export const n: number = "nope";\n');
    await writeFile(
      join(worktree, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'es2024', module: 'nodenext', strict: true, noEmit: true },
        include: ['src'],
      }),
    );

    const plan = PlanGraphSchema.parse({
      schemaId: 'DeFlow.plangraph.v1',
      runId: RUN,
      version: 1,
      planHash: PLAN_HASH,
      parent: null,
      taskSpecHash: SPEC_HASH,
      createdBy: 'planner',
      createdAt: '2026-08-09T11:15:00.000Z',
      // Adversarial first, so a ladder derived from array position would be
      // wrong rather than accidentally right.
      nodes: [gateNode('gate-review', 'adversarial'), gateNode('gate-typecheck', 'deterministic')],
      edges: [],
    });

    const db = openLedger(dataDir);
    // The real clock, deliberately. A gate's `timeout` is measured on the
    // injected `Clock`, and this run has a real `tsc` child in flight: a
    // `TestClock` the executor advanced a simulated second per tick would reach
    // the 120-second budget in 120 ticks while the compiler was still working,
    // and the verdict would be `needs-human: gate-timeout` — a timeout that
    // happened in simulated time only.
    const clock = systemClock;
    try {
      appendEvents(db, [
        {
          runId: RUN,
          ts: NOW,
          kind: 'run.spec.approved',
          v: 1,
          epoch: EPOCH,
          payload: { specHash: SPEC_HASH, by: 'ui' },
        },
        {
          runId: RUN,
          ts: NOW,
          kind: 'plan.proposed',
          v: 2,
          epoch: EPOCH,
          payload: { version: 1, planHash: PLAN_HASH, graph: plan, by: 'planner' },
        },
        {
          runId: RUN,
          ts: NOW,
          kind: 'run.started',
          v: 1,
          epoch: EPOCH,
          payload: { planHash: PLAN_HASH },
        },
      ]);

      const definitions = {
        [TYPECHECK]: loadGateDefinition(
          '.DeFlow/gates/typecheck.yaml',
          yamlFor('typecheck', `${TSC} -p tsconfig.json --noEmit --pretty false`, 'tsc'),
        ),
        [REVIEW]: loadGateDefinition(
          '.DeFlow/gates/review.yaml',
          yamlFor('review', `/usr/bin/touch ${reviewMarker}`, 'none'),
        ),
      } as const;

      await executeRun({
        db,
        runId: RUN,
        clock,
        epoch: EPOCH,
        daemonStartedAt: NOW,
        random: seededRandom(7),
        // Nothing to advance: the clock is the real one.
        tickStepMs: 0,
        tickMs: 20,
        sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
        effects: createEffectRunner({ db, clock, daemonStartedAt: NOW, epoch: EPOCH }),
        perform: gateNodePerformer({
          dataDir,
          scrubbedEnv: [],
          resolve: (node) => {
            const definition = definitions[node as keyof typeof definitions];
            if (definition === undefined) return null;
            return {
              definition,
              worktree,
              repoRoot: worktree,
              evaluatedNode: PRODUCER,
              specHash: SPEC_HASH,
            };
          },
        }),
      });

      const events = readRange(db, RUN, 0, 500).events;
      const nodeIdOf = (event: { nodeId?: string | null }) => event.nodeId ?? null;

      // The deterministic gate ran and said no.
      const verdicts = events.filter((event) => event.kind === 'gate.evaluated');
      expect(verdicts).toHaveLength(1);
      const verdict = (verdicts[0]?.payload as { verdict: { outcome: string; summary: string } })
        .verdict;
      expect(verdict.outcome, `verdict summary: ${verdict.summary}`).toBe('fail');

      // The review gate was never admitted, never started, and never ran.
      for (const kind of ['node.scheduled', 'node.started', 'node.completed']) {
        expect(events.filter((event) => event.kind === kind).map(nodeIdOf)).not.toContain(REVIEW);
      }
      expect(existsSync(reviewMarker)).toBe(false);

      // The zero-delta assertion, as a fact rather than an absence: nothing
      // reported spend, because nothing that costs anything was admitted.
      expect(events.filter((event) => event.kind === 'budget.consumed')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
