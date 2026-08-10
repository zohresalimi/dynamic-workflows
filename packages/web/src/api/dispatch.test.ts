/**
 * KAR-15.3 test plan #3 — the client dispatcher discriminates on the payload's
 * `kind`, never on the SSE `event:` name.
 *
 * Verifies: EPIC-15-S20 (both scenarios), EPIC-15-S15 (the fan-out half),
 * EPIC-15-S25 (which codes stop the retry) · AC5, AC6, AC15
 *
 * Two separate claims live here and they fail in opposite directions.
 *
 * A **named** frame is stream control — `hello`, `subscribed`, `caught_up`,
 * `fatal` — and must never reach the reducer, because a reducer fed a
 * `caught_up` would fold a stream-transport fact into run state. An **unnamed**
 * frame is a ledger event and must always reach it, which is why there is one
 * `onmessage` handler rather than one per kind.
 *
 * And an unknown `kind` is ignored *without* stalling the cursor. That pair is
 * what lets an older UI build run against a newer daemon: skipping the event is
 * the easy half, and a client that skipped the cursor with it would re-request
 * the same event forever.
 */
import { expect, it, describe as suite, vi } from 'vitest';
import { createDispatcher, fanOutByRun, stopsRetrying } from './dispatch.ts';

const RUN_A = 'run_20260810T093000Z_aa0001';
const RUN_B = 'run_20260810T093000Z_bb0002';

const envelope = (
  seq: number,
  runId: string,
  kind: string,
  payload: unknown = { node: 'n-impl-3', attempt: 1, phase: 'running' },
): string => JSON.stringify({ seq, runId, ts: 1_754_140_000_000, kind, v: 1, epoch: 7, payload });

const ledger = (seq: number, runId: string, kind = 'node.progress', payload?: unknown) => ({
  id: String(seq),
  data: envelope(seq, runId, kind, payload),
});

suite('control frames never reach the reducer (AC5)', () => {
  it('routes hello, subscribed, caught_up and fatal to the control handler', () => {
    const applyEvent = vi.fn();
    const control = vi.fn();
    const dispatcher = createDispatcher({ applyEvent, control });

    dispatcher.onFrame({ event: 'hello', data: JSON.stringify({ streamId: 's_1', headSeq: 12 }) });
    dispatcher.onFrame({ event: 'subscribed', data: JSON.stringify({ runs: [RUN_A] }) });
    dispatcher.onFrame({ event: 'caught_up', data: JSON.stringify({ runId: RUN_A, seq: 400 }) });
    dispatcher.onFrame({ event: 'fatal', data: JSON.stringify({ error: { code: 'internal' } }) });

    expect(applyEvent).not.toHaveBeenCalled();
    expect(control.mock.calls.map(([frame]) => (frame as { name: string }).name)).toEqual([
      'hello',
      'subscribed',
      'caught_up',
      'fatal',
    ]);
  });

  it('feeds only the unnamed frames to applyEvent', () => {
    const applyEvent = vi.fn();
    const dispatcher = createDispatcher({ applyEvent, control: vi.fn() });

    dispatcher.onFrame({ event: 'hello', data: '{"streamId":"s_1"}' });
    dispatcher.onFrame(ledger(11, RUN_A));
    dispatcher.onFrame({ event: 'caught_up', data: `{"runId":"${RUN_A}","seq":11}` });
    dispatcher.onFrame(ledger(12, RUN_A));

    expect(applyEvent).toHaveBeenCalledTimes(2);
    expect(applyEvent.mock.calls.map(([event]) => (event as { seq: number }).seq)).toEqual([
      11, 12,
    ]);
  });

  it('treats a control frame with an unknown name as control, not as an event', () => {
    const applyEvent = vi.fn();
    const control = vi.fn();
    const dispatcher = createDispatcher({ applyEvent, control });

    // A newer daemon inventing a fifth control frame must not be mistaken for
    // a ledger event, whatever its data happens to look like.
    dispatcher.onFrame({ event: 'rekeyed', data: envelope(13, RUN_A, 'node.progress') });

    expect(applyEvent).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledTimes(1);
  });
});

