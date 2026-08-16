/**
 * KAR-21.2 AC3, AC6, AC7 / EPIC-21-S17 — an environment with no keyboard is not
 * asked for keys, and the one that has a keyboard is told which keys it has.
 *
 * Both halves in one file on purpose. `setRawMode` on a non-TTY throws, so the
 * failure this guards is not cosmetic — it is `deflow run` dying at startup in
 * CI — and the way that regression arrives is somebody making the interactive
 * path work and never running the other one. The hint-line clause is separate
 * because it is a different, smaller failure: printing a list of keys into a
 * log where no key can be pressed is still a lie.
 *
 * The pipe assertions come first, and one of them is the strong form: not "no
 * key was read" but **no keyboard was constructed at all**, which is the same
 * claim EPIC-21-S08 makes about the screen and for the same reason. A keyboard
 * that reads nothing because every read happens to be guarded is one forgotten
 * guard away from calling `setRawMode` on a pipe.
 *
 * Verifies: EPIC-21-S17 · AC3, AC6, AC7 · test plan #17
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { appendEvents } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { createHeadlessScreen, type HeadlessScreen } from '../../src/render/screen.ts';
import { createStyle } from '../../src/render/style.ts';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { runRun } from '../../src/run/run.ts';
import { openKeyboard, type RawInput } from '../../src/run/session/keyboard.ts';
import { KEY_BINDINGS } from '../../src/run/session/keys.ts';
import { keyHintLine } from '../../src/run/session/view.ts';
import { spawnRun, until } from './support/cli-process.ts';
import { framedRun, openSpecGate, waitForRun } from './support/run-fixture.ts';

const RUN_ID = RunIdSchema.parse('run_20260816T101500Z_0d0d0d');
const STYLE = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });

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

/** A daemon in this process and a run parked at the F1.3 gate. */
async function watchableRun(): Promise<{ dataDir: string; cwd: string }> {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  booted = await boot({ dataDir, port: 0, dev: false });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  framedRun(RUN_ID, { db: booted.db, epoch: booted.epoch, ts: Date.now(), cwd: repo.dir });
  return { dataDir, cwd: repo.dir };
}

function completeRun(): void {
  appendEvents(
    booted?.db as never,
    [
      {
        runId: RUN_ID,
        ts: Date.now(),
        kind: 'run.completed',
        v: 1,
        epoch: booted?.epoch ?? 1,
        payload: { outcome: 'succeeded', criteriaSatisfied: [] },
      },
    ] as never,
  );
}

