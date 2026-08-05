/**
 * A scripted run whose events are all *valid* — the corpus the checkpoint
 * specs fold (KAR-03.6).
 *
 * `forty-node-run.ts` next door exists to measure volume, and its payloads are
 * deliberately sketchy because nothing folds them. These are the opposite: the
 * checkpoint's core claim is that the cached path and the cold path produce
 * **deeply equal state**, and a corpus the reducer rejects would make that
 * claim vacuously true — two empty states are equal, and the assertion would
 * pass for ever while proving nothing.
 *
 * So every payload here is one `EVENT_SCHEMAS` accepts, and the run touches
 * every part of `RunState` a checkpoint has to carry across a restart: node
 * lifecycle including a failure and its retry, a held and released repo lock,
 * money, a breach, a suspension, a pause, a needs-human trip, an epoch bump
 * and a stale-epoch event that must stay skipped.
 */
import {
  type EventDraft,
  ikey,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';

export const CHECKPOINT_RUN: RunId = RunIdSchema.parse('run_20260805T090000Z_5c1d2e');
export const OTHER_RUN: RunId = RunIdSchema.parse('run_20260805T090001Z_7a3f04');

const PLAN_HASH = `sha256-${'c'.repeat(64)}`;
const BINARY_SHA = 'd'.repeat(64);
const ARTIFACT = `artifact://${'e'.repeat(64)}`;
const START_TS = 1_754_308_293_000;

/** The epoch every event carries until `EPOCH_BUMPS_AT`, and after it. */
export const FIRST_EPOCH = 1;
export const SECOND_EPOCH = 2;

const usage = { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' } as const;

const completedResult = (node: NodeId) => ({
  status: 'completed',
  output: { summary: `${node} done` },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage,
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [ARTIFACT],
});

const failure = (attempt: number, seq: number) => ({
  reason: 'agent.nonzero-exit',
  class: 'transient',
  message: 'the agent exited 1 without producing a result',
  evidence: [ARTIFACT],
  occurredAtEvent: seq,
  attempt,
});

/** Progress events per attempt — cheap, frequent, and never a state change. */
const PROGRESS_PER_ATTEMPT = 6;

/** Every fourth node fails its first attempt before succeeding. */
const retries = (index: number): boolean => index % 4 === 3;

export interface CheckpointRunOptions {
  /** How many nodes the run schedules. */
  readonly nodes?: number;
  /** The run these events belong to. */
  readonly runId?: RunId;
}

/**
 * The run, as drafts in `seq` order.
 *
 * Deterministic in every field: two calls with the same options produce
 * byte-identical drafts, which is what lets a spec seed two ledgers and demand
 * that the two paths agree.
 */
export function checkpointRun(options: CheckpointRunOptions = {}): EventDraft[] {
  const runId = options.runId ?? CHECKPOINT_RUN;
  const nodeCount = options.nodes ?? 12;
  const events: EventDraft[] = [];
  let ts = START_TS;
  let epoch = FIRST_EPOCH;

  const at = (
    written: number,
    kind: string,
    payload: unknown,
    node?: NodeId,
    attempt?: number,
  ): void => {
    ts += 1000;
    const draft: EventDraft = { runId, ts, kind, v: 1, epoch: written, payload };
    events.push(node === undefined ? draft : { ...draft, nodeId: node, attempt });
  };

  const push = (kind: string, payload: unknown, node?: NodeId, attempt?: number): void => {
    at(epoch, kind, payload, node, attempt);
  };

  push('run.started', { planHash: PLAN_HASH });

  for (let index = 0; index < nodeCount; index++) {
    const node = NodeIdSchema.parse(`step-${String(index + 1).padStart(2, '0')}`);
    push('node.scheduled', { node, provider: 'claude-code', permission: 'worktree' }, node, 0);

    // Half way through, a newer daemon takes over: the epoch rises, and then a
    // straggler written by the old one arrives late and must stay skipped —
    // on both the checkpointed path and the cold one.
    if (index === Math.floor(nodeCount / 2)) {
      epoch = SECOND_EPOCH;
      push('node.progress', { node, attempt: 0, phase: 'the new daemon takes over' }, node, 0);
      at(FIRST_EPOCH, 'node.progress', { node, attempt: 0, phase: 'a late frame' }, node, 0);
    }

    const attempts = retries(index) ? [0, 1] : [0];
    for (const attempt of attempts) {
      push('node.lock.acquired', { node, lock: 'repo', key: 'repo' }, node, attempt);
      push(
        'node.started',
        {
          node,
          attempt,
          ikey: ikey(runId, node, attempt, 0),
          binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: BINARY_SHA },
        },
        node,
        attempt,
      );

      for (let step = 0; step < PROGRESS_PER_ATTEMPT; step++) {
        push('node.progress', { node, attempt, phase: 'tool-use' }, node, attempt);
      }

      push(
        'budget.consumed',
        { node, provider: 'claude-code', usage, costUsd: 0.42 },
        node,
        attempt,
      );

      if (attempt === 0 && attempts.length > 1) {
        push(
          'node.failed',
          { node, attempt, failure: failure(attempt, events.length) },
          node,
          attempt,
        );
        push(
          'node.retry.scheduled',
          { node, nextAttempt: attempt + 1, wakeAt: ts + 30_000 },
          node,
          attempt,
        );
        push('node.lock.released', { node, lock: 'repo', key: 'repo' }, node, attempt);
        continue;
      }

      push('node.completed', { node, attempt, result: completedResult(node) }, node, attempt);
      push('node.lock.released', { node, lock: 'repo', key: 'repo' }, node, attempt);
    }
  }

  // The tail: the states a long run ends up parked in, so the checkpoint has
  // to carry more than "everything completed".
  const last = NodeIdSchema.parse(`step-${String(nodeCount).padStart(2, '0')}`);
  push('node.suspended', { node: last, until: { kind: 'human' } }, last, 0);
  push('budget.exceeded', { scope: 'run', dimension: 'cost', limit: 5, actual: 5.2 });
  push('run.paused', { by: 'policy', reason: 'the cost ceiling was reached' });
  push('run.needs_human', { reason: 'budget', detail: 'the run is over its ceiling by $0.20' });

  return events;
}

/** The run above, plus the events that end it. */
export function completedCheckpointRun(options: CheckpointRunOptions = {}): EventDraft[] {
  const events = checkpointRun(options);
  const tail = events.at(-1);
  if (tail === undefined) throw new Error('the fixture produced no events');
  return [
    ...events,
    {
      ...tail,
      ts: tail.ts + 1000,
      kind: 'run.completed',
      payload: { outcome: 'partial', criteriaSatisfied: [] },
    },
  ];
}
