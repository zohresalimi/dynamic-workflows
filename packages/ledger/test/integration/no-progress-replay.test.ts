/**
 * KAR-06.8 — F4.7's detectors against a **real, file-backed ledger**
 * (docs/05-durable-execution.md §11).
 *
 * The unit specs in `packages/core/src/no-progress.test.ts` fold a scripted
 * ledger in memory. This one exists for the part they cannot reach: the churn
 * window, the replan streak and the watermark's instant are now *reduced state*,
 * so they travel through `run.state_json` — encoded by `canonicalJson`, decoded
 * by `RunStateSchema`, and only then handed to `decide()`. A field the reducer
 * maintains perfectly and the checkpoint drops is a breaker that works until the
 * first restart and never afterwards, which is precisely the failure mode a
 * pure-function test is blind to.
 *
 * So the assertions here are all of the form "the cached path and the cold path
 * reach the same verdict". `interval: 20` makes the cache real over a
 * sixty-event run rather than waiting for the shipped 500.
 *
 * Verifies: EPIC-06-S27 · AC5, AC7, AC8
 */
import {
  CHURN_WINDOW,
  DEFAULT_NO_PROGRESS_POLICY,
  decide,
  EVENT_SCHEMAS,
  type EventKind,
  foldEvents,
  initialRunState,
  type RunId,
  RunIdSchema,
  type RunState,
} from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  drainEvents,
  type EventDraft,
  openLedger,
  RunCheckpointer,
  replayRun,
} from '../../src/index.ts';

const RUN_ID: RunId = RunIdSchema.parse('run_20260805T090002Z_1b7c9d');
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const BINARY_SHA = 'd'.repeat(64);
const ARTIFACT = `artifact://${'e'.repeat(64)}`;
const START_TS = 1_754_308_293_000;

/** The node the scripted planner keeps sending back to do the same job. */
const REPAIR = 'repair-auth';
/** The one request hash it keeps asking for — the livelock, in one constant. */
const SAME_REQUEST = `sha256-${'9f2a1c'.padEnd(64, '0')}`;
/** A node that is ready to start, so "no further StartNode" is a real claim. */
const NEXT = 'next';

/** Checkpointing on: an environment that simply does not mention the flag. */
const ENABLED: Record<string, string | undefined> = {};

function agentNode(id: string, maxAttempts: number): Record<string, unknown> {
  return {
    id,
    title: `do ${id}`,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
    retry: { maxAttempts, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    brief: `brief for ${id}`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'always-replay',
  };
}

const PLAN = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN_ID,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-05T09:00:00.000Z',
  nodes: [agentNode(REPAIR, 100), agentNode(NEXT, 3)],
  edges: [],
};

let stamp = START_TS;

function draft(kind: EventKind, payload: unknown, node?: string, attempt?: number): EventDraft {
  stamp += 1000;
  return {
    runId: RUN_ID,
    ts: stamp,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    ...(node === undefined ? {} : { nodeId: node }),
    ...(attempt === undefined ? {} : { attempt }),
    payload,
  } as EventDraft;
}

/** One completed attempt as the ledger really writes it: start, the effect that
 * names what was asked for, then the completion that closes it. */
function attempt(node: string, index: number, requestHash: string): EventDraft[] {
  const key = `${RUN_ID}/${node}/${index}/0`;
  return [
    draft(
      'node.started',
      {
        node,
        attempt: index,
        ikey: key,
        binary: { path: '/usr/bin/DeFlow-mock-agent', version: '1.0.0', sha256: BINARY_SHA },
      },
      node,
      index,
    ),
    draft('effect.started', { ikey: key, kind: 'agent', requestHash }, node, index),
    draft(
      'node.completed',
      {
        node,
        attempt: index,
        result: {
          status: 'completed',
          output: { summary: `${node} done` },
          outputSchemaId: 'DeFlow.artifact.v1',
          usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
          costUsd: 0.42,
          producedFacts: [],
          artifacts: [ARTIFACT],
        },
      },
      node,
      index,
    ),
  ];
}

/**
 * A run that redoes `REPAIR` with identical inputs `repeats` times, padded with
 * enough unrelated completions to fill the twenty-attempt window.
 */
