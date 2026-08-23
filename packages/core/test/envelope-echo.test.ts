/**
 * KAR-02.11 — a payload that restates an envelope field must restate it
 * correctly, and a kind that exists to be counted must be countable.
 *
 * The defect this is written from is not hypothetical. On 2026-08-16 a run
 * wedged at plan compilation on `Session ID … is already in use`, because the
 * attempt a pre-execution turn derives its vendor session from is
 * `count(provider.session_opened)` for that `(run, node)` — and that count is a
 * `WHERE node_id = ?` over an indexed **column**, not a scan of payload JSON.
 * An event written without a `nodeId` on its envelope therefore counts zero for
 * ever, the next turn re-derives the id the vendor already created, and the
 * vendor refuses it. The envelope's `nodeId` is optional for good reasons
 * everywhere else (`run.created` belongs to no node); it cannot be optional
 * here.
 *
 * Verifies: EPIC-02-S29, EPIC-02-S30 · AC1, AC3, AC4, AC5, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventKind } from '../src/event-payloads.ts';
import { EVENT_SCHEMAS } from '../src/event-payloads.ts';
import { EVENT_ENVELOPE_ECHOES, parseEvent } from '../src/events.ts';
import { PAYLOADS, RUN_ID } from './support/event-payloads.fixture.ts';

const KIND = 'provider.session_opened';
/** The id `claude` refused, which is `vendorSessionId(run, planner, 0)`. */
const SESSION_ID = '5f2b8935-25e5-5c1c-83c6-a97d1b151f08';

const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  node: 'planner',
  attempt: 0,
  provider: 'claude-code',
  session: { id: SESSION_ID, origin: 'minted' },
  ...overrides,
});

const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  seq: 12,
  runId: RUN_ID,
  ts: 1_754_313_093_000,
  kind: KIND,
  v: 1,
  epoch: 3,
  nodeId: 'planner',
  attempt: 0,
  payload: payload(),
  ...overrides,
});

const issuesOf = (result: ReturnType<typeof parseEvent>): string[] =>
  'issues' in result ? result.issues : [];

suite('a counted event cannot be recorded where no count can see it (AC3, EPIC-02-S29)', () => {
  it('parses the well-formed event, envelope and payload agreeing', () => {
    const result = parseEvent(envelope());

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.event.nodeId).toBe('planner');
    expect(result.event.attempt).toBe(0);
    expect(result.event.payload).toMatchObject({ node: 'planner', attempt: 0 });
  });

  it('refuses one whose envelope carries no nodeId to count it under', () => {
    const { nodeId: _dropped, ...withoutNode } = envelope();

    const result = parseEvent(withoutNode);

    expect(result.status).toBe('invalid-payload');
    expect(issuesOf(result).join('\n')).toMatch(/node.*nodeId/s);
  });

  it('refuses one whose envelope carries no attempt', () => {
    const { attempt: _dropped, ...withoutAttempt } = envelope();

    const result = parseEvent(withoutAttempt);

    expect(result.status).toBe('invalid-payload');
    expect(issuesOf(result).join('\n')).toMatch(/attempt/);
  });
});

suite('the envelope and the payload cannot disagree about the turn (AC4, EPIC-02-S30)', () => {
  it('refuses a node that is not the one the envelope indexes, naming both', () => {
    const result = parseEvent(envelope({ payload: payload({ node: 'framing' }) }));

    expect(result.status).toBe('invalid-payload');
    const issues = issuesOf(result).join('\n');
    expect(issues).toContain('framing');
    expect(issues).toContain('planner');
  });

  it('refuses an attempt that is not the one the envelope records, naming both', () => {
    const result = parseEvent(envelope({ attempt: 1, payload: payload({ attempt: 0 }) }));

    expect(result.status).toBe('invalid-payload');
    const issues = issuesOf(result).join('\n');
    expect(issues).toMatch(/attempt/);
    expect(issues).toMatch(/\b0\b/);
    expect(issues).toMatch(/\b1\b/);
  });

  it('accepts a later turn, so the rule is agreement and not a pin to zero', () => {
    const result = parseEvent(envelope({ attempt: 2, payload: payload({ attempt: 2 }) }));

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
  });
});

