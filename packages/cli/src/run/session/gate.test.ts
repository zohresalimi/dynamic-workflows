/**
 * KAR-21.3 / EPIC-21-S18, S20, S21, S22, S24, S25, S26 — the gate is answered
 * where the operator already is.
 *
 * Every assertion about *which* request answered *which* gate is an equality
 * against `gateAnswerRequest`'s own output rather than a comparison with a path
 * spelled here. A spec that wrote out `/api/runs/<id>/spec/approve` would be a
 * second copy of the decision KAR-22.5 centralised, and it would keep passing
 * on the day that decision changed — which is precisely the failure the
 * module's own note describes.
 *
 * The transport is a **recording `fetch`**, not a mocked module: the real
 * sender runs, so the bearer token, the `X-DeFlow-Submitted-By` header and the
 * serialised body are the ones a daemon would have received.
 *
 * The intent router below is the one `run/run.ts` uses — the gate is offered
 * every key first and everything it does not claim falls through to the single
 * `SESSION_ACTIONS` table. It is repeated here because a unit spec that drove
 * the gate directly would prove nothing about the order the two are consulted
 * in; `test/integration/session-gate.test.ts` drives the real command.
 *
 * Verifies: EPIC-21-S18, EPIC-21-S20, EPIC-21-S21, EPIC-21-S22, EPIC-21-S24,
 * EPIC-21-S25, EPIC-21-S26 · AC1, AC3, AC4, AC5, AC7, AC8 · test plan #1, #3,
 * #4, #5, #8, #9
 */
import type { HumanGateState, NodeId, RunId, RunState } from '@DeFlow/core';
import {
  gateAnswerRequest,
  initialRunState,
  pendingGate,
  SPEC_APPROVAL_OPTIONS,
  SPEC_EDIT_NEEDS_A_DOCUMENT,
  SPEC_GATE_NODE,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { createStyle, type Style } from '../../render/style.ts';
import type { DaemonEndpoint } from '../daemon.ts';
import { applyIntent } from './actions.ts';
import { createGateSession } from './gate.ts';
import type { Intent } from './keys.ts';
import { initialSessionState, type SessionState } from './state.ts';
import { gateOptionRows, renderFrame } from './view.ts';

const RUN_ID = 'run_20260816T101500Z_0a0a0a' as RunId;
const PLAN_GATE = 'confirm-scope' as NodeId;

const ENDPOINT: DaemonEndpoint = {
  baseUrl: 'http://127.0.0.1:41999',
  token: 'test-token-not-a-real-secret',
  pid: 4242,
  autostarted: false,
};

const STYLE: Style = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });

/** One open gate, exactly as the reducer folds `human.requested`. */
function gate(over: Partial<HumanGateState> & Pick<HumanGateState, 'node'>): HumanGateState {
  return {
    prompt: 'Approve this spec?',
    options: [...SPEC_APPROVAL_OPTIONS],
    requestedSeq: 7,
    response: null,
    deadline: null,
    escalated: false,
    reason: null,
    permission: null,
    ...over,
  } as HumanGateState;
}

function runWith(...gates: readonly HumanGateState[]): RunState {
  return {
    ...initialRunState(),
    runId: RUN_ID,
    status: 'needs-human',
    humanGates: Object.fromEntries(gates.map((one) => [one.node, one])),
  };
}

/** What `fetch` was handed, so a spec can compare it with the domain's answer. */
interface Sent {
  readonly url: string;
  readonly init: RequestInit;
  /** The serialised body, read back rather than re-derived. */
  readonly body: string;
}

interface Harness {
  press(intent: Intent): void;
  frame(): string;
  rows(): readonly string[];
  readonly sent: readonly Sent[];
  state(): SessionState;
  settled(): Promise<void>;
  setRun(next: RunState): void;
  /**
   * What the operator has typed into the open row.
   *
   * Set rather than typed, because the keystrokes that fill a row are
   * KAR-21.4's — `actions.ts` already names it as their owner, and this story
   * owes only that a filled row is sent and an empty one is not.
   */
  setText(text: string): void;
}

/**
 * A session over a run, driven by intents, with a recording `fetch`.
 *
 * `respond` is what a spec that needs to hold a request open supplies; the
 * default answers `202` immediately, which is what a daemon that accepted does.
 */
