/**
 * KAR-21.4 AC5, AC6, AC9 / EPIC-21-S33, S34 — the daemon owns what an
 * interjection means, the ledger owns what appears on screen, and neither key
 * exists where nothing can press one.
 *
 * A real DeFlowd on an ephemeral port throughout, because every claim here is
 * about something this process does not decide. `planInterjection`'s five
 * refusals are specific advice — `use_respond` names the gate answer that does
 * work — so the assertion is that the daemon's own bytes reach the frame, read
 * off the response the session actually got and never retyped into this spec.
 *
 * The five refusals are reached the way an operator reaches them: a projection
 * that has drifted from the ledger, which is what a frame *is* — a moment
 * behind. Nothing is stubbed to produce a status code.
 *
 * EPIC-21-S34 is the one that proves AC6. The interjection is sent from a
 * session driven by `runRun` over a real socket, and what is asserted is that
 * the transcript line is **byte-identical to `RunRenderer.event`'s output for
 * the `human.interjected` event the ledger holds** — so the session cannot have
 * printed a line of its own, and an interjection posted from anywhere else
 * produces the same line here.
 *
 * Verifies: EPIC-21-S33, EPIC-21-S34 · AC5, AC6, AC9 · test plan #5, #6, #9
 */
import type { Event, NodeId, RunId, RunState } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { appendEvents, readRange, replayRun } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { createHeadlessScreen, type HeadlessScreen } from '../../src/render/screen.ts';
import { createStyle } from '../../src/render/style.ts';
import type { DaemonEndpoint } from '../../src/run/daemon.ts';
import { createRenderer } from '../../src/run/render.ts';
import { runRun } from '../../src/run/run.ts';
import { applyIntent, applyTyping } from '../../src/run/session/actions.ts';
import { createInterjectSession } from '../../src/run/session/interject.ts';
import { openKeyboard, type RawInput } from '../../src/run/session/keyboard.ts';
import type { Intent } from '../../src/run/session/keys.ts';
import { KEY_BINDINGS } from '../../src/run/session/keys.ts';
import { initialSessionState, type SessionState } from '../../src/run/session/state.ts';
import { renderFrame } from '../../src/run/session/view.ts';
import { until } from './support/cli-process.ts';
import {
  completeNode,
  HUMAN_NODE,
  runningNodeRun,
  suspendedOnHumanNode,
} from './support/run-fixture.ts';

const STYLE = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });
const NODE: NodeId = NodeIdSchema.parse('implement');
const RUN: RunId = RunIdSchema.parse('run_20260816T101500Z_0f0f0f');
const GATE_RUN: RunId = RunIdSchema.parse('run_20260816T101500Z_0e0e0e');
const GUIDANCE = 'use the existing helper in utils.ts';

/** Text with every run of whitespace collapsed — the frame wraps every block,
 * so a substring test against the daemon's unwrapped sentence asks the wrong
 * question in both directions. */
const flatten = (text: string): string => text.replaceAll(/\s+/g, ' ');

let tmp = '';
let booted: Booted | undefined;

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  await removeTempDir(tmp);
});

const db = (): Booted['db'] => (booted as Booted).db;

const eventsOf = (runId: RunId): readonly Event[] => readRange(db(), runId, 0, 500).events;

const stateOf = (runId: RunId): RunState => replayRun(db(), runId).state;

/** What the daemon appends when a run finishes — the CLI's cue to exit 0. */
function completeRun(runId: RunId): void {
  appendEvents(db(), [
    {
      runId,
      ts: Date.now(),
      kind: 'run.completed',
      v: 1,
      epoch: (booted as Booted).epoch,
      payload: { outcome: 'succeeded', criteriaSatisfied: [] },
    },
  ]);
}

const headOf = (runId: RunId): number => eventsOf(runId).at(-1)?.seq ?? 0;

function endpointOf(): DaemonEndpoint {
  return {
    baseUrl: `http://127.0.0.1:${String(booted?.port ?? 0)}`,
    token: TEST_DAEMON_TOKEN,
    pid: process.pid,
    autostarted: false,
  };
}

