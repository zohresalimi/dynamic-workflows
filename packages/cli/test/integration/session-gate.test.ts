/**
 * KAR-21.3 AC5, AC6, AC9 / EPIC-21-S23, S24, S27 — the daemon owns what an
 * answer means, the ledger owns whether a gate is open, and `--json` is not an
 * application.
 *
 * A real daemon on a real socket throughout, because every claim here is about
 * something this process does not decide. `planHumanResponse`'s refusal is
 * several sentences of specific advice; a local rewording throws the advice
 * away while looking tidier, so the assertion is that the daemon's own bytes
 * reach the frame — read off the response the session actually got, never
 * retyped into this spec.
 *
 * Verifies: EPIC-21-S23, EPIC-21-S24, EPIC-21-S27 · AC5, AC6, AC9 · test plan
 * #6, #7, #10
 */
import type { Event, RunId, RunState } from '@DeFlow/core';
import { initialRunState, pendingGate, RunIdSchema, SPEC_GATE_NODE } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { readRange, replayRun } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runAnswer } from '../../src/answer.ts';
import { createHeadlessScreen, type HeadlessScreen } from '../../src/render/screen.ts';
import { createStyle } from '../../src/render/style.ts';
import type { DaemonEndpoint } from '../../src/run/daemon.ts';
import { runRun } from '../../src/run/run.ts';
import { applyIntent } from '../../src/run/session/actions.ts';
import { createGateSession } from '../../src/run/session/gate.ts';
import { openKeyboard, type RawInput } from '../../src/run/session/keyboard.ts';
import { KEY_BINDINGS } from '../../src/run/session/keys.ts';
import { initialSessionState, type SessionState } from '../../src/run/session/state.ts';
import { gateOptionRows, renderFrame } from '../../src/run/session/view.ts';
import { until } from './support/cli-process.ts';
import {
  framedRun,
  HUMAN_NODE,
  HUMAN_NODE_OPTIONS,
  suspendedOnHumanNode,
} from './support/run-fixture.ts';

const STYLE = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });

/**
 * Text with every run of whitespace collapsed to one space.
 *
 * The frame wraps every block it prints, so a refusal several sentences long
 * arrives across four indented lines. A substring test against the daemon's
 * unwrapped sentence would fail on a frame that showed it perfectly, which is
 * the wrong question; flattening asks whether those words, in that order, are
 * on screen.
 */
const flatten = (text: string): string => text.replaceAll(/\s+/g, ' ');
const PLAN_GATE_RUN: RunId = RunIdSchema.parse('run_20260816T101500Z_0c0c0c');
const SPEC_GATE_RUN: RunId = RunIdSchema.parse('run_20260816T101500Z_0e0e0e');

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

const eventsOf = (runId: RunId): readonly Event[] =>
  booted === undefined ? [] : readRange(booted.db, runId, 0, 200).events;

const stateOf = (runId: RunId): RunState =>
  booted === undefined ? initialRunState() : replayRun(booted.db, runId).state;

function endpointOf(): DaemonEndpoint {
  const port = booted?.port ?? 0;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
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
  press(intent: 'answer' | 'select-up' | 'select-down' | 'confirm' | 'dismiss'): void;
  frame(): string;
  rows(): readonly string[];
  settled(): Promise<void>;
  readonly refusals: { code?: string; message?: string }[];
  readonly requests: string[];
  setRun(next: RunState): void;
}

/**
 * A gate session over a real daemon, with `fetch` wrapped rather than replaced.
 *
 * Every request still goes over the socket; what is recorded is the URL and,
 * for a refusal, the daemon's own envelope — which is what makes "verbatim" an
 * assertion against the bytes that arrived rather than against a sentence this
 * file retyped.
 */