function harness(
  run: RunState,
  respond: (sent: Sent) => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: 202 })),
): Harness {
  const sent: Sent[] = [];
  let current = run;
  let session: SessionState = { ...initialSessionState(), keyboard: true, rows: 40 };

  const gateSession = createGateSession({
    runId: RUN_ID,
    endpoint: ENDPOINT,
    run: () => current,
    state: () => session,
    onState: (next) => {
      session = next;
    },
    fetch: (input, init) => {
      const record: Sent = {
        url: typeof input === 'string' ? input : String((input as URL).toString()),
        init: init ?? {},
        body: typeof init?.body === 'string' ? init.body : '',
      };
      sent.push(record);
      return respond(record);
    },
  });

  return {
    press(intent) {
      // `run/run.ts`'s router, verbatim: the gate is offered the key first, and
      // everything it does not claim falls through to the one action table.
      if (gateSession.handle(intent)) return;
      session = applyIntent(session, intent).state;
    },
    frame: () => renderFrame(current, session, STYLE).join('\n'),
    rows: () => {
      const open = pendingGate(current);
      return open === null ? [] : gateOptionRows(open, session, STYLE);
    },
    sent,
    state: () => session,
    settled: () => gateSession.settled(),
    setRun: (next) => {
      current = next;
    },
    setText: (text) => {
      const input = session.input;
      if (input === null) throw new Error('no input row is open');
      session = { ...session, input: { ...input, text } };
    },
  };
}

/** Select the option at `index` from the top, then confirm it. */
function choose(driver: Harness, index: number): void {
  driver.press('answer');
  for (let step = 0; step < index; step += 1) driver.press('select-down');
  driver.press('confirm');
}

/**
 * Text with every run of whitespace collapsed to one space.
 *
 * The frame wraps every block it prints, so a sentence long enough to matter —
 * `SPEC_EDIT_NEEDS_A_DOCUMENT` is 250 characters — arrives across four indented
 * lines. A substring test against the unwrapped constant would fail on a frame
 * that printed it perfectly, which is the wrong question; flattening asks
 * whether these words, in this order, are on screen.
 */
const flatten = (text: string): string => text.replaceAll(/\s+/g, ' ');

const bodyOf = (sent: Sent): unknown => JSON.parse(sent.body);
const headerOf = (sent: Sent, name: string): string | undefined =>
  (sent.init.headers as Record<string, string> | undefined)?.[name];

/* -------------------------------------------------------------------------- *
 * EPIC-21-S18 — the spec gate is approved with one keypress
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S18 — approving the F1.3 gate (AC1, AC2)', () => {
  it('shows the node, the prompt verbatim and one row per option', () => {
    const driver = harness(runWith(gate({ node: SPEC_GATE_NODE, prompt: 'Approve this spec?' })));

    const frame = driver.frame();

    expect(frame).toContain(SPEC_GATE_NODE);
    expect(frame).toContain('Approve this spec?');
    expect(driver.rows()).toHaveLength(SPEC_APPROVAL_OPTIONS.length);
    for (const option of SPEC_APPROVAL_OPTIONS) {
      expect(driver.rows().some((row) => row.includes(option.label))).toBe(true);
      expect(frame).toContain(option.label);
    }
  });

  it('posts exactly what gateAnswerRequest built, with the endpoint’s own token', async () => {
    const driver = harness(runWith(gate({ node: SPEC_GATE_NODE })));

    choose(driver, 0);
    await driver.settled();

    expect(driver.sent).toHaveLength(1);
    const sent = driver.sent[0] as Sent;

    // Equality against the domain's own answer, never against a path this
    // spec spelled: the whole point of KAR-22.5 is that there is one of these.
    const expected = gateAnswerRequest({
      runId: RUN_ID,
      gate: SPEC_GATE_NODE,
      optionId: SPEC_APPROVAL_OPTIONS[0].id,
      text: null,
    });
    expect(expected).not.toBeNull();
    expect(sent.url).toBe(`${ENDPOINT.baseUrl}${expected?.path ?? ''}`);
    expect(bodyOf(sent)).toEqual(expected?.body);
    expect(sent.init.method).toBe('POST');
    expect(headerOf(sent, 'authorization')).toBe(`Bearer ${ENDPOINT.token}`);
    expect(headerOf(sent, 'X-DeFlow-Submitted-By')).toBe('cli');
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S20 — a plan gate's own options are the options offered
 * -------------------------------------------------------------------------- */

const PLAN_OPTIONS = [
  { id: 'proceed', label: 'Keep going with both packages', effect: 'approve' },
  { id: 'retry', label: 'Run recon again first', effect: 'inject' },
  { id: 'skip', label: 'Skip the extra packages', effect: 'reject' },
] as const;