/** A daemon in this process, a repo, and a data dir the CLI can find. */
async function daemon(): Promise<{ dataDir: string; cwd: string }> {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  return { dataDir, cwd: repo.dir };
}

interface Driver {
  press(intent: Intent): void;
  type(text: string): void;
  frame(): string;
  settled(): Promise<void>;
  readonly requests: string[];
  readonly refusals: { code?: string; message?: string }[];
}

/**
 * An interject session over a real daemon, with `fetch` **wrapped** rather than
 * replaced.
 *
 * Every request still goes over the socket; what is recorded is the URL and,
 * for a refusal, the daemon's own envelope — which is what makes "verbatim" an
 * assertion against the bytes that arrived rather than against a sentence this
 * file retyped.
 */
function driverOver(run: RunState, runId: RunId, lastSeq: number): Driver {
  const requests: string[] = [];
  const refusals: { code?: string; message?: string }[] = [];
  let session: SessionState = { ...initialSessionState(), keyboard: true, rows: 40 };

  const interject = createInterjectSession({
    runId,
    endpoint: endpointOf(),
    run: () => run,
    state: () => session,
    onState: (next) => {
      session = next;
    },
    lastSeq: () => lastSeq,
    fetch: async (input, init) => {
      requests.push(String(input));
      const response = await globalThis.fetch(input as never, init as never);
      if (!response.ok) {
        const body = (await response.clone().json()) as {
          error?: { code?: string; message?: string };
        };
        refusals.push(body.error ?? {});
      }
      return response;
    },
  });

  return {
    press: (intent) => {
      if (interject.handle(intent)) return;
      session = applyIntent(session, intent).state;
    },
    type: (text) => {
      session = applyTyping(session, text);
    },
    frame: () => renderFrame(run, session, STYLE).join('\n'),
    settled: () => interject.settled(),
    requests,
    refusals,
  };
}

/**
 * The projection as this session has it: `node` running and nothing else.
 *
 * A frame is a moment behind the ledger by construction, and this is that drift
 * written down — which is the only way a session can reach four of the five
 * refusals, and is exactly how an operator reaches them too.
 */
function claiming(runId: RunId, node: string): RunState {
  const real = stateOf(runId);
  const nodes = Object.fromEntries(
    Object.entries(real.nodes).map(([id, one]) => [id, { ...one, status: 'completed' as const }]),
  );
  return {
    ...real,
    nodes: { ...nodes, [node]: { ...(real.nodes[node] ?? runningShape()), status: 'running' } },
  } as RunState;
}

function runningShape(): RunState['nodes'][string] {
  return {
    status: 'running',
    attempt: 1,
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
    startedTs: 1,
    updatedSeq: 1,
  };
}