function driverOver(run: RunState, runId: RunId): Driver {
  const requests: string[] = [];
  const refusals: { code?: string; message?: string }[] = [];
  let current = run;
  let session: SessionState = { ...initialSessionState(), keyboard: true, rows: 40 };

  const gateSession = createGateSession({
    runId,
    endpoint: endpointOf(),
    run: () => current,
    state: () => session,
    onState: (next) => {
      session = next;
    },
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
      // `run/run.ts`'s router: the gate is offered the key first, and what it
      // does not claim falls through to the one `SESSION_ACTIONS` table.
      if (gateSession.handle(intent)) return;
      session = applyIntent(session, intent).state;
    },
    frame: () => renderFrame(current, session, STYLE).join('\n'),
    rows: () => {
      const open = pendingGate(current);
      return open === null ? [] : gateOptionRows(open, session, STYLE);
    },
    settled: () => gateSession.settled(),
    refusals,
    requests,
    setRun: (next) => {
      current = next;
    },
  };
}

/* -------------------------------------------------------------------------- *
 * EPIC-21-S23 — the daemon's refusal is the words the operator reads, once
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S23 — a refusal is forwarded, never paraphrased and never retried (AC5)', () => {
  it('shows planHumanResponse’s own sentence for an option the plan never offered', async () => {
    const { cwd } = await daemon();
    await suspendedOnHumanNode({
      db: (booted as Booted).db,
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
      runId: PLAN_GATE_RUN,
    });

    // The frame is, by construction, a moment behind the ledger. A gate whose
    // projected option set has drifted from the plan's is exactly how a surface
    // comes to offer an option the daemon will refuse — and the daemon, not a
    // second validator here, is what refuses it.
    const real = stateOf(PLAN_GATE_RUN);
    const open = real.humanGates[HUMAN_NODE];
    expect(open).toBeDefined();
    const drifted: RunState = {
      ...real,
      humanGates: {
        [HUMAN_NODE]: {
          ...(open as NonNullable<typeof open>),
          options: [
            ...(open as NonNullable<typeof open>).options,
            { id: 'demolish', label: 'Tear it all down', effect: 'reject' },
          ],
        },
      },
    } as RunState;

    const driver = driverOver(drifted, PLAN_GATE_RUN);
    driver.press('answer');
    for (let step = 0; step < HUMAN_NODE_OPTIONS.length; step += 1) driver.press('select-down');
    driver.press('confirm');
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(driver.refusals).toHaveLength(1);
    const message = driver.refusals[0]?.message;
    expect(typeof message).toBe('string');
    // Verbatim: the daemon's bytes, off the response this session received.
    expect(flatten(driver.frame())).toContain(flatten(message as string));

    // No retry, no re-send, and the gate is still there to be answered properly.
    expect(driver.rows().length).toBeGreaterThan(0);
    expect(eventsOf(PLAN_GATE_RUN).map((event) => event.kind)).not.toContain('human.responded');
  }, 60_000);

  it('shows the 409 for a gate somebody already answered, and does not re-send', async () => {
    const { cwd, dataDir } = await daemon();
    framedRun(SPEC_GATE_RUN, {
      db: (booted as Booted).db,
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
    });

    // The gate as this session saw it a moment ago…
    const before = stateOf(SPEC_GATE_RUN);
    expect(pendingGate(before)).not.toBeNull();

    // …and somebody else answering it from another terminal.
    const answered = await runAnswer({
      argv: [SPEC_GATE_RUN, '--gate', SPEC_GATE_NODE, '--option', 'approve'],
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
    });
    expect(answered.exitCode, answered.stderr).toBe(0);

    const driver = driverOver(before, SPEC_GATE_RUN);
    driver.press('answer');
    driver.press('confirm');
    await driver.settled();

    expect(driver.requests).toHaveLength(1);
    expect(driver.refusals).toHaveLength(1);
    expect(flatten(driver.frame())).toContain(flatten(driver.refusals[0]?.message as string));

    // One `human.responded`, from the terminal that got there first.
    const responded = eventsOf(SPEC_GATE_RUN).filter((event) => event.kind === 'human.responded');
    expect(responded).toHaveLength(1);
  }, 60_000);
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S24 — a gate answered elsewhere closes the prompt here
 * -------------------------------------------------------------------------- */

