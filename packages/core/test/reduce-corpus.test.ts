/**
 * KAR-03.5 — totality, stated over the whole corpus rather than one kind at a
 * time (EPIC-03-S15, scenario "totality").
 *
 * `reduce` returns a value for every input. That is easy to hold for the six
 * kinds a story happens to test and easy to lose for the thirty-five it does
 * not, so this suite folds *one event of every registered kind* — the same
 * payload corpus ../test/event-payload-fixtures.test.ts proves the schemas
 * accept — against five representative states, plus three kinds this build has
 * never heard of, plus an envelope with every optional field absent.
 *
 * The states are deeply frozen, so "did not throw" also means "did not mutate".
 *
 * Verifies: EPIC-03-S15 (totality), EPIC-03-S16 (projection is degraded, not
 * corrupted) · AC1, AC2, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventKind } from '../src/event-payloads.ts';
import { EVENT_KINDS, EVENT_SCHEMAS } from '../src/event-payloads.ts';
import type { Event } from '../src/events.ts';
import { parseEvent } from '../src/events.ts';
import { reduce } from '../src/reduce.ts';
import { initialRunState, NODE_STATUSES, RUN_STATUSES, type RunState } from '../src/run-state.ts';
import { NODE, PAYLOADS, RUN_ID, SHA } from './support/event-payloads.fixture.ts';

const TS = 1_754_313_093_000;

function event(kind: EventKind, seq = 1): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload: PAYLOADS[kind],
  });
  if (result.status !== 'ok') {
    throw new Error(`corpus fixture for ${kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

const fold = (events: readonly Event[]): RunState => events.reduce(reduce, initialRunState());

/**
 * Five states a run really passes through, so a transition is exercised
 * against something other than `{}`: nothing yet, mid-flight with a node
 * running and a lock held, paused, waiting on a human, and finished.
 */
const REPRESENTATIVE: Readonly<Record<string, RunState>> = {
  initial: initialRunState(),
  running: fold([event('run.created'), event('run.started', 2), event('node.started', 3)]),
  locked: fold([event('run.started'), event('node.lock.acquired', 2), event('node.started', 3)]),
  paused: fold([event('run.started'), event('run.paused', 2)]),
  needsHuman: fold([event('run.started'), event('run.needs_human', 2)]),
  completed: fold([event('run.started'), event('run.completed', 2)]),
};

/** The invariants every returned value owes, whatever it was folded from. */
function expectRunState(value: unknown): asserts value is RunState {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  const state = value as RunState;
  expect(RUN_STATUSES).toContain(state.status);
  expect(Number.isInteger(state.watermarkSeq)).toBe(true);
  expect(state.watermarkSeq).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(state.epoch)).toBe(true);
  expect(state.staleEpochSkipped).toBeGreaterThanOrEqual(0);
  for (const node of Object.values(state.nodes)) {
    expect(NODE_STATUSES).toContain(node.status);
    // A node cannot have finished without having run: `attempts` is derived
    // from the attempt index, never counted, so a ledger whose `node.started`
    // was skipped by an older binary still cannot produce one.
    if (node.status === 'completed' || node.status === 'failed') {
      expect(node.attempts).toBeGreaterThanOrEqual(1);
    }
    expect(node.attempts).toBeGreaterThanOrEqual(node.attempt);
  }
  for (const [key, lock] of Object.entries(state.locks)) {
    expect(key).toBe(`${lock.lock}:${lock.key}`);
    expect(lock.sinceSeq).toBeGreaterThan(0);
  }
}

suite('reduce is total over every registered kind', () => {
  for (const [name, base] of Object.entries(REPRESENTATIVE)) {
    const frozen = deepFreeze(structuredClone(base));

    for (const kind of EVENT_KINDS) {
      it(`${kind} against the ${name} state returns a RunState`, () => {
        const next = reduce(frozen, event(kind, 500));

        expectRunState(next);
      });
    }
  }

  it('covers every kind in the §9 table, so a new kind joins this suite by existing', () => {
    expect(EVENT_KINDS.length).toBeGreaterThan(40);
    expect(Object.keys(PAYLOADS).toSorted()).toEqual([...EVENT_KINDS].toSorted());
  });
});

suite('reduce is total over kinds this build has never heard of', () => {
  const FUTURE = ['node.sandbox.escalated', 'run.teleported', 'plan.mind.changed'];

  for (const kind of FUTURE) {
    for (const [name, base] of Object.entries(REPRESENTATIVE)) {
      it(`${kind} against the ${name} state returns the identical object`, () => {
        const frozen = deepFreeze(structuredClone(base));

        // Deliberately not built through parseEvent: an unknown kind never
        // survives it, which is the point — this is the shape the fold sees.
        const next = reduce(frozen, {
          seq: 900,
          runId: RUN_ID,
          ts: TS,
          kind,
          v: 1,
          epoch: 1,
          payload: { anything: true },
        } as unknown as Event);

        expect(next).toBe(frozen);
      });
    }
  }
});

suite('reduce is total over an envelope carrying no optional field', () => {
  it('applies an event with nodeId, attempt and ikey all absent', () => {
    const parsed = parseEvent({
      seq: 7,
      runId: RUN_ID,
      ts: TS,
      kind: 'run.started',
      v: 1,
      epoch: 1,
      payload: { planHash: SHA },
    });
    if (parsed.status !== 'ok') throw new Error('unreachable');

    const next = reduce(deepFreeze(initialRunState()), parsed.event);

    expectRunState(next);
    expect(next.status).toBe('running');
    expect(next.watermarkSeq).toBe(7);
  });

  it('does not invent a node from an envelope that names none', () => {
    const next = reduce(initialRunState(), event('run.stalled'));

    expect(Object.keys(next.nodes)).toEqual([]);
  });
});

suite('the corpus leaves a projection that is degraded, never impossible', () => {
  it('folds one of every kind, in table order, without an impossible node', () => {
    const state = EVENT_KINDS.reduce(
      (accumulator, kind, index) => reduce(accumulator, event(kind, index + 1)),
      initialRunState(),
    );

    expectRunState(state);
    expect(state.runId).toBe(RUN_ID);
    expect(Object.keys(state.nodes)).toContain(NODE);
  });
});
