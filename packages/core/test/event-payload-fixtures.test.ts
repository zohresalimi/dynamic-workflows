/**
 * KAR-02.7 — one valid payload per event kind, table-driven.
 *
 * Test 7's other half. The docs-table check
 * (./event-kinds-table.test.ts) proves every documented kind has a schema;
 * this proves every schema has been exercised at least once, which is the
 * difference between "41 schemas exist" and "41 schemas are right". The
 * fixture map is typed `Record<EventKind, unknown>`, so adding a kind to
 * ./../src/event-payloads.ts without a fixture is a type error before it is a
 * test failure.
 *
 * The corpus itself lives in ./support/event-payloads.fixture.ts, because
 * KAR-03.5's reducer-totality suite folds exactly these payloads and a second
 * copy would let the two drift apart silently.
 *
 * Verifies: KAR-02.7 test 7 · AC1
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventKind } from '../src/event-payloads.ts';
import { EVENT_KINDS, EVENT_SCHEMAS } from '../src/event-payloads.ts';
import { parseEvent } from '../src/events.ts';
import { envelopeEchoes, PAYLOADS, RUN_ID } from './support/event-payloads.fixture.ts';

const envelope = (kind: EventKind, payload: unknown): Record<string, unknown> => ({
  seq: 1,
  runId: RUN_ID,
  ts: 1_754_313_093_000,
  kind,
  v: EVENT_SCHEMAS[kind].v,
  epoch: 1,
  // KAR-02.11 — a kind that declares an echo is not a well-formed event without
  // the envelope fields its payload restates. The rule itself is asserted in
  // ./envelope-echo.test.ts; here it is only obeyed.
  ...envelopeEchoes(kind),
  payload,
});

suite('every event kind has a schema that accepts a real payload', () => {
  it('has a fixture for every registered kind, and no orphan fixtures', () => {
    expect(Object.keys(PAYLOADS).toSorted()).toEqual([...EVENT_KINDS].toSorted());
  });

  for (const kind of EVENT_KINDS) {
    it(`${kind} parses`, () => {
      const result = parseEvent(envelope(kind, PAYLOADS[kind]));

      expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
    });

    it(`${kind} rejects an unknown field rather than dropping it`, () => {
      const payload = PAYLOADS[kind];
      if (payload === null || typeof payload !== 'object') throw new Error('unreachable');

      const result = parseEvent(
        envelope(kind, { ...(payload as Record<string, unknown>), notAField: true }),
      );

      expect(result.status).toBe('invalid-payload');
    });
  }
});
