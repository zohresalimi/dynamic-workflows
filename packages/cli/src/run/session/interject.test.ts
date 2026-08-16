/**
 * KAR-21.4 / EPIC-21-S28, S29, S30, S31, S32, S35, S36 — steering the node that
 * is running, and stopping the run, from the session the operator is in.
 *
 * Everything here is a **pure function plus one injected seam**, for the reason
 * the rest of this directory is written that way: the decisions are a table
 * test, and only the sending needs a daemon. The seam is a `send` and a
 * `cancel` the harness supplies, so *"exactly one request left, carrying these
 * fields"* is an array this file holds rather than a socket it has to watch.
 *
 * Two properties are load-bearing and both are asserted from the request that
 * left rather than from the state that produced it.
 *
 * **The node id is the projection's.** The operator is never asked for one — a
 * node id is DeFlow's vocabulary, not theirs — and it is read at send time
 * from the reduced state rather than from a variable this session updated when
 * the frame was last painted, which is the red the test plan names for #1.
 *
 * **The delivery outcome is rendered, never computed.** `unsupported` arrives
 * on a `202` with the daemon's own sentence and the alternative mode that
 * works; nothing here reads a capability, decides a run "looks steerable", or
 * spells the alternative. The re-send takes its mode off the response.
 *
 * Verifies: EPIC-21-S28, EPIC-21-S29, EPIC-21-S30, EPIC-21-S31, EPIC-21-S32,
 * EPIC-21-S35, EPIC-21-S36 · AC1, AC2, AC3, AC4, AC5, AC7, AC8 · test plan #1,
 * #2, #3, #4, #7, #8
 */
import type { NodeState, RunId, RunState } from '@DeFlow/core';
import { initialRunState } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { createStyle } from '../../render/style.ts';
import type { CancelOutcome } from '../cancel.ts';
import type { InterjectionOutcome, InterjectionRequest } from '../interject.ts';
import { applyIntent, applyTyping } from './actions.ts';
import { createCancelSession } from './cancel.ts';
import { createInterjectSession, NOTHING_RUNNING } from './interject.ts';
import type { Intent } from './keys.ts';
import { initialSessionState, type SessionState } from './state.ts';
import { renderFrame } from './view.ts';

const RUN_ID = 'run_20260816T101500Z_0a0a0a' as RunId;
const RUNNING = 'n_impl_2';
const GUIDANCE = 'use the existing helper in utils.ts';
const STYLE = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });

/** The seq this session last rendered — EPIC-21-S29's cursor. */
const LAST_SEQ = 412;

/** Text with every run of whitespace collapsed, because the frame wraps. */
const flatten = (text: string): string => text.replaceAll(/\s+/g, ' ');

const node = (over: Partial<NodeState>): NodeState => ({
  status: 'scheduled',
  attempt: 0,
  attempts: 1,
  provider: null,
  model: null,
  permission: null,
  worktree: null,
  result: null,
  failure: null,
  suspension: null,
  requestHash: null,
  wakeAt: null,
  startedTs: 0,
  updatedSeq: 1,
  ...over,
});

/** A run with one node running, spread from `initialRunState` so a field added
 * to `RunState` breaks this file at compile time rather than at read time. */
function midFlight(over: Partial<RunState> = {}): RunState {
  const base = initialRunState();
  return {
    ...base,
    runId: RUN_ID,
    status: 'running',
    nodes: {
      n_recon_1: node({ status: 'completed' }),
      [RUNNING]: node({ status: 'running', startedTs: 1 }),
      n_impl_3: node({ status: 'scheduled' }),
    },
    ...over,
  };
}

/** The same run a moment later: the node the operator was watching has gone. */
function betweenNodes(): RunState {
  return midFlight({
    nodes: {
      n_recon_1: node({ status: 'completed' }),
      [RUNNING]: node({ status: 'completed' }),
      n_impl_3: node({ status: 'scheduled' }),
    },
  });
}

