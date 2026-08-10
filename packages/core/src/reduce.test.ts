/**
 * KAR-03.5 — the laws the reducer is allowed to have, stated as tests
 * (docs/04-domain-model.md §9.2, docs/05-durable-execution.md §4).
 *
 * Every assertion here is about a *property* rather than a transition: the
 * per-kind transitions are covered by the corpus and fixture specs in
 * ../test/, and the properties are what a later epic is most likely to break
 * while adding a transition.
 *
 * Verifies: EPIC-03-S15 · AC1, AC2, AC3, AC5, AC6, AC7, AC8
 */
import { afterEach, expect, it, describe as suite, vi } from 'vitest';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { NodeIdSchema } from './ids.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const NODE = 'recon-auth-surface';
const SHA = `sha256-${'a'.repeat(64)}`;
const HANDLE = `artifact://${'b'.repeat(64)}`;
const IKEY = `${RUN_ID}/${NODE}/1/0`;
const TS = 1_754_313_093_000;

const completedResult = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [HANDLE],
};

interface EnvelopeOverrides {
  readonly seq?: number;
  readonly epoch?: number;
}

/**
 * Built through `parseEvent` rather than cast, so a spec can never assert
 * against a payload the schema would have refused — the reducer only ever
 * sees parsed, upcast events in production.
 */
