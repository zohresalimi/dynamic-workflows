/**
 * KAR-27.6 — the words a parked cooperative cancel is described in, and the
 * projection they are read off.
 *
 * EPIC-27-S28, S29, S31 and S33 are all claims about a *derivation*: given a
 * run whose cancel has not been answered, what does the system say, and does it
 * say nothing new about a run nobody cancelled. That is a fold and a table of
 * strings, so it is proved here rather than against a daemon —
 * `../../daemon/test/integration/cancel-unanswered.test.ts` is where the loop
 * that appends the fact is asserted, and it reads its sentences from these
 * functions rather than spelling its own.
 *
 * Verifies: EPIC-27-S28, EPIC-27-S29, EPIC-27-S31, EPIC-27-S33 · KAR-27.6 AC1,
 * AC2, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import {
  COOPERATIVE_CANCEL_UNANSWERED_MS,
  cancelWaiting,
  forcefulCancelCommand,
} from './cooperative-cancel.ts';
import { initialRunState, type RunState } from './run-state.ts';
import { runStatusLabel } from './run-status-label.ts';

const RUN = 'run_20260825T140000Z_a1b2c3';
const SINCE = Date.UTC(2026, 7, 25, 14, 0, 0);
const SINCE_ISO = new Date(SINCE).toISOString();

/** A run the operator cancelled cooperatively, whose agent has not answered. */
function parked(
  survivors: readonly { readonly node: string; readonly pid: number }[] = [
    { node: 'impl-auth', pid: 48_215 },
  ],
): RunState {
  return {
    ...initialRunState(),
    status: 'cancelling',
    cancel: {
      mode: 'cooperative',
      requestedSeq: 12,
      unanswered: { sinceTs: SINCE, survivors },
    },
  };
}

/** The same cancel, before the window has elapsed: nothing has been reported. */
function cancelling(): RunState {
  return {
    ...initialRunState(),
    status: 'cancelling',
    cancel: { mode: 'cooperative', requestedSeq: 12, unanswered: null },
  };
}

suite('EPIC-27-S28 — an unanswered cooperative cancel says so (AC1)', () => {
  it('names the instant rather than reporting a bare cancelling', () => {
    expect(runStatusLabel(parked())).toBe(
      `cancelling · the agent has not answered since ${SINCE_ISO}`,
    );
  });

  it('still reports a bare cancelling before anything has been reported', () => {
    expect(runStatusLabel(cancelling())).toBe('cancelling');
    expect(cancelWaiting(cancelling(), RUN)).toBeNull();
  });

  it('bounds the wait with a named constant rather than a magic number', () => {
    expect(Number.isInteger(COOPERATIVE_CANCEL_UNANSWERED_MS)).toBe(true);
    expect(COOPERATIVE_CANCEL_UNANSWERED_MS).toBeGreaterThan(0);
  });
});

suite('EPIC-27-S29 — the way out is named where the wait is shown (AC2)', () => {
  it('names forceful cancel as the operator’s next move, with this run’s id', () => {
    const waiting = cancelWaiting(parked(), RUN);
    expect(waiting?.remedy).toContain(forcefulCancelCommand(RUN));
    expect(forcefulCancelCommand(RUN)).toBe(`deflow cancel ${RUN} --force`);
  });

  it('carries the same since-instant the status label does, so the two agree', () => {
    expect(cancelWaiting(parked(), RUN)?.since).toBe(SINCE_ISO);
    expect(runStatusLabel(parked())).toContain(SINCE_ISO);
  });
});

suite('EPIC-27-S31 — what is still running is named (AC4)', () => {
  it('names both survivors by pid and node, without recourse to ps', () => {
    const waiting = cancelWaiting(
      parked([
        { node: 'impl-auth', pid: 48_215 },
        { node: 'impl-router', pid: 48_216 },
      ]),
      RUN,
    );
    expect(waiting?.survivors).toEqual([
      { node: 'impl-auth', pid: 48_215 },
      { node: 'impl-router', pid: 48_216 },
    ]);
    expect(waiting?.stillRunning).toBe('pid 48215 (impl-auth), pid 48216 (impl-router)');
  });

  it('says so honestly when the ledger named nobody', () => {
    expect(cancelWaiting(parked([]), RUN)?.stillRunning).toBe('nothing this daemon can still see');
  });
});

suite('EPIC-27-S33 — a run that was never cancelled says nothing new', () => {
  it('reports its ordinary label and no waiting copy', () => {
    const running: RunState = { ...initialRunState(), status: 'running' };
    expect(runStatusLabel(running)).toBe('running');
    expect(cancelWaiting(running, RUN)).toBeNull();
  });

  it('says nothing new about a run that ended, whatever its cancel record holds', () => {
    const ended: RunState = { ...parked(), status: 'aborted' };
    expect(runStatusLabel(ended)).toBe('aborted');
    expect(cancelWaiting(ended, RUN)).toBeNull();
  });
});