const QUEUED: InterjectionOutcome = {
  ok: true,
  status: 202,
  delivery: 'queued',
  message: null,
  alternative: null,
};

/** The daemon's sentence for an adapter with no mid-turn steering — its words,
 * held separately so the assertions below quote the answer rather than a copy. */
const UNSUPPORTED_MESSAGE =
  'this adapter does not advertise mid-turn steering, so the guidance was recorded but not ' +
  'handed to the live session';

/** That sentence as the daemon sends it: an outcome on a `202`, never an error,
 * carrying the mode that does work. */
const UNSUPPORTED: InterjectionOutcome = {
  ok: true,
  status: 202,
  delivery: 'unsupported',
  message: UNSUPPORTED_MESSAGE,
  alternative: 'pause-and-inject',
};

const refusal = (code: string, message: string): InterjectionOutcome => ({
  ok: false,
  status: 409,
  code,
  message,
});

const CANCELLED: CancelOutcome = {
  via: 'cancel',
  message: `cancelling run ${RUN_ID} — the kill switch is running`,
};

interface Driver {
  press(intent: Intent): void;
  type(text: string): void;
  frame(): string;
  state(): SessionState;
  settled(): Promise<void>;
  setRun(next: RunState): void;
  readonly sent: InterjectionRequest[];
  readonly cancelled: number;
  readonly effects: string[];
}

/**
 * The session's own router, exactly as `run/run.ts` composes it.
 *
 * Typing wins over every verb while a row is open — otherwise the `c` in a
 * correction would end the run — and what neither verb claims falls through to
 * the one `SESSION_ACTIONS` table.
 */
function harness(
  options: {
    readonly run?: RunState;
    readonly lastSeq?: number;
    readonly answer?: (request: InterjectionRequest) => InterjectionOutcome;
    readonly cancel?: CancelOutcome;
  } = {},
): Driver {
  let run = options.run ?? midFlight();
  let session: SessionState = { ...initialSessionState(), keyboard: true, rows: 40 };
  const sent: InterjectionRequest[] = [];
  const effects: string[] = [];
  let cancelled = 0;

  const interject = createInterjectSession({
    runId: RUN_ID,
    // Never reached: `send` below is the whole transport for these scenarios.
    // It is still required, so a session that quietly built its own sender
    // would have to have been given a daemon to build it against.
    endpoint: { baseUrl: 'http://127.0.0.1:1', token: 'unused' },
    run: () => run,
    state: () => session,
    onState: (next) => {
      session = next;
    },
    lastSeq: () => options.lastSeq ?? LAST_SEQ,
    send: async (request) => {
      sent.push(request);
      return await Promise.resolve((options.answer ?? (() => QUEUED))(request));
    },
  });

  const cancelSession = createCancelSession({
    runId: RUN_ID,
    state: () => session,
    onState: (next) => {
      session = next;
    },
    cancel: async () => {
      cancelled += 1;
      return await Promise.resolve(options.cancel ?? CANCELLED);
    },
  });

  return {
    press: (intent) => {
      if (interject.handle(intent)) return;
      if (cancelSession.handle(intent)) return;
      const outcome = applyIntent(session, intent);
      effects.push(outcome.effect);
      session = outcome.state;
    },
    type: (text) => {
      session = applyTyping(session, text);
    },
    frame: () => renderFrame(run, session, STYLE).join('\n'),
    state: () => session,
    settled: async () => {
      await interject.settled();
      await cancelSession.settled();
    },
    setRun: (next) => {
      run = next;
    },
    sent,
    get cancelled() {
      return cancelled;
    },
    effects,
  };
}