/** A stdin that records rather than a mocked module. */
function fakeStdin(): { input: RawInput; emit: (chunk: string) => void; rawMode: boolean[] } {
  const rawMode: boolean[] = [];
  const listeners: ((chunk: string) => void)[] = [];
  return {
    rawMode,
    emit: (chunk) => {
      for (const listener of [...listeners]) listener(chunk);
    },
    input: {
      setRawMode: (raw) => rawMode.push(raw),
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

const lastFrame = (screen: HeadlessScreen): string => (screen.frames.at(-1) ?? []).join('\n');

/**
 * Text with every run of whitespace collapsed to one space.
 *
 * The hint line names seven keys and is 96 columns wide, so at the 80-column
 * default the frame wraps it — `esc dismiss` arrives as `esc`, a newline and an
 * indented `dismiss`. That is correct: `renderFrame` wraps it like every other
 * block and counts both rows against the frame's budget, and at 40 columns
 * KAR-21.5 will wrap it further still.
 *
 * It does mean a substring test against the unwrapped line answers the wrong
 * question in **both** directions — the positive one fails on a frame that
 * printed the hint correctly, and, worse, the negative ones pass on output that
 * printed the whole hint. Flattening asks what these assertions actually mean:
 * are these keys, in this order, named here?
 */
const flatten = (text: string): string => text.replaceAll(/\s+/g, ' ');

suite('EPIC-21-S17 — stdin is not a TTY (AC3, AC6)', () => {
  it('constructs no keyboard at all, and never calls setRawMode', async () => {
    const { dataDir, cwd } = await watchableRun();
    const stdin = fakeStdin();
    let opened = 0;

    const out: string[] = [];
    const exitCode = await runRun({
      argv: ['--no-wait', '--attach', RUN_ID],
      cwd,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      // stdout is a terminal; stdin is not. The two decisions are separate and
      // this is the case that proves it — a keyboard derived from `isTty` would
      // open here and call `setRawMode` on a pipe.
      isTty: () => true,
      style: STYLE,
      stdinIsTty: false,
      openScreen: () => createHeadlessScreen(),
      openKeyboard: (options) => {
        opened += 1;
        return openKeyboard({ ...options, stdin: stdin.input, onSignal: () => () => {} });
      },
    });

    expect(opened).toBe(0);
    expect(stdin.rawMode).toEqual([]);
    expect(exitCode).toBe(RUN_EXIT_CODES.awaitingHuman);
  }, 60_000);

  it('prints no key-hint line, because nothing can press those keys', async () => {
    const { dataDir, cwd } = await watchableRun();
    const screen = createHeadlessScreen();

    const out: string[] = [];
    await runRun({
      argv: ['--no-wait', '--attach', RUN_ID],
      cwd,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      isTty: () => true,
      style: STYLE,
      stdinIsTty: false,
      openScreen: () => screen,
    });

    const everything = flatten([out.join(''), ...screen.frames.flat()].join('\n'));

    expect(everything).not.toContain(flatten(keyHintLine(STYLE)));
    // Per binding rather than per word. A word-by-word ban reads stronger and is
    // in fact wrong: `deflow run` has printed "Ctrl-C detaches" since KAR-18.3,
    // so banning every long word of the hint line fails on output that contains
    // no hint at all. A `<label> <describe>` pair is what a hint line is made of
    // and appears nowhere else, so a half-printed hint is still caught — and
    // flattened, because the wrap lands between a label and its describe.
    for (const binding of KEY_BINDINGS) {
      expect(everything).not.toContain(`${binding.label} ${binding.describe}`);
    }
  }, 60_000);

  it('runs to its own verdict through a real process with stdin closed', async () => {
    // The end-to-end form of the same claim, and the only one that exercises the
    // real `process.stdin`: a real `deflow run`, stdin `ignore`d, stdout on a
    // file. `setRawMode` on a non-TTY throws, so if the guard were missing this
    // would exit non-zero having rendered nothing — which is precisely `deflow
    // run` dying at startup in CI.
    //
    // A run started the ordinary way rather than `--attach`: a spawned
    // `deflow run --no-wait --attach <id>` prints its verdict and then never
    // exits, on master as well as here, so attaching would hang this spec on a
    // defect that is not this story's. Nothing about AC6 needs `--attach` — what
    // it needs is a real process with no keyboard reaching its own verdict.
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    booted = await boot({ dataDir, port: 0, dev: false });
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const out = join(tmp, 'run.txt');
    const fd = openSync(out, 'w');
    const cli = spawnRun({
      dataDir,
      cwd: repo.dir,
      args: ['--no-wait', 'add a health endpoint'],
      env: { LANG: 'en_US.UTF-8' },
      stdoutFd: fd,
    });

    const started = await waitForRun(booted.db);
    await until('the CLI to subscribe', () =>
      readFileSync(out, 'utf8').includes('task') ? true : null,
    );
    openSpecGate(RunIdSchema.parse(started), {
      db: booted.db,
      epoch: booted.epoch,
      ts: Date.now(),
    });

    const exit = await cli.exited;
    closeSync(fd);
    const text = readFileSync(out, 'utf8');

    expect(exit.code).toBe(RUN_EXIT_CODES.awaitingHuman);
    expect(text).toContain(started);
    // Flattened, because the hint wraps at 80 columns: a `not.toContain` of the
    // unwrapped line would pass against output that printed the hint in full.
    expect(flatten(text)).not.toContain(flatten(keyHintLine(STYLE)));
  }, 120_000);
});

suite('a terminal that does have a keyboard is told which keys it has (AC6, AC7)', () => {
  it('names the keys in the frame, moves on a key, and ignores an unbound one', async () => {
    const { dataDir, cwd } = await watchableRun();
    const stdin = fakeStdin();
    const screen = createHeadlessScreen();
    let opened = 0;

    const pending = runRun({
      argv: ['--attach', RUN_ID],
      cwd,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: () => {},
      stderr: () => {},
      isTty: () => true,
      style: STYLE,
      stdinIsTty: true,
      openScreen: () => screen,
      openKeyboard: (options) => {
        opened += 1;
        return openKeyboard({ ...options, stdin: stdin.input, onSignal: () => () => {} });
      },
    });

    await until('the frame to be painted', () => (screen.frames.length > 0 ? true : null));

    expect(opened).toBe(1);
    expect(stdin.rawMode).toEqual([true]);
    // AC6's other half, stated positively: the hint line is printed exactly
    // where the keys work — every key, in the decoder's order.
    expect(flatten(lastFrame(screen))).toContain(flatten(keyHintLine(STYLE)));

    // AC7 — an unrecognised key does nothing at all, including no repaint.
    const beforeUnbound = screen.frames.length;
    stdin.emit('Z');
    await until('a moment to pass', () => true);
    expect(screen.frames.length).toBe(beforeUnbound);

    // …and a bound one does: the interjection row opens. `interject:` rather
    // than `interject`, because the hint line asserted above names the key by
    // that word and the shorter string would match a frame with nothing open.
    stdin.emit('i');
    await until('the interjection row to open', () =>
      lastFrame(screen).includes('interject:') ? true : null,
    );

    completeRun();

    expect(await pending).toBe(0);
    // The frame came down and the terminal went back, on the normal path.
    expect(stdin.rawMode).toEqual([true, false]);
  }, 60_000);
});
