/**
 * KAR-12.1 — the short-circuit, composed end to end: a real failing `tsc` in a
 * real worktree, its verdict appended to a real file-backed ledger, that ledger
 * replayed through `reduce`, and the result handed to `decide`.
 *
 * Nothing is hand-assembled between those steps. The `gate.evaluated` payload
 * is the one `runGate` produced, the `seq` is the one SQLite assigned, and the
 * `RunState` is the fold of what `readRange` returned — so "the ladder
 * short-circuits" is asserted against the objects the daemon will actually
 * have, not against a fixture that agrees with the assertion by construction.
 *
 * The assertion that matters is the **cost delta**, not the absence of a log
 * line: no `StartNode` for the review gate is returned, so no attempt exists to
 * spend anything, and `budget.consumed` is byte-identical either side.
 *
 * Verifies: EPIC-12-S2 · AC1, AC2
 */
import type { Event, NodeId, RunId } from '@DeFlow/core';
import { decide, initialRunState, parseEvent, RunIdSchema, reduce } from '@DeFlow/core';
import { appendEvents, openLedger, readRange } from '@DeFlow/ledger';
import { it, makeRepo, repoRoot } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { loadGateDefinition } from '../../src/definition.ts';
import { runGate } from '../../src/run-gate.ts';
import { realClock } from './support/clock.ts';

const RUN: RunId = RunIdSchema.parse('run_20260808T042000Z_7f7f7f');
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const NOW = 1_754_150_000_000;

const TSC = join(repoRoot, 'node_modules', '.bin', 'tsc');

const TYPECHECK_YAML = `id: typecheck
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
satisfies: [ac-1]
severityFloor: error
`;

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
  returns: { schemaId: 'DeFlow.verdict.v2', maxTokens: 600 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  gate:
    kind === 'deterministic'
      ? { kind: 'deterministic', gateId: 'typecheck' }
      : { kind: 'adversarial', brief: 'review the implementation' },
  criteria: ['ac-1'],
  independence: { notSessionOf: ['impl-1'], preferDifferentProvider: true },
});

const PLAN = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-08T04:20:00.000Z',
  // Adversarial first, so a ladder derived from array position would be wrong.
  nodes: [gateNode('gate-review', 'adversarial'), gateNode('gate-typecheck', 'deterministic')],
  edges: [],
};

const draft = (kind: string, v: number, payload: unknown) => ({
  runId: RUN,
  ts: NOW,
  kind,
  v,
  epoch: 1,
  payload,
});

/** The ledger, replayed exactly as the daemon replays it. */
function foldLedger(events: readonly { seq: number; kind: string; v: number; payload: unknown }[]) {
  let state = initialRunState();
  for (const stored of events) {
    const parsed = parseEvent({ ...stored, runId: RUN, ts: NOW, epoch: 1 });
    if (parsed.status !== 'ok') throw new Error(`ledger row ${stored.seq} did not parse`);
    state = reduce(state, parsed.event as Event);
  }
  return state;
}

const startsOf = (state: ReturnType<typeof foldLedger>) =>
  decide(state, NOW)
    .filter((command) => command.kind === 'StartNode')
    .map((command) => (command as { node: string }).node);

suite('a red typecheck never buys a review (S2)', () => {
  it('schedules no review attempt, and leaves the run cost byte-identical', async ({ tmp }) => {
    const worktree = join(tmp, 'worktree');
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    await makeRepo({ dir: worktree });
    await mkdir(join(worktree, 'src'), { recursive: true });
    // A real type error, not a scripted exit code.
    await writeFile(join(worktree, 'src', 'app.ts'), 'export const n: number = "not a number";\n');
    await writeFile(
      join(worktree, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'es2024', module: 'nodenext', strict: true, noEmit: true },
        include: ['src'],
      }),
    );

    const db = openLedger(dataDir);
    try {
      appendEvents(db, [
        draft('run.spec.approved', 1, { specHash: SPEC_HASH, by: 'ui' }),
        draft('plan.proposed', 1, {
          version: 1,
          planHash: PLAN_HASH,
          graph: PLAN,
          by: 'planner',
        }),
        draft('run.started', 1, { planHash: PLAN_HASH }),
      ]);

      const before = foldLedger(readRange(db, RUN, 0, 100).events as never);
      // The ladder admits the deterministic gate first, from a plan that
      // lists the adversarial one first.
      expect(startsOf(before)).toEqual(['gate-typecheck']);
      const costBefore = JSON.stringify(before.budget);

      const result = await runGate({
        definition: loadGateDefinition('.DeFlow/gates/typecheck.yaml', TYPECHECK_YAML),
        worktree,
        repoRoot: worktree,
        node: 'gate-typecheck' as NodeId,
        evaluatedNode: 'impl-1' as NodeId,
        specHash: SPEC_HASH,
        dataDir,
        clock: realClock,
        scrubbedEnv: [],
      });
      expect(result.outcome).toBe('fail');
      expect(result.findings.length).toBeGreaterThan(0);

      appendEvents(
        db,
        [
          draft('gate.evaluated', 2, {
            gate: result.gate,
            node: 'impl-1',
            verdict: result.verdict,
          }),
        ],
        { spillTo: dataDir },
      );

      const after = foldLedger(readRange(db, RUN, 0, 100).events as never);

      // AC2: no command for the review gate, from either tier.
      expect(startsOf(after)).toEqual([]);
      // …and the cost is untouched, which is the assertion the scenario names.
      expect(JSON.stringify(after.budget)).toBe(costBefore);
      expect(after.gateVerdicts['gate-typecheck']?.outcome).toBe('fail');
    } finally {
      db.close();
    }
  }, 60_000);
});