function event(kind: EventKind, payload: unknown, overrides: EnvelopeOverrides = {}): Event {
  const result = parseEvent({
    seq: overrides.seq ?? 1,
    runId: RUN_ID,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: overrides.epoch ?? 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

const started = (seq: number, epoch = 1): Event =>
  event('run.started', { planHash: SHA }, { seq, epoch });

const paused = (seq: number, epoch = 1): Event =>
  event('run.paused', { by: 'user', reason: 'stepping away' }, { seq, epoch });

const resumed = (seq: number, epoch = 1): Event =>
  event('run.resumed', { by: 'user' }, { seq, epoch });

const nodeStarted = (seq: number, attempt = 0): Event =>
  event(
    'node.started',
    {
      node: NODE,
      attempt,
      ikey: IKEY,
      binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: 'd'.repeat(64) },
    },
    { seq },
  );

const nodeProgress = (seq: number): Event =>
  event('node.progress', { node: NODE, attempt: 0, phase: 'tool-use' }, { seq });

const nodeCompleted = (seq: number): Event =>
  event('node.completed', { node: NODE, attempt: 0, result: completedResult }, { seq });

const lockAcquired = (seq: number): Event =>
  event('node.lock.acquired', { node: NODE, lock: 'repo', key: 'repo' }, { seq });

const lockReleased = (seq: number): Event =>
  event('node.lock.released', { node: NODE, lock: 'repo', key: 'repo' }, { seq });

const fold = (events: readonly Event[], from: RunState = initialRunState()): RunState =>
  events.reduce(reduce, from);

/** Freezes the whole object graph, so any in-place write throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

suite('AC1 — an unknown kind returns the identical state object', () => {
  it('returns the same reference, and does not throw', () => {
    const state = fold([started(1)]);
    const future = { ...started(2), kind: 'node.sandbox.escalated' } as unknown as Event;

    expect(reduce(state, future)).toBe(state);
  });

  it('does the same for a kind from the future carrying a newer epoch', () => {
    const state = fold([started(1)]);
    const future = { ...started(2), kind: 'run.teleported', epoch: 9 } as unknown as Event;

    // The epoch is envelope-level, but an event this build cannot interpret
    // must not move the projection in *any* respect — including the epoch.
    expect(reduce(state, future)).toBe(state);
  });

  it('is total against garbage that never came from parseEvent', () => {
    const state = initialRunState();
    const rubbish: unknown[] = [{}, { kind: 42 }, { kind: '' }, { kind: 'x', payload: null }];

    for (const value of rubbish) {
      expect(reduce(state, value as Event)).toBe(state);
    }
  });
});

suite('AC2 — determinism and immutability', () => {
  const script = (): Event[] => [
    started(1),
    lockAcquired(2),
    nodeStarted(3),
    nodeProgress(4),
    nodeCompleted(5),
    lockReleased(6),
    paused(7),
  ];

  it('folds the same events twice into deeply-equal state', () => {
    expect(fold(script())).toEqual(fold(script()));
  });

  it('never mutates the state it was handed, even deeply frozen', () => {
    const frozen = deepFreeze(initialRunState());

    const next = fold(script(), frozen);

    expect(next).not.toBe(frozen);
    expect(frozen).toEqual(initialRunState());
  });

  it('never mutates the event it was handed', () => {
    const events = script().map((one) => deepFreeze(structuredClone(one)));
    const before = structuredClone(events);

    fold(events);

    expect(events).toEqual(before);
  });
});

suite('AC3 — no clock, no randomness', () => {
  it('completes a fold with Date.now and Math.random stubbed to throw', () => {
    const boom = (): never => {
      throw new Error('the reducer read a clock or a random number');
    };
    vi.spyOn(Date, 'now').mockImplementation(boom);
    vi.spyOn(Math, 'random').mockImplementation(boom);

    expect(() => fold([started(1), nodeStarted(2), nodeCompleted(3), paused(4)])).not.toThrow();
  });
});

suite('AC5 — pause is an event, never an in-memory flag', () => {
  it('survives a fold from scratch with no resume', () => {
    expect(fold([started(1), paused(50)]).status).toBe('paused');
  });

  it('is reversed by run.resumed', () => {
    expect(fold([started(1), paused(50), resumed(51)]).status).toBe('running');
  });

  it('is idempotent: a second run.paused changes nothing', () => {
    const once = fold([started(1), paused(50)]);

    expect(reduce(once, paused(51))).toBe(once);
  });
});

// ── KAR-06.7 — cancel is an event too, and it remembers which ladder ─────────

const cancelRequested = (seq: number, mode: 'cooperative' | 'forceful'): Event =>
  event('run.cancel.requested', { mode }, { seq });

const nodeCancelled = (seq: number, by: 'user' | 'policy' | 'parent' = 'user'): Event =>
  event('node.cancelled', { node: NODE, attempt: 0, result: { status: 'cancelled', by } }, { seq });

suite('KAR-06.7 — the cancel request is reduced, not merely observed', () => {
  it('moves the run to cancelling and keeps the mode the operator asked for', () => {
    const state = fold([started(1), cancelRequested(9, 'forceful')]);

    expect(state.status).toBe('cancelling');
    // The mode has to survive into the projection or `decide()` cannot tell a
    // cooperative ladder from a forceful one after a restart — which is the
    // whole reason cancellation is an event rather than a call.
    expect(state.cancel).toEqual({ mode: 'forceful', requestedSeq: 9 });
  });

  it('a cooperative request is a different projection, not a different code path', () => {
    expect(fold([started(1), cancelRequested(9, 'cooperative')]).cancel).toEqual({
      mode: 'cooperative',
      requestedSeq: 9,
    });
  });

  it('an escalation to forceful is recorded, and the earlier request is not sticky', () => {
    const state = fold([
      started(1),
      cancelRequested(9, 'cooperative'),
      cancelRequested(12, 'forceful'),
    ]);

    expect(state.cancel).toEqual({ mode: 'forceful', requestedSeq: 12 });
  });

  it('is idempotent: restating the same request changes nothing', () => {
    const once = fold([started(1), cancelRequested(9, 'forceful')]);

    expect(reduce(once, cancelRequested(9, 'forceful'))).toBe(once);
  });
});

suite('KAR-06.7 — node.cancelled is the terminal record of a cancelled attempt', () => {
  it('leaves the node cancelled rather than running, so its lock is reclaimable', () => {
    const state = fold([started(1), nodeStarted(2), lockAcquired(3), nodeCancelled(4)]);

    expect(state.nodes[NODE]?.status).toBe('cancelled');
    expect(state.nodes[NODE]?.wakeAt).toBeNull();
  });

  it('advances the watermark, because a node stopping is a real state change', () => {
    const state = fold([started(1), nodeStarted(2), nodeCancelled(9)]);

    expect(state.watermarkSeq).toBe(9);
  });

  it('cannot un-complete a node that finished before the signal landed', () => {
    // The race the kill switch really has: `decide()` returns a CancelNode, the
    // node completes, and the driver's terminal record arrives afterwards.
    // Overwriting the completion would throw away a result the run paid for and
    // would tell every downstream node its dependency never finished.
    const finished = fold([started(1), nodeStarted(2), nodeCompleted(3)]);

    expect(reduce(finished, nodeCancelled(4))).toBe(finished);
    expect(finished.nodes[NODE]?.status).toBe('completed');
    expect(finished.nodes[NODE]?.result).not.toBeNull();
  });
});

suite('AC6 — node.progress does not advance the progress watermark', () => {
  it('leaves the watermark where node.started put it, across 50 progress events', () => {
    const events = [
      started(1),
      nodeStarted(2),
      ...Array.from({ length: 50 }, (_unused, index) => nodeProgress(3 + index)),
    ];

    const state = fold(events);

    expect(state.watermarkSeq).toBe(2);
  });

  it('advances on the next node.completed', () => {
    const events = [
      started(1),
      nodeStarted(2),
      ...Array.from({ length: 50 }, (_unused, index) => nodeProgress(3 + index)),
      nodeCompleted(53),
    ];

    expect(fold(events).watermarkSeq).toBe(53);
  });

  it('leaves the whole projection untouched for a progress event', () => {
    const state = fold([started(1), nodeStarted(2)]);

    expect(reduce(state, nodeProgress(3))).toBe(state);
  });
});

suite('AC7 — locks live in the ledger', () => {
  it('is still held after a fold from zero, because it is an event and not a Map', () => {
    const state = fold([started(1), lockAcquired(2), nodeStarted(3)]);

    expect(state.locks).toEqual({
      'repo:repo': { lock: 'repo', key: 'repo', node: NODE, sinceSeq: 2 },
    });
  });

  it('is released by node.lock.released', () => {
    expect(fold([started(1), lockAcquired(2), lockReleased(3)]).locks).toEqual({});
  });

  it('releasing a lock nobody holds changes nothing', () => {
    const state = fold([started(1)]);

    expect(reduce(state, lockReleased(2))).toBe(state);
  });
});

suite('AC8 — a stale-epoch event is a no-op with a counter', () => {
  it('applies nothing and increments staleEpochSkipped', () => {
    const state = fold([started(1, 4)]);

    const next = reduce(state, paused(2, 3));

    expect(next.status).toBe('running');
    expect(next.staleEpochSkipped).toBe(1);
  });

  it('does not advance the watermark, because nothing was projected', () => {
    const state = fold([started(1, 4)]);

    expect(reduce(state, paused(2, 3)).watermarkSeq).toBe(state.watermarkSeq);
  });

  it('raises the epoch when a newer daemon writes, and applies that event', () => {
    const state = fold([started(1, 4), paused(2, 7)]);

    expect(state.epoch).toBe(7);
    expect(state.status).toBe('paused');
    expect(state.staleEpochSkipped).toBe(0);
  });
});

suite('the node projection cannot reach an impossible state', () => {
  it('counts attempts from the attempt index, so completed implies at least one attempt', () => {
    // node.started is missing on purpose: an older binary that skipped an
    // unknown kind must still not produce completed-without-having-run.
    const state = fold([started(1), nodeCompleted(2)]);

    expect(state.nodes[NODE]).toMatchObject({ status: 'completed', attempt: 0, attempts: 1 });
  });

  it('keeps attempts monotone across a retry', () => {
    const state = fold([started(1), nodeStarted(2, 0), nodeStarted(3, 1)]);

    expect(state.nodes[NODE]).toMatchObject({ attempt: 1, attempts: 2 });
  });
});

/**
 * KAR-11.4 AC8, AC10 — the two facts about F2.5's rule table that only the
 * projection can hold (docs/06-planning-and-replanning.md §4.3, §7).
 */
suite('KAR-11.4 — the patch policy table is pinned, and drift is remembered', () => {
  const table = [
    { id: 'expensive', when: { costDeltaUsd: '> 5.00' }, decision: 'approve' },
    { id: 'default', decision: 'approve' },
  ];
  const HASH = `sha256-${'d'.repeat(64)}`;
  const DRIFTED = `sha256-${'e'.repeat(64)}`;

  const loaded = (seq: number): Event =>
    event('policy.patch.loaded', { source: 'config', hash: HASH, rules: table }, { seq });

  it('folds the rules themselves, not merely their digest', () => {
    const state = reduce(initialRunState(), loaded(1));
    expect(state.patchPolicy).toEqual({
      hash: HASH,
      source: 'config',
      rules: table,
      drift: null,
    });
  });

  it('records the on-disk digest a drift report named, so it is surfaced once', () => {
    const pinned = reduce(initialRunState(), loaded(1));
    const drifted = reduce(
      pinned,
      event('policy.patch.drifted', { pinnedHash: HASH, configHash: DRIFTED }, { seq: 2 }),
    );

    expect(drifted.patchPolicy?.drift).toBe(DRIFTED);
    // And the rules the run plays by did not move: that is the whole mechanism.
    expect(drifted.patchPolicy?.rules).toEqual(table);
    expect(drifted.patchPolicy?.hash).toBe(HASH);
  });

  it('ignores a drift report for a run that pinned nothing', () => {
    const state = reduce(
      initialRunState(),
      event('policy.patch.drifted', { pinnedHash: HASH, configHash: DRIFTED }, { seq: 1 }),
    );
    expect(state.patchPolicy).toBeNull();
  });
});

suite('KAR-11.4 AC8 — a human patch resets the churn circuit breaker', () => {
  const TO = `sha256-${'f'.repeat(64)}`;

  const churning = (): RunState => ({
    ...initialRunState(),
    status: 'needs-human',
    needsHuman: { reason: 'churn', detail: 'three replans moved nothing', seq: 3 },
    churnWindow: [{ node: NodeIdSchema.parse(NODE), requestHash: SHA, attempt: 1, seq: 4 }],
    replans: { flat: 3, completed: 2, versions: [2, 3, 4] },
  });

  const patched = (proposedBy: string | undefined, seq: number): Event =>
    event(
      'plan.patched',
      {
        version: 5,
        fromHash: SHA,
        toHash: TO,
        patchId: 'patch-9',
        decision: {
          decision: 'auto',
          by: 'policy',
          rule: 'read-only-analysis',
          at: new Date(TS).toISOString(),
        },
        ...(proposedBy === undefined ? {} : { proposedBy }),
      },
      { seq },
    );

  it('clears the ask and the sliding window when the operator supplies the premise', () => {
    const rescued = reduce(churning(), patched('human', 5));

    expect(rescued.needsHuman).toBeNull();
    expect(rescued.churnWindow).toEqual([]);
    expect(rescued.replans).toEqual({ flat: 0, completed: 0, versions: [] });
  });

  it('leaves a planner-authored patch to face the breaker it did not clear', () => {
    const still = reduce(churning(), patched('planner', 5));

    expect(still.needsHuman).toEqual({
      reason: 'churn',
      detail: 'three replans moved nothing',
      seq: 3,
    });
    expect(still.churnWindow).toHaveLength(1);
  });

  it('leaves an escalation that is not churn alone — a human patch is not a resume', () => {
    const paused: RunState = {
      ...initialRunState(),
      status: 'paused',
      needsHuman: { reason: 'budget', detail: 'the run reached its ceiling', seq: 4 },
    };
    expect(reduce(paused, patched('human', 5)).needsHuman).toEqual({
      reason: 'budget',
      detail: 'the run reached its ceiling',
      seq: 4,
    });
  });
});