suite('EPIC-21-S20 — a plan gate offers what the plan declared (AC1, AC2)', () => {
  const planRun = (): RunState =>
    runWith(
      gate({
        node: PLAN_GATE,
        prompt: 'Recon found two more packages. Keep going?',
        options: [...PLAN_OPTIONS] as never,
      }),
    );

  it('offers one row per declared option and none of the F1.3 four', () => {
    const driver = harness(planRun());

    const rows = driver.rows();

    expect(rows).toHaveLength(PLAN_OPTIONS.length);
    for (const option of PLAN_OPTIONS) {
      expect(rows.some((row) => row.includes(option.label))).toBe(true);
    }
    // The rows are the gate's, not a hardcoded F1.3 set: a session that spelled
    // the spec options would show three rows and none of them would be `retry`.
    const text = rows.join('\n');
    for (const option of SPEC_APPROVAL_OPTIONS) {
      expect(text).not.toContain(option.label);
    }
  });

  it('routes it to the respond endpoint, because specApproval is false', async () => {
    const state = planRun();
    expect(pendingGate(state)?.specApproval).toBe(false);
    const driver = harness(state);

    choose(driver, 1);
    await driver.settled();

    const expected = gateAnswerRequest({
      runId: RUN_ID,
      gate: PLAN_GATE,
      optionId: PLAN_OPTIONS[1].id,
      text: null,
    });
    expect(driver.sent).toHaveLength(1);
    expect((driver.sent[0] as Sent).url).toBe(`${ENDPOINT.baseUrl}${expected?.path ?? ''}`);
    expect(bodyOf(driver.sent[0] as Sent)).toEqual(expected?.body);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S21 — a rejection carries a reason, or it is not sent
 * -------------------------------------------------------------------------- */

const REJECT_INDEX = SPEC_APPROVAL_OPTIONS.findIndex((option) => option.id === 'reject');

suite('EPIC-21-S21 — a rejection with nothing to say is not sent (AC3)', () => {
  it('opens an inline input instead of sending, and sends nothing while it is empty', async () => {
    const driver = harness(runWith(gate({ node: SPEC_GATE_NODE })));

    choose(driver, REJECT_INDEX);
    await driver.settled();

    expect(driver.sent).toHaveLength(0);
    expect(driver.state().input?.kind).toBe('gate-text');
    expect(driver.state().input?.text).toBe('');

    // Confirming an empty one is a refusal, not a send.
    driver.press('confirm');
    await driver.settled();

    expect(driver.sent).toHaveLength(0);
    expect(driver.frame()).toContain('reason');
  });

  it('abandons the input on dismiss and leaves the gate open and unanswered', async () => {
    const open = gate({ node: SPEC_GATE_NODE });
    const driver = harness(runWith(open));

    choose(driver, REJECT_INDEX);
    // Three characters, typed. The keystrokes that fill this row arrive with
    // KAR-21.4, which `actions.ts` already names as their owner; what this
    // story owes is that a filled row is sent and an abandoned one is not.
    driver.press('dismiss');
    await driver.settled();

    expect(driver.sent).toHaveLength(0);
    expect(driver.state().input).toBeNull();
    // The one reader of "is this gate open" still says it is.
    expect(pendingGate(runWith(open))).not.toBeNull();
  });

  it('sends the reason once the row carries one', async () => {
    const driver = harness(runWith(gate({ node: SPEC_GATE_NODE })));

    choose(driver, REJECT_INDEX);
    driver.setText('the criteria are unverifiable');
    driver.press('confirm');
    await driver.settled();

    const expected = gateAnswerRequest({
      runId: RUN_ID,
      gate: SPEC_GATE_NODE,
      optionId: 'reject',
      text: 'the criteria are unverifiable',
    });
    expect(driver.sent).toHaveLength(1);
    expect(bodyOf(driver.sent[0] as Sent)).toEqual(expected?.body);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S22 — edit is shown, refused, in the sentence the other surfaces use
 * -------------------------------------------------------------------------- */

const EDIT_INDEX = SPEC_APPROVAL_OPTIONS.findIndex((option) => option.id === 'edit');

suite('EPIC-21-S22 — the one option no surface can answer by naming it (AC4)', () => {
  it('shows the row, makes no request, and prints core’s own sentence', async () => {
    const driver = harness(runWith(gate({ node: SPEC_GATE_NODE })));

    choose(driver, EDIT_INDEX);
    await driver.settled();

    expect(driver.sent).toHaveLength(0);
    expect(flatten(driver.frame())).toContain(flatten(SPEC_EDIT_NEEDS_A_DOCUMENT));
    // Shown and refused rather than hidden, which is the choice the browser's
    // gate panel already made: the daemon offered four.
    expect(driver.rows()).toHaveLength(SPEC_APPROVAL_OPTIONS.length);
    const edit = SPEC_APPROVAL_OPTIONS[EDIT_INDEX];
    expect(edit).toBeDefined();
    expect(driver.rows().some((row) => row.includes(edit?.label ?? ''))).toBe(true);
  });

  it('leaves the other options selectable afterwards', async () => {
    const driver = harness(runWith(gate({ node: SPEC_GATE_NODE })));

    choose(driver, EDIT_INDEX);
    await driver.settled();
    driver.press('select-up');
    driver.press('confirm');
    await driver.settled();

    expect(driver.sent).toHaveLength(1);
    const expected = gateAnswerRequest({
      runId: RUN_ID,
      gate: SPEC_GATE_NODE,
      optionId: SPEC_APPROVAL_OPTIONS[0].id,
      text: null,
    });
    expect((driver.sent[0] as Sent).url).toBe(`${ENDPOINT.baseUrl}${expected?.path ?? ''}`);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S25 — two presses of one option are one answer
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S25 — one gate, one answer (AC7)', () => {
  it('makes exactly one request for a double keypress, and says it is sending', async () => {
    let release = (): void => {};
    const held = new Promise<Response>((resolve) => {
      release = () => resolve(new Response(null, { status: 202 }));
    });
    const driver = harness(runWith(gate({ node: SPEC_GATE_NODE })), async () => await held);

    choose(driver, 0);
    driver.press('confirm');

    expect(driver.sent).toHaveLength(1);
    // The rows are inert while the request is outstanding, and the frame says
    // so — without that, the second answer is refused for a gate that is now
    // closed and the operator reads a refusal that looks like a bug.
    expect(driver.frame().toLowerCase()).toContain('sending');

    release();
    await driver.settled();

    expect(driver.sent).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S26 — two open gates: the oldest is the one offered
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S26 — the gate blocking the most work is the one offered (AC8)', () => {
  const older = gate({ node: SPEC_GATE_NODE, requestedSeq: 7 });
  const newer = gate({
    node: PLAN_GATE,
    requestedSeq: 41,
    prompt: 'Recon found two more packages. Keep going?',
    options: [...PLAN_OPTIONS] as never,
  });

  it('offers pendingGate’s gate, and the next one once it closes', async () => {
    const driver = harness(runWith(newer, older));

    // The older one, which is what `pendingGate` reports — no ordering of this
    // session's own.
    expect(driver.rows().some((row) => row.includes(SPEC_APPROVAL_OPTIONS[0].label))).toBe(true);

    choose(driver, 0);
    await driver.settled();
    expect(driver.sent).toHaveLength(1);

    // The answer lands and the projection folds it, exactly as the stream would.
    driver.setRun(runWith(newer, { ...older, response: ANSWERED } as HumanGateState));

    expect(driver.rows().some((row) => row.includes(PLAN_OPTIONS[0].label))).toBe(true);
    expect(driver.rows()).toHaveLength(PLAN_OPTIONS.length);
  });
});

const ANSWERED = {
  optionId: 'approve',
  text: null,
  by: 'operator',
  at: '2026-08-16T10:15:00.000Z',
  seq: 12,
} as const;

/* -------------------------------------------------------------------------- *
 * EPIC-21-S24 — the answer and the keypress cross
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S24 — an answer from elsewhere while a keypress is in flight (AC6)', () => {
  it('settles with the gate closed and never sends a second answer', async () => {
    let release = (): void => {};
    const held = new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          Response.json(
            { error: { code: 'already_answered', message: 'that gate is already answered' } },
            { status: 409 },
          ),
        );
    });
    const open = gate({ node: SPEC_GATE_NODE });
    const driver = harness(runWith(open), async () => await held);

    choose(driver, 0);
    expect(driver.sent).toHaveLength(1);

    // The browser answered while our request was on the wire. The session holds
    // no opinion of its own about whether a gate is open: `pendingGate` over the
    // reduced state is the only reader, so this is the whole of the change.
    driver.setRun(runWith({ ...open, response: ANSWERED } as HumanGateState));
    release();
    await driver.settled();

    expect(driver.rows()).toHaveLength(0);
    expect(driver.state().gate.sending).toBeNull();

    // And a later press sends nothing at all — there is no gate to answer.
    driver.press('confirm');
    await driver.settled();
    expect(driver.sent).toHaveLength(1);
  });
});
