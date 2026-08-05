/**
 * A scripted 40-node multi-hour run, as control-plane events plus the data
 * plane it would really have produced.
 *
 * The architecture's decision not to build snapshotting rests on one number —
 * "a 40-node multi-hour run produces on the order of 2,000 control-plane
 * events" (docs/05-durable-execution.md §5.1). This fixture is that sentence
 * written down as data so it can be measured instead of assumed, and so the
 * day someone starts emitting an event per tool call, the count moves and a
 * test says so.
 *
 * Per node it emits the events a node really goes through — scheduled, lock,
 * started, context, a run of progress reports, an effect pair, completion,
 * lock release, budget — and every fourth node fails once and is retried, so
 * the shape is not uniformly optimistic.
 */
import { type NodeId, NodeIdSchema, type RunId } from '@DeFlow/core';
import type { EventDraft, IoChunkDraft } from '../../../src/index.ts';

export const NODE_COUNT = 40;

/** Progress reports per node attempt — one every few minutes of a long step. */
const PROGRESS_PER_ATTEMPT = 24;

/** Agent output frames per node attempt, at 4 KiB each. */
const FRAMES_PER_ATTEMPT = 120;

const FRAME = new TextEncoder().encode('o'.repeat(4096));

const START_TS = 1_754_308_293_000;

export interface FortyNodeRun {
  readonly events: readonly EventDraft[];
  readonly chunks: readonly IoChunkDraft[];
}

/** Every fourth node fails its first attempt and succeeds on the second. */
const attemptsFor = (index: number): number => (index % 4 === 3 ? 2 : 1);

export function fortyNodeRun(runId: RunId): FortyNodeRun {
  const events: EventDraft[] = [];
  const chunks: IoChunkDraft[] = [];
  let ts = START_TS;

  const event = (
    kind: string,
    payload: Record<string, unknown>,
    node?: NodeId,
    attempt?: number,
  ): void => {
    ts += 1000;
    const drafted: EventDraft = { runId, ts, kind, v: 1, epoch: 1, payload };
    events.push(node === undefined ? drafted : { ...drafted, nodeId: node, attempt });
  };

  event('run.created', { title: 'migrate the app to Vue 3' });
  event('run.spec.approved', { by: 'human' });
  event('plan.proposed', { nodes: NODE_COUNT });
  event('run.started', { at: ts });

  for (let index = 0; index < NODE_COUNT; index++) {
    const node = NodeIdSchema.parse(`n${index + 1}`);
    event('node.scheduled', { node }, node, 1);

    for (let attempt = 1; attempt <= attemptsFor(index); attempt++) {
      event('node.lock.acquired', { node, lock: 'repo_write', key: 'repo' }, node, attempt);
      event('context.built', { node, segments: 6 }, node, attempt);
      event('node.started', { node, attempt }, node, attempt);
      event('effect.started', { node, attempt, kind: 'agent_run' }, node, attempt);

      for (let frame = 0; frame < FRAMES_PER_ATTEMPT; frame++) {
        chunks.push({
          runId,
          nodeId: node,
          attempt,
          stream: frame % 20 === 19 ? 'agent_json' : 'stdout',
          ts: ts + frame,
          data: FRAME,
        });
      }

      for (let step = 0; step < PROGRESS_PER_ATTEMPT; step++) {
        event('node.progress', { node, attempt, phase: 'working' }, node, attempt);
      }

      event('effect.completed', { node, attempt, kind: 'agent_run' }, node, attempt);
      event('budget.consumed', { node, attempt, usd: 0.12 }, node, attempt);
      event('node.lock.released', { node, lock: 'repo_write', key: 'repo' }, node, attempt);

      if (attempt < attemptsFor(index)) {
        event('node.failed', { node, attempt }, node, attempt);
        event('node.retry.scheduled', { node, nextAttempt: attempt + 1 }, node, attempt);
        continue;
      }
      event('fact.written', { node, key: 'artifact' }, node, attempt);
      event('node.completed', { node, attempt }, node, attempt);
      event('gate.evaluated', { node, verdict: 'pass' }, node, attempt);
    }
  }

  event('run.completed', { at: ts, outcome: 'succeeded' });
  return { events, chunks };
}