/* -------------------------------------------------------------------------- *
 * EPIC-21-S33 — five different problems are five different sentences
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S33 — every refusal is shown in the daemon’s own words (AC5)', () => {
  it('shows node_not_found for a node the run never had', async () => {
    const { cwd } = await daemon();
    runningNodeRun(NODE, {
      db: db(),
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
      runId: RUN,
    });

    // A projection naming a node the ledger does not — well-formed as an id, so
    // this is the daemon's *"no such node"* rather than its "that is not a node
    // id at all", which is a different refusal about a different mistake.
    const driver = driverOver(claiming(RUN, 'ghost-node'), RUN, headOf(RUN));
    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(driver.refusals[0]?.code).toBe('node_not_found');
    expect(flatten(driver.frame())).toContain(flatten(driver.refusals[0]?.message as string));
  }, 60_000);

  it('shows node_not_running for a node that has finished', async () => {
    const { cwd } = await daemon();
    const at = { db: db(), epoch: (booted as Booted).epoch, ts: Date.now(), cwd, runId: RUN };
    runningNodeRun(NODE, at);
    completeNode(NODE, at);

    // The cursor is current, so the daemon gets past its stale-cursor check and
    // answers about the node's own state — which is what this row is about.
    const driver = driverOver(claiming(RUN, NODE), RUN, headOf(RUN));
    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(driver.refusals[0]?.code).toBe('node_not_running');
    expect(flatten(driver.frame())).toContain(flatten(driver.refusals[0]?.message as string));
  }, 60_000);

  it('shows stale_cursor when the node moved after the seq the frame was painted at', async () => {
    const { cwd } = await daemon();
    const at = { db: db(), epoch: (booted as Booted).epoch, ts: Date.now(), cwd, runId: RUN };
    runningNodeRun(NODE, at);
    const painted = headOf(RUN);
    completeNode(NODE, at);

    const driver = driverOver(claiming(RUN, NODE), RUN, painted);
    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(driver.refusals[0]?.code).toBe('stale_cursor');
    expect(flatten(driver.frame())).toContain(flatten(driver.refusals[0]?.message as string));
  }, 60_000);

  it('shows empty_text for a row confirmed with nothing in it', async () => {
    const { cwd } = await daemon();
    runningNodeRun(NODE, {
      db: db(),
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
      runId: RUN,
    });

    const driver = driverOver(claiming(RUN, NODE), RUN, headOf(RUN));
    driver.press('interject');
    driver.press('confirm');
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(driver.refusals[0]?.code).toBe('empty_text');
    expect(flatten(driver.frame())).toContain(flatten(driver.refusals[0]?.message as string));
  }, 60_000);

  it('shows use_respond on a suspended human node, and answers no gate itself', async () => {
    const { cwd } = await daemon();
    await suspendedOnHumanNode({
      db: db(),
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
      runId: GATE_RUN,
    });

    const driver = driverOver(claiming(GATE_RUN, HUMAN_NODE), GATE_RUN, headOf(GATE_RUN));
    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(driver.refusals[0]?.code).toBe('use_respond');
    // The daemon's own remedy, verbatim — it names the route that answers a
    // gate, which is the thing KAR-21.3 built and is one key away.
    expect(flatten(driver.frame())).toContain(flatten(driver.refusals[0]?.message as string));
    // And the session did not silently convert the interjection into an answer.
    expect(eventsOf(GATE_RUN).map((event) => event.kind)).not.toContain('human.responded');
  }, 60_000);

  it('appends nothing at all for any of them, and never retries', async () => {
    const { cwd } = await daemon();
    const at = { db: db(), epoch: (booted as Booted).epoch, ts: Date.now(), cwd, runId: RUN };
    runningNodeRun(NODE, at);
    completeNode(NODE, at);
    const before = eventsOf(RUN).length;

    const driver = driverOver(claiming(RUN, NODE), RUN, headOf(RUN));
    driver.press('interject');
    driver.type(GUIDANCE);
    driver.press('confirm');
    await driver.settled();
    // A moment for a retry to have happened, had there been one.
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(eventsOf(RUN)).toHaveLength(before);
  }, 60_000);
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S34 — the screen shows what happened, not what was attempted
 * -------------------------------------------------------------------------- */