function churningRun(repeats: number): EventDraft[] {
  stamp = START_TS;
  const filler = Array.from({ length: CHURN_WINDOW - repeats }, (_unused, index) =>
    attempt(`filler-${index}`, 0, `sha256-${`f${index}`.padEnd(64, '0')}`),
  ).flat();
  const churn = Array.from({ length: repeats }, (_unused, index) =>
    attempt(REPAIR, index, SAME_REQUEST),
  ).flat();

  return [
    draft('run.created', { cwd: '/home/u/proj', taskSpecHash: SPEC_HASH, by: 'cli' }),
    // KAR-10.3 AC3 — F1.3's gate. `decide()` admits nothing until the ledger
    // carries an approval, so a fixture for an executing run has to carry one.
    draft('run.spec.approved', { specHash: SPEC_HASH, by: 'ui' }),
    draft('plan.proposed', { version: 1, planHash: PLAN_HASH, graph: PLAN, by: 'planner' }),
    draft('run.started', { planHash: PLAN_HASH }),
    ...filler,
    ...churn,
  ];
}

/** The caps raised out of the way, so what trips is the *detector*. */
const detectorsOnly = (state: RunState): RunState => ({
  ...state,
  policy: {
    ...state.policy,
    noProgress: {
      ...DEFAULT_NO_PROGRESS_POLICY,
      maxAttemptsPerNode: 1000,
      maxTotalNodeExecutions: 10_000,
    },
  },
});

const needsHuman = (state: RunState, now: number): { reason: string; detail: string } | null => {
  for (const command of decide(state, now)) {
    if (command.kind === 'EmitEvent' && command.event.kind === 'run.needs_human') {
      return command.event.payload;
    }
  }
  return null;
};

const starts = (state: RunState, now: number): string[] =>
  decide(state, now)
    .filter((command) => command.kind === 'StartNode')
    .map((command) => command.node);

/** Seeds a ledger and hands back both the cached and the cold projection. */
function seeded(tmp: string, drafts: readonly EventDraft[]) {
  const db = openLedger(tmp);
  try {
    const checkpointer = new RunCheckpointer(db, RUN_ID, { env: ENABLED, interval: 20 });
    for (let index = 0; index < drafts.length; index += 10) {
      checkpointer.append(drafts.slice(index, index + 10));
    }

    const replayed = replayRun(db, RUN_ID, { env: ENABLED });
    const cold = foldEvents(drainEvents(db, RUN_ID), initialRunState()).state;
    return { replayed, cold, writes: checkpointer.writes };
  } finally {
    db.close();
  }
}

suite('the churn window survives the checkpoint it is stored in (AC5)', () => {
  it('reaches the same twenty-entry window through the cache and from cold', ({ tmp }) => {
    const { replayed, cold, writes } = seeded(tmp, churningRun(6));

    // The cache really was used, so the round trip through `run.state_json` is
    // what produced the state below rather than a cold fold in disguise.
    expect(writes).toBeGreaterThan(0);
    expect(replayed.source).toBe('checkpoint');
    expect(replayed.state.churnWindow).toHaveLength(CHURN_WINDOW);
    expect(replayed.state).toEqual(cold);

    const repeated = replayed.state.churnWindow.filter((entry) => entry.node === REPAIR);
    expect(repeated).toHaveLength(6);
    expect(repeated.every((entry) => entry.requestHash === SAME_REQUEST)).toBe(true);
  });

  it('halts a run that redid the same request six times, and lets five pass', ({ tmp }) => {
    const five = join(tmp, 'five');
    mkdirSync(five, { recursive: true });

    const tripped = detectorsOnly(seeded(tmp, churningRun(6)).replayed.state);
    const healthy = detectorsOnly(seeded(five, churningRun(5)).replayed.state);

    expect(needsHuman(healthy, stamp)?.reason).toBeUndefined();
    expect(starts(healthy, stamp)).toEqual([NEXT]);

    const ask = needsHuman(tripped, stamp);
    expect(ask?.reason).toBe('churn');
    expect(ask?.detail).toContain(REPAIR);
    expect(starts(tripped, stamp)).toEqual([]);
  });

  it('falls back to maxAttemptsPerNode when the detectors are switched off (AC8)', ({ tmp }) => {
    const replayed = seeded(tmp, churningRun(6)).replayed.state;
    const capped: RunState = {
      ...replayed,
      policy: {
        ...replayed.policy,
        noProgress: { ...DEFAULT_NO_PROGRESS_POLICY, detectors: false },
      },
    };

    const ask = needsHuman(capped, stamp);
    expect(ask?.detail).toContain('maxAttemptsPerNode');
    expect(starts(capped, stamp)).toEqual([]);
  });
});