suite('an old UI against a newer daemon (AC6)', () => {
  it('ignores an unknown kind without throwing, and still advances the cursor', () => {
    const applyEvent = vi.fn();
    const unknown = vi.fn();
    const dispatcher = createDispatcher({ applyEvent, control: vi.fn(), onUnknownKind: unknown });

    dispatcher.onFrame(ledger(41, RUN_A));
    expect(() =>
      dispatcher.onFrame(ledger(42, RUN_A, 'some.future.kind', { whatever: true })),
    ).not.toThrow();

    expect(applyEvent).toHaveBeenCalledTimes(1);
    expect(unknown).toHaveBeenCalledWith('some.future.kind', 42);
    // The subtle half: a client that skipped the event *and* the cursor would
    // re-request the same event on every reconnect, forever.
    expect(dispatcher.cursor()).toBe(42);
  });

  it('advances the cursor past a malformed envelope rather than wedging on it', () => {
    const dispatcher = createDispatcher({ applyEvent: vi.fn(), control: vi.fn() });
    dispatcher.onFrame(ledger(50, RUN_A));
    expect(() => dispatcher.onFrame({ id: '51', data: '{not json' })).not.toThrow();
    expect(dispatcher.cursor()).toBe(51);
  });

  it('never moves the cursor backwards, so an out-of-order frame cannot rewind it', () => {
    const dispatcher = createDispatcher({ applyEvent: vi.fn(), control: vi.fn() });
    dispatcher.onFrame(ledger(90, RUN_A));
    dispatcher.onFrame(ledger(80, RUN_A));
    expect(dispatcher.cursor()).toBe(90);
  });

  it('leaves the cursor alone for a control frame, which carries no seq', () => {
    const dispatcher = createDispatcher({ applyEvent: vi.fn(), control: vi.fn() });
    dispatcher.onFrame(ledger(70, RUN_A));
    dispatcher.onFrame({ event: 'caught_up', data: `{"runId":"${RUN_A}","seq":9999}` });
    expect(dispatcher.cursor()).toBe(70);
  });
});

suite('one dispatcher, three panels (AC1, the client half)', () => {
  it('routes each frame by its runId to the right projection set', () => {
    const seen = new Map<string, number[]>([
      [RUN_A, []],
      [RUN_B, []],
    ]);
    const dispatcher = createDispatcher({
      applyEvent: fanOutByRun((runId) => {
        const into = seen.get(runId);
        return into === undefined ? undefined : (event) => into.push(event.seq);
      }),
      control: vi.fn(),
    });

    for (const [seq, run] of [
      [1, RUN_A],
      [2, RUN_B],
      [3, RUN_A],
      [4, 'run_20260810T093000Z_cc0003'],
      [5, RUN_B],
    ] as const) {
      dispatcher.onFrame(ledger(seq, run));
    }

    expect(seen.get(RUN_A)).toEqual([1, 3]);
    expect(seen.get(RUN_B)).toEqual([2, 5]);
    // A run nothing is watching is dropped rather than throwing: the filter is
    // the server's, and a stale subscription must not break the tab.
    expect(dispatcher.cursor()).toBe(5);
  });
});

suite('which fatal codes stop the retry (AC15)', () => {
  it('stops retrying for exactly bad_token and epoch_mismatch', () => {
    expect(stopsRetrying('bad_token')).toBe(true);
    expect(stopsRetrying('epoch_mismatch')).toBe(true);
  });

  it('keeps retrying for everything else, including a transient internal error', () => {
    for (const code of ['internal', 'daemon_starting', 'not_found', 'unknown_to_this_build']) {
      expect(stopsRetrying(code)).toBe(false);
    }
  });
});
