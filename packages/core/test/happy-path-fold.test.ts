/**
 * KAR-03.5 — determinism at the size the architecture actually claims
 * (EPIC-03-S15, scenarios "determinism", "the input state is never mutated"
 * and "no clock is read").
 *
 * A six-event fold proves the transitions; this proves the *fold*. 2,000
 * events is the number docs/05-durable-execution.md §5.1 rests the
 * "no snapshotting needed" decision on, and it is large enough that an
 * accidental mutation, an accidental `Date.now()` or an accidental
 * order-dependence has somewhere to hide.
 *
 * This is the one KAR-03.5 spec that touches the filesystem, and only to read
 * a fixture: no database, no clock, no spawn.
 *
 * Verifies: EPIC-03-S15 · AC2, AC3
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, describe as suite, vi } from 'vitest';
import type { Event } from '../src/events.ts';
import { parseEvent } from '../src/events.ts';
import { foldEvents } from '../src/fold-events.ts';
import { reduce } from '../src/reduce.ts';
import { initialRunState, type RunState } from '../src/run-state.ts';
import {
  EVENT_COUNT,
  type FixtureEvent,
  happyPathEvents,
  NODE_COUNT,
  nodeIdOf,
  RUN_ID,
  renderFixture,
} from './support/happy-path-run.ts';

const fixturePath = fileURLToPath(
  new URL('./fixtures/runs/happy-path.events.json', import.meta.url),
);
const fixtureText = readFileSync(fixturePath, 'utf8');
const rows: FixtureEvent[] = JSON.parse(fixtureText);

/** Parsed once: every spec below folds the same events, as the daemon would. */
const events: Event[] = rows.map((row) => {
  const result = parseEvent(row);
  if (result.status !== 'ok') {
    throw new Error(`fixture event ${row.seq} is not readable: ${JSON.stringify(result)}`);
  }
  return result.event;
});

const fold = (from: RunState = initialRunState()): RunState => events.reduce(reduce, from);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

suite('the committed fixture is the run the scenario describes', () => {
  it('holds exactly 2,000 events for one 40-node run', () => {
    expect(rows).toHaveLength(EVENT_COUNT);
    expect(new Set(rows.map((row) => row.runId))).toEqual(new Set([RUN_ID]));
  });

  it('is numbered 1..2000 with no gap, so seq order and array order agree', () => {
    expect(rows.map((row) => row.seq)).toEqual(
      Array.from({ length: EVENT_COUNT }, (_unused, index) => index + 1),
    );
  });

  it('is exactly what the builder produces, so it can be regenerated', () => {
    expect(fixtureText).toBe(renderFixture(happyPathEvents()));
  });

  it('is readable end to end — every event parses at the current version', () => {
    expect(events).toHaveLength(EVENT_COUNT);
  });
});

suite('folding 2,000 events is deterministic', () => {
  it('produces deeply-equal state when folded twice from the same initial state', () => {
    expect(fold()).toEqual(fold());
  });

  it('does not depend on the identity of the initial state object', () => {
    expect(fold(initialRunState())).toEqual(fold(initialRunState()));
  });

  it('never mutates a deeply frozen initial state', () => {
    const frozen = deepFreeze(initialRunState());

    const next = fold(frozen);

    expect(next).not.toBe(frozen);
    expect(frozen).toEqual(initialRunState());
  });

  it('never mutates the events it folded', () => {
    const before = structuredClone(events);

    fold();

    expect(events).toEqual(before);
  });
});

suite('folding 2,000 events reads no clock and no random number (AC3)', () => {
  it('completes with Date.now, Date.parse and Math.random stubbed to throw', () => {
    const boom = (): never => {
      throw new Error('the reducer read a clock or a random number');
    };
    vi.spyOn(Date, 'now').mockImplementation(boom);
    vi.spyOn(Date, 'parse').mockImplementation(boom);
    vi.spyOn(Math, 'random').mockImplementation(boom);

    expect(() => fold()).not.toThrow();
  });
});

suite('the projection the run reduces to', () => {
  const state = fold();

  it('completed the run, with every node completed exactly once', () => {
    expect(state.status).toBe('completed');
    expect(state.outcome).toBe('succeeded');
    expect(Object.keys(state.nodes)).toHaveLength(NODE_COUNT);
    for (let index = 0; index < NODE_COUNT; index += 1) {
      expect(state.nodes[nodeIdOf(index)]).toMatchObject({ status: 'completed', attempts: 1 });
    }
  });

  it('released every lock it took', () => {
    expect(state.locks).toEqual({});
  });

  it('left the watermark on the last event that changed the projection', () => {
    expect(state.watermarkSeq).toBe(EVENT_COUNT);
  });

  it('matches the committed file snapshot under the normalising serialiser', async () => {
    await expect(JSON.stringify(state, null, 2)).toMatchFileSnapshot(
      '__snapshots__/state-happy-path.json',
    );
  });
});

/**
 * The same fixture through the read path, so the two entry points cannot
 * disagree about what a clean ledger reduces to.
 */
suite('foldEvents over the raw rows agrees with reduce over the parsed ones', () => {
  it('reduces the stored rows to the same state, with nothing skipped', () => {
    const report = foldEvents(rows);

    expect(report.state).toEqual(fold());
    expect(report.applied).toBe(EVENT_COUNT);
    expect(report.skippedByKind).toEqual({});
    expect(report.unreadable).toEqual([]);
  });
});