/** A stdin that records rather than a mocked module. */
function fakeStdin(): { input: RawInput; emit: (chunk: string) => void; opened: () => number } {
  const listeners: ((chunk: string) => void)[] = [];
  let opens = 0;
  return {
    opened: () => opens,
    emit: (chunk) => {
      for (const listener of [...listeners]) listener(chunk);
    },
    input: {
      setRawMode: () => {
        opens += 1;
      },
      setEncoding: () => {},
      on: (_event, listener) => listeners.push(listener),
      off: (_event, listener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      resume: () => {},
      pause: () => {},
    },
  };
}

const sequenceFor = (intent: string): string =>
  KEY_BINDINGS.find((binding) => binding.intent === intent)?.sequence ?? '';

const framesOf = (screen: HeadlessScreen): string =>
  screen.frames.map((frame) => frame.join('\n')).join('\n---\n');

/** How many times `needle` occurs in `haystack`. */
const occurrences = (haystack: string, needle: string): number =>
  needle === '' ? 0 : haystack.split(needle).length - 1;

suite('EPIC-21-S34 — an interjection appears when the ledger has it (AC6)', () => {
  it('renders it through RunRenderer.event, once, and prints no line of its own', async () => {
    const { dataDir, cwd } = await daemon();
    runningNodeRun(NODE, {
      db: db(),
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
      runId: RUN,
    });

    const screen = createHeadlessScreen();
    const stdin = fakeStdin();
    const out: string[] = [];

    const watching = runRun({
      argv: ['--attach', RUN],
      cwd,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      isTty: () => true,
      stdinIsTty: true,
      style: STYLE,
      openScreen: () => screen,
      openKeyboard: (options) =>
        openKeyboard({ ...options, stdin: stdin.input, onSignal: () => () => {} }),
    });

    await until('the running node reached the frame', () =>
      framesOf(screen).includes(NODE) ? true : null,
    );

    // Typed the way an operator types it: a key, then characters, then Enter.
    stdin.emit(sequenceFor('interject'));
    stdin.emit(GUIDANCE);
    stdin.emit(sequenceFor('confirm'));

    // The transcript stays silent until the event arrives on the stream — this
    // is the wait that would time out if the session printed its own line
    // *after* the ledger, and the byte comparison below is what catches one
    // printed before it.
    // Flattened, because a transcript line wraps under itself at 80 columns
    // (KAR-18.9 AC4) — an unflattened substring test would fail on a line that
    // printed perfectly.
    await until('the interjection reached the transcript', () =>
      flatten(out.join('')).includes(flatten(GUIDANCE)) ? true : null,
    );

    const interjected = eventsOf(RUN).filter((event) => event.kind === 'human.interjected');
    expect(interjected).toHaveLength(1);

    // AC6 — the line is the existing transcript renderer's, byte for byte. A
    // session that had written its own sentence would differ here even if it
    // contained the same words.
    const renderer = createRenderer({
      mode: 'human',
      isTty: () => false,
      runId: RUN,
      baseUrl: endpointOf().baseUrl,
      style: STYLE,
    });
    const expected = renderer.event(interjected[0] as Event);
    expect(expected).not.toBe('');
    expect(out.join('')).toContain(expected);
    // Exactly one line about it: nothing optimistic went out before, and
    // nothing was rendered twice after.
    expect(occurrences(out.join(''), expected)).toBe(1);

    // The frame said what the *request* did, which is a different claim from
    // what the ledger holds — and it is the daemon's answer, not a guess.
    //
    // Waited for rather than read on the spot, because the two claims travel by
    // different routes and neither orders the other: the transcript line above
    // came off the event stream, and the delivery comes off the POST's own 202.
    // The daemon appends before it answers, so on a machine slow enough for the
    // stream to win the race the frame has not been told yet — which is what
    // made this spec intermittent whenever the box was loaded. The wait is the
    // assertion: it throws with this sentence if the delivery never lands.
    await until('the frame to report the delivery the daemon answered', () =>
      framesOf(screen).includes('queued') ? true : null,
    );

    // An interjection made anywhere else produces the same line here, because
    // the line is derived from the event rather than from what this session
    // did. This one is posted the way the browser would post it.
    const posted = await globalThis.fetch(`${endpointOf().baseUrl}/api/runs/${RUN}/interject`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_DAEMON_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ nodeId: NODE, text: 'and from the browser', mode: 'next-turn' }),
    });
    expect(posted.status).toBe(202);

    await until('the second interjection reached the transcript', () =>
      flatten(out.join('')).includes('and from the browser') ? true : null,
    );

    const both = eventsOf(RUN).filter((event) => event.kind === 'human.interjected');
    expect(both).toHaveLength(2);
    expect(out.join('')).toContain(renderer.event(both[1] as Event));

    completeNode(NODE, { db: db(), epoch: (booted as Booted).epoch, ts: Date.now(), runId: RUN });
    completeRun(RUN);

    expect(await watching).toBe(0);
  }, 120_000);
});

/* -------------------------------------------------------------------------- *
 * AC9 — neither key exists where nothing can press one
 * -------------------------------------------------------------------------- */