/** A stdin that records rather than a mocked module. */
function fakeStdin(): { input: RawInput; emit: (chunk: string) => void } {
  const listeners: ((chunk: string) => void)[] = [];
  return {
    emit: (chunk) => {
      for (const listener of [...listeners]) listener(chunk);
    },
    input: {
      setRawMode: () => {},
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
  screen.frames.map((f) => f.join('\n')).join('\n---\n');

suite('EPIC-21-S24 — the answer arrives from somewhere else (AC6)', () => {
  it('closes the prompt from the stream, and a later keypress sends nothing', async () => {
    const { cwd, dataDir } = await daemon();
    framedRun(SPEC_GATE_RUN, {
      db: (booted as Booted).db,
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
    });

    const screen = createHeadlessScreen();
    const stdin = fakeStdin();
    const out: string[] = [];

    const watching = runRun({
      argv: ['--attach', SPEC_GATE_RUN],
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

    // The options are on screen and the keyboard is aimed at them.
    await until('the gate reached the frame', () =>
      framesOf(screen).includes('spec') ? true : null,
    );
    stdin.emit(sequenceFor('answer'));
    await until('the options were offered', () =>
      framesOf(screen).includes('Approve this spec and start planning') ? true : null,
    );

    // Answered from a second terminal, exactly as the browser would.
    const elsewhere = await runAnswer({
      argv: [SPEC_GATE_RUN, '--gate', SPEC_GATE_NODE, '--option', 'approve'],
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
    });
    expect(elsewhere.exitCode, elsewhere.stderr).toBe(0);

    // The prompt closes because the projection says the gate closed — the
    // `human.responded` frame on the stream the session is already following.
    await until('the prompt closed', () => {
      const last = (screen.frames.at(-1) ?? []).join('\n');
      return last.includes('Approve this spec and start planning') ? null : true;
    });

    // And a later selection sends nothing: there is no gate to answer.
    stdin.emit(sequenceFor('confirm'));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const responded = eventsOf(SPEC_GATE_RUN).filter((event) => event.kind === 'human.responded');
    expect(responded).toHaveLength(1);

    stdin.emit(sequenceFor('interrupt'));
    await watching;
  }, 90_000);
});

/* -------------------------------------------------------------------------- *
 * EPIC-21-S27 — --json answers nothing, reads nothing, and does not block
 * -------------------------------------------------------------------------- */

suite('EPIC-21-S27 — the machine-readable stream is not an application (AC9)', () => {
  it('opens no screen, no keyboard, and emits the gate object unchanged', async () => {
    const { cwd, dataDir } = await daemon();
    framedRun(SPEC_GATE_RUN, {
      db: (booted as Booted).db,
      epoch: (booted as Booted).epoch,
      ts: Date.now(),
      cwd,
    });

    let screens = 0;
    let keyboards = 0;
    const out: string[] = [];
    const err: string[] = [];

    // If any of this blocked on a keypress, the await below would never return
    // and the spec would time out — which is the whole of "does not block".
    await runRun({
      argv: ['--json', '--no-wait', '--attach', SPEC_GATE_RUN],
      cwd,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => err.push(chunk),
      isTty: () => false,
      stdinIsTty: false,
      style: STYLE,
      openScreen: () => {
        screens += 1;
        return createHeadlessScreen();
      },
      openKeyboard: (options) => {
        keyboards += 1;
        return openKeyboard({ ...options, stdin: fakeStdin().input, onSignal: () => () => {} });
      },
    });

    expect(screens).toBe(0);
    expect(keyboards).toBe(0);

    // stdout is a seq-ordered stream of events, one per line, each parsing.
    for (const line of out
      .join('')
      .split('\n')
      .filter((line) => line !== '')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // …and the announcement is on stderr, exactly as run/render.ts emits it.
    const announcement = err
      .join('')
      .split('\n')
      .map((line) => (line === '' ? null : (JSON.parse(line) as { kind?: string })))
      .find((value) => value?.kind === 'DeFlow.cli.gate');
    expect(announcement).toMatchObject({
      kind: 'DeFlow.cli.gate',
      runId: SPEC_GATE_RUN,
      node: SPEC_GATE_NODE,
      specApproval: true,
    });
  }, 60_000);
});