suite('the payload shape is strict (AC1, EPIC-02-S29)', () => {
  const rejected: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['an extra key', payload({ sessionId: SESSION_ID })],
    ['no attempt', (({ attempt: _a, ...rest }) => rest)(payload())],
    ['a negative attempt', payload({ attempt: -1 })],
    ['an attempt as a string', payload({ attempt: '1' })],
    ['an empty session id', payload({ session: { id: '', origin: 'minted' } })],
    ['an unknown origin', payload({ session: { id: SESSION_ID, origin: 'resumed' } })],
  ];

  for (const [why, bad] of rejected) {
    it(`rejects ${why}`, () => {
      // Asserted against the payload schema itself rather than through an
      // envelope: two of these rows are values the *envelope* also refuses, so
      // routing them through `parseEvent` would prove the envelope's rule twice
      // and this payload's rule not at all.
      expect(EVENT_SCHEMAS[KIND].payload.safeParse(bad).success, why).toBe(false);
    });
  }

  it('accepts the well-formed payload it is being contrasted with', () => {
    expect(EVENT_SCHEMAS[KIND].payload.safeParse(payload()).success).toBe(true);
  });
});

suite('the rule is a table, not a special case (AC5, EPIC-02-S30)', () => {
  it('declares only registered kinds and real envelope fields', () => {
    for (const [kind, echoes] of Object.entries(EVENT_ENVELOPE_ECHOES)) {
      expect(Object.keys(EVENT_SCHEMAS)).toContain(kind);
      for (const [payloadKey, envelopeField] of Object.entries(echoes)) {
        expect(['nodeId', 'attempt']).toContain(envelopeField);
        // The payload really has the key it claims to echo.
        expect(PAYLOADS[kind as EventKind]).toHaveProperty(payloadKey);
      }
    }
  });

  it('covers every entry from both sides', () => {
    for (const [kind, echoes] of Object.entries(EVENT_ENVELOPE_ECHOES)) {
      const corpus = PAYLOADS[kind as EventKind] as Record<string, unknown>;
      const echoed = Object.fromEntries(
        Object.entries(echoes).map(([payloadKey, envelopeField]) => [
          envelopeField,
          corpus[payloadKey],
        ]),
      );
      const base = {
        seq: 1,
        runId: RUN_ID,
        ts: 1_754_313_093_000,
        kind,
        v: EVENT_SCHEMAS[kind as EventKind].v,
        epoch: 1,
        payload: corpus,
        ...echoed,
      };

      expect(parseEvent(base).status, `${kind} agreeing`).toBe('ok');

      for (const envelopeField of Object.values(echoes)) {
        const { [envelopeField]: _absent, ...missing } = base;
        expect(parseEvent(missing).status, `${kind} missing ${envelopeField}`).toBe(
          'invalid-payload',
        );

        const wrong =
          envelopeField === 'attempt'
            ? { ...base, attempt: Number(corpus.attempt ?? 0) + 7 }
            : { ...base, nodeId: 'not-the-node' };
        expect(parseEvent(wrong).status, `${kind} disagreeing on ${envelopeField}`).toBe(
          'invalid-payload',
        );
      }
    }
  });

  it('leaves a kind that declares no echo exactly as it was', () => {
    const kinds = (Object.keys(EVENT_SCHEMAS) as EventKind[]).filter(
      (kind) => !(kind in EVENT_ENVELOPE_ECHOES),
    );

    for (const kind of kinds) {
      const result = parseEvent({
        seq: 1,
        runId: RUN_ID,
        ts: 1_754_313_093_000,
        kind,
        v: EVENT_SCHEMAS[kind].v,
        epoch: 1,
        payload: PAYLOADS[kind],
      });

      expect(result.status, `${kind} without an envelope nodeId`).toBe('ok');
    }
  });
});

suite('the order of the checks is unchanged (AC6, EPIC-02-S29, EPIC-02-S30)', () => {
  it('still reports an unknown kind before anything looks at an envelope field', () => {
    const { nodeId: _dropped, ...withoutNode } = envelope({ kind: 'future.thing' });

    expect(parseEvent(withoutNode)).toEqual({
      status: 'unknown-kind',
      kind: 'future.thing',
      seq: 12,
    });
  });

  it('still reports a future version rather than comparing an echo', () => {
    const result = parseEvent(envelope({ v: 2, payload: payload({ node: 'framing' }) }));

    expect(result.status).toBe('future-version');
  });

  it('never throws, whatever this kind arrives carrying', () => {
    for (const bad of [undefined, null, 42, 'text', [], { node: {} }]) {
      expect(() => parseEvent(envelope({ payload: bad }))).not.toThrow();
    }
  });
});