suite('KAR-21.4 AC9 — no verb is reachable without a keyboard', () => {
  it('opens no keyboard under --json, and the bytes reach nothing', async () => {
    const { dataDir, cwd } = await daemon();
    runningNodeRun(NODE, {
      db: db(),
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
      runId: RUN,
    });

    completeRun(RUN);

    const stdin = fakeStdin();
    let keyboards = 0;
    let screens = 0;
    const out: string[] = [];

    const exitCode = await runRun({
      argv: ['--json', '--attach', RUN],
      cwd,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      isTty: () => true,
      // Even with a terminal on stdin: `--json`'s consumer is a parser.
      stdinIsTty: true,
      style: STYLE,
      openScreen: () => {
        screens += 1;
        return createHeadlessScreen();
      },
      openKeyboard: (options) => {
        keyboards += 1;
        return openKeyboard({ ...options, stdin: stdin.input, onSignal: () => () => {} });
      },
    });

    expect(keyboards).toBe(0);
    expect(screens).toBe(0);
    expect(stdin.opened()).toBe(0);
    expect(exitCode).toBe(0);

    // The keys nothing subscribed to, pressed anyway: no row, no request, and
    // no interjection in the ledger.
    stdin.emit(`${sequenceFor('interject')}${GUIDANCE}${sequenceFor('confirm')}`);
    stdin.emit(`${sequenceFor('cancel')}y${sequenceFor('confirm')}`);

    expect(eventsOf(RUN).map((event) => event.kind)).not.toContain('human.interjected');
    // And the stream stayed machine-readable: every line is one JSON object.
    for (const line of out
      .join('')
      .split('\n')
      .filter((one) => one !== '')) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S36 — you get to see how it ended
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S36 — a confirmed cancel keeps the screen until the run ends (AC7, AC8)', () => {
  it('cancels through cancelRun and renders the run’s own ending afterwards', async () => {
    const { dataDir, cwd } = await daemon();
    runningNodeRun(NODE, {
      db: db(),
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
      runId: RUN,
    });

    const screen = createHeadlessScreen();
    const stdin = fakeStdin();
    const out: string[] = [];

    const watching = runRun({
      argv: ['--attach', RUN],
      cwd,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      isTty: () => true,
      stdinIsTty: true,
      style: STYLE,
      openScreen: () => screen,
      openKeyboard: (options) =>
        openKeyboard({ ...options, stdin: stdin.input, onSignal: () => () => {} }),
    });

    await until('the running node reached the frame', () =>
      framesOf(screen).includes(NODE) ? true : null,
    );

    // A bare Enter first: the default is no, and the run is still running after
    // it — which is what makes the second answer below a decision rather than a
    // formality.
    stdin.emit(sequenceFor('cancel'));
    await until('the confirmation named the run', () =>
      framesOf(screen).includes(`cancel run ${RUN}`) ? true : null,
    );
    stdin.emit(sequenceFor('confirm'));
    await until('the confirmation closed', () =>
      (screen.frames.at(-1) ?? []).join('\n').includes('cancel run ') ? null : true,
    );
    expect(eventsOf(RUN).map((event) => event.kind)).not.toContain('run.cancel.requested');

    // …and then the answer that means it.
    stdin.emit(sequenceFor('cancel'));
    stdin.emit('y');
    stdin.emit(sequenceFor('confirm'));

    // AC8 — what `cancelRun` returned, in the frame, and the screen still up.
    await until('the cancel outcome reached the frame', () =>
      flatten(framesOf(screen)).includes(`cancelling run ${RUN}`) ? true : null,
    );

    // The daemon's kill switch ends the run, and this session is still watching
    // when it does: the terminal event is rendered here, by the transcript
    // renderer, before the verdict. A session that had exited at the moment of
    // the decision could not have printed either.
    const exitCode = await watching;
    const aborted = eventsOf(RUN).find((event) => event.kind === 'run.aborted');
    expect(aborted).toBeDefined();

    const renderer = createRenderer({
      mode: 'human',
      isTty: () => false,
      runId: RUN,
      baseUrl: endpointOf().baseUrl,
      style: STYLE,
    });
    expect(out.join('')).toContain(renderer.event(aborted as Event));
    expect(exitCode).not.toBe(0);
  }, 120_000);
});