/* -------------------------------------------------------------------------- *
 * EPIC-21-S28 — a typed line reaches the node that is running
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S28 — the interjection reaches the running node (AC1, AC2)', () => {
  it('opens a row, sends what was typed, and takes the node from the projection', async () => {
    const driver = harness();

    driver.press('interject');
    expect(driver.state().input?.kind).toBe('interject');

    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0]?.text).toBe(GUIDANCE);
    // The node id is the reduced state's, and the operator neither typed it nor
    // was asked for it: the row asked for guidance and nothing else.
    expect(driver.sent[0]?.node).toBe(RUNNING);
    expect(GUIDANCE).not.toContain(RUNNING);
    expect(driver.state().input).toBeNull();
  });

  it('abandons the row on Escape and sends nothing', async () => {
    const driver = harness();

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('dismiss');
    await driver.settled();

    expect(driver.sent).toHaveLength(0);
    expect(driver.state().input).toBeNull();
  });

  it('reads the node at send time rather than when the row opened', async () => {
    // The red the test plan names for #1: a node id captured when the frame was
    // last painted lands the correction on whatever was running *then*.
    const driver = harness();
    driver.press('interject');
    driver.type(GUIDANCE);

    driver.setRun(
      midFlight({
        nodes: {
          [RUNNING]: node({ status: 'completed' }),
          n_impl_3: node({ status: 'running', startedTs: 2 }),
        },
      }),
    );
    driver.press('confirm');
    await driver.settled();

    expect(driver.sent[0]?.node).toBe('n_impl_3');
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S29 — the cursor the frame was painted at
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S29 — ifLastSeq travels with the interjection (AC2, AC5)', () => {
  it('carries the seq this session last rendered', async () => {
    const driver = harness({ lastSeq: LAST_SEQ });

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.sent[0]?.ifLastSeq).toBe(LAST_SEQ);
  });

  it('shows the stale-cursor refusal verbatim and does not re-send with a newer one', async () => {
    const message =
      "node 'n_impl_2' moved at seq 500, after the cursor 412 this interjection was written " +
      'against — it is no longer running. Nothing was appended';
    const driver = harness({ answer: () => refusal('stale_cursor', message) });

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.sent).toHaveLength(1);
    expect(flatten(driver.frame())).toContain(flatten(message));

    // The node the operator was addressing is gone; silently re-addressing the
    // next one is not what they asked for.
    await driver.settled();
    expect(driver.sent).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S30 / S31 — the daemon's outcome, and its alternative
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S30 — delivery is the daemon’s answer, rendered (AC3)', () => {
  it('shows queued for a 202 the daemon accepted', async () => {
    const driver = harness();

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.frame().toLowerCase()).toContain('queued');
  });

  it('shows the message and the alternative for an unsupported 202, and re-sends nothing', async () => {
    const driver = harness({ answer: () => UNSUPPORTED });

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    const frame = flatten(driver.frame());
    expect(frame).toContain(flatten(UNSUPPORTED_MESSAGE));
    // The alternative is named — it is the daemon's word, not one this package
    // spelled — and it is offered rather than taken.
    expect(frame).toContain('pause-and-inject');
    expect(driver.sent).toHaveLength(1);
  });
});

suite('EPIC-21-S31 — the second attempt is the operator’s (AC3)', () => {
  it('re-sends with the mode the daemon named, and the text that was typed', async () => {
    const driver = harness({ answer: () => UNSUPPORTED });

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    driver.press('resend');
    await driver.settled();

    expect(driver.sent).toHaveLength(2);
    expect(driver.sent[1]?.mode).toBe('pause-and-inject');
    expect(driver.sent[1]?.text).toBe(GUIDANCE);
    expect(driver.sent[1]?.node).toBe(RUNNING);
    // The first attempt asked for something else: the two modes differ, which
    // is the whole reason the daemon named one.
    expect(driver.sent[0]?.mode).not.toBe(driver.sent[1]?.mode);
  });

  it('dismisses the offer on any other key, and sends nothing further', async () => {
    const driver = harness({ answer: () => UNSUPPORTED });

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    driver.press('dismiss');
    await driver.settled();

    expect(driver.sent).toHaveLength(1);
    // And the offer is gone, so a later re-send key cannot resurrect it.
    driver.press('resend');
    await driver.settled();
    expect(driver.sent).toHaveLength(1);
    expect(flatten(driver.frame())).not.toContain('pause-and-inject');
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S32 — nothing is running
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S32 — an interjection at nothing is not an interjection (AC4)', () => {
  it('opens no row, says so once, and makes no request', async () => {
    const driver = harness({ run: betweenNodes() });

    driver.press('interject');
    await driver.settled();

    expect(driver.state().input).toBeNull();
    expect(flatten(driver.frame())).toContain(NOTHING_RUNNING);
    expect(driver.sent).toHaveLength(0);
  });

  it('sends nothing when the last running node finishes while the row is open', async () => {
    const driver = harness();

    driver.press('interject');
    driver.type(GUIDANCE);
    driver.setRun(betweenNodes());
    driver.press('confirm');
    await driver.settled();

    expect(driver.sent).toHaveLength(0);
    expect(flatten(driver.frame())).toContain(NOTHING_RUNNING);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S35 / S36 — cancelling takes two decisions
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S35 — cancel asks first, and a bare Enter means no (AC7)', () => {
  it('names the run in its confirmation', () => {
    const driver = harness();

    driver.press('cancel');

    expect(driver.state().input?.kind).toBe('cancel-confirm');
    expect(driver.frame()).toContain(RUN_ID);
  });

  const answers: readonly [string, string, number][] = [
    ['a bare Enter', '', 0],
    ['an explicit no', 'n', 0],
    ['a word that is not yes', 'later', 0],
    ['yes', 'y', 1],
    ['the whole word', 'yes', 1],
  ];

  for (const [what, typed, calls] of answers) {
    it(`calls cancelRun ${String(calls)} times for ${what}`, async () => {
      const driver = harness();

      driver.press('cancel');
      if (typed !== '') driver.type(typed);
      driver.press('confirm');
      await driver.settled();

      expect(driver.cancelled).toBe(calls);
      expect(driver.state().input).toBeNull();
    });
  }

  it('calls nothing when the confirmation is dismissed', async () => {
    const driver = harness();

    driver.press('cancel');
    driver.type('y');
    driver.press('dismiss');
    await driver.settled();

    expect(driver.cancelled).toBe(0);
    expect(driver.state().input).toBeNull();
  });

  it('types into the open confirmation rather than re-reading the keys', () => {
    // `c` and `i` are keys; inside a row they are letters. Without this a
    // correction containing them would cancel the run it was correcting.
    const driver = harness();

    driver.press('interject');
    driver.type('check it');

    expect(driver.state().input?.text).toBe('check it');
    expect(driver.state().input?.kind).toBe('interject');
  });
});

suite('EPIC-21-S36 — a confirmed cancel keeps the session open (AC8)', () => {
  it('shows what cancelRun returned and asks nothing to exit', async () => {
    const driver = harness();

    driver.press('cancel');
    driver.type('y');
    driver.press('confirm');
    await driver.settled();

    expect(driver.cancelled).toBe(1);
    expect(flatten(driver.frame())).toContain(flatten(CANCELLED.message));
    // The session's exit is `watch()`'s, reached when the run's terminal event
    // arrives. Cancelling from here never touches the interrupt path, which is
    // the one thing that would end the screen at the moment of the decision.
    expect(driver.effects).not.toContain('interrupt');
  });

  it('forwards a refusal from cancelRun as its own words', async () => {
    const message = `could not cancel run ${RUN_ID}: 409 already_terminal`;
    const driver = harness({ cancel: { via: 'cancel', message } });

    driver.press('cancel');
    driver.type('y');
    driver.press('confirm');
    await driver.settled();

    expect(flatten(driver.frame())).toContain(flatten(message));
  });
});
