/**
 * KAR-21.5 AC3, AC4, AC7, AC8 / EPIC-21-S39, S40, S43, S44 — the ladder, on a
 * real terminal.
 *
 * The unit specs settle the decisions: `degrade.test.ts` pins which environment
 * gets a frame, `session.test.ts` pins the coalescing and the re-layout, and
 * `keyboard.test.ts` pins that the frame is erased wherever the terminal is
 * given back. What none of them can settle is whether those decisions are
 * actually reached by the shipped binary in an environment it will meet — and
 * that is exactly the gap EPIC-19 exists because of. So these four run the real
 * `deflow run` on a **real pty**, at the three sizes the epic's Definition of
 * Done names, and assert what the terminal received.
 *
 * The pty is opened with the command directly on it rather than through a
 * shell. A shell echoes the command line it was handed, and half of what is
 * asserted here is the *absence* of bytes — an assertion a shell's own output
 * would quietly satisfy or quietly spoil. `session-keys-pty.test.ts` keeps the
 * shell, because its question is what the terminal looked like after the child
 * had gone, and that needs a witness the child outlives.
 *
 * The sentences are imported from the module that prints them rather than
 * retyped, for the reason `session-keys-pty.test.ts` imports `NOTHING_RUNNING`:
 * a spec that spells its own copy of a message passes on the day the message
 * changes and the operator's terminal starts saying something else.
 *
 * > **Amended 2026-08-16, while repairing KAR-21.5.** These four were
 * > intermittent: on a loaded machine one of them — a different one each time —
 * > hung to its full timeout, and three neighbouring files this story does not
 * > touch went red beside it. The cause was neither here nor timing. Each spec
 * > appends `run.completed` the moment the CLI's first line reaches the
 * > terminal, and when the machine is slow enough that the append lands
 * > *inside* the CLI's hydrate, the command reaches its verdict before
 * > `followRun` has handed the connection back — which `run.ts` then closed
 * > through a binding still holding `null`. The socket stayed open, the process
 * > never exited, and one two-minute hang starved the whole slice. That is a
 * > real leak, which any `deflow run --attach` on a finished run reproduces
 * > with no load at all: `run-attach-concluded.test.ts` is where it is now
 * > pinned, red-first, and `run.ts` closes the stream through one flag that is
 * > set whether or not the connection exists yet. Nothing here was changed to
 * > accommodate it — these four assert exactly what they always asserted.
 *
 * Verifies: EPIC-21-S39, EPIC-21-S40, EPIC-21-S43, EPIC-21-S44 · AC3, AC4,
 * AC7, AC8 · test plan #3, #4, #7, #8
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { appendEvents } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  DUMB_TERMINAL_LINE,
  MIN_TERMINAL_ROWS,
  shortTerminalLine,
} from '../../src/run/session/degrade.ts';
import { CLI_BIN, HERMETIC_PATH } from './support/cli-process.ts';
import { type PtyProcess, ptyEnv, spawnOnPty, untilOnPtyProcess } from './support/pty.ts';
import { framedRun } from './support/run-fixture.ts';

const ESC = String.fromCodePoint(0x1b);
const RUN_ID = RunIdSchema.parse('run_20260816T101500Z_0d0d0d');

/** The four control sequences a repaint is made of. None may reach a terminal
 * that was told it is not getting one. */
const CURSOR_BYTES = ['[2K', '[1A', '[G', '[?25l'] as const;

let tmp = '';
let booted: Booted | undefined;
let live: PtyProcess | undefined;

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  live?.kill('SIGKILL');
  live = undefined;
  await booted?.shutdown();
  booted = undefined;
  await removeTempDir(tmp);
});

/** A daemon in this process, a repo, and a run parked at the F1.3 gate. */
async function watchableRun(): Promise<{ dataDir: string; cwd: string }> {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  booted = await boot({ dataDir, port: 0, dev: false });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  framedRun(RUN_ID, { db: booted.db, epoch: booted.epoch, ts: Date.now(), cwd: repo.dir });
  return { dataDir, cwd: repo.dir };
}

/** What the daemon appends when a run finishes — the CLI's cue to exit 0. */
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

/** `deflow run --attach` on a pty of the stated size, in the stated terminal. */
function watchOnPty(options: {
  readonly dataDir: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly term?: string;
}): PtyProcess {
  const env = ptyEnv({ dataDir: options.dataDir, path: HERMETIC_PATH });
  return spawnOnPty({
    file: process.execPath,
    args: [CLI_BIN, 'run', '--attach', RUN_ID],
    cwd: options.cwd,
    env: options.term === undefined ? env : { ...env, TERM: options.term },
    cols: options.cols,
    rows: options.rows,
  });
}

/** Every cursor-motion or erase sequence the terminal received. */
const cursorSequences = (text: string): string[] =>
  CURSOR_BYTES.filter((sequence) => text.includes(`${ESC}${sequence}`));

suite('EPIC-21-S39 — TERM=dumb: no frame at all, and the command says so (AC3)', () => {
  it('prints the stream and one explanatory line, and moves no cursor', async () => {
    const { dataDir, cwd } = await watchableRun();
    live = watchOnPty({ dataDir, cwd, cols: 80, rows: 24, term: 'dumb' });

    await untilOnPtyProcess('deflow run to be watching the run', live, () =>
      live?.output().includes(`run ${RUN_ID}`) === true ? true : null,
    );
    completeRun();
    const { exitCode } = await live.exited;
    const transcript = live.output();

    expect(exitCode).toBe(0);
    // AC3's one line, and it is the module's own sentence rather than a copy.
    expect(transcript).toContain(DUMB_TERMINAL_LINE);
    // No frame at all: a terminal that cannot address the cursor is not sent a
    // byte that tries to.
    expect(cursorSequences(transcript)).toEqual([]);
    // And the fallback is the thing that already works — the stream is there.
    expect(transcript).toContain(`run ${RUN_ID}`);
  }, 120_000);
});

suite('EPIC-21-S43 — a window too short gets the stream and one sentence (AC7)', () => {
  it('names the height it needs, and draws nothing', async () => {
    const { dataDir, cwd } = await watchableRun();
    live = watchOnPty({ dataDir, cwd, cols: 80, rows: 8 });

    await untilOnPtyProcess('deflow run to be watching the run', live, () =>
      live?.output().includes(`run ${RUN_ID}`) === true ? true : null,
    );
    completeRun();
    const { exitCode } = await live.exited;
    const transcript = live.output();

    expect(exitCode).toBe(0);
    expect(transcript).toContain(shortTerminalLine(8));
    // Naming the height is what lets the operator fix it in one action.
    expect(transcript).toContain(String(MIN_TERMINAL_ROWS));
    expect(cursorSequences(transcript)).toEqual([]);
    expect(transcript).toContain(`run ${RUN_ID}`);
  }, 120_000);
});

suite('EPIC-21-S40 — a resized window re-lays the frame out (AC4)', () => {
  it('lays the next frame out at the new width', async () => {
    const { dataDir, cwd } = await watchableRun();
    live = watchOnPty({ dataDir, cwd, cols: 80, rows: 24 });

    // A frame really was drawn first, or the resize below would be a resize of
    // nothing and this scenario would pass against a CLI with no live view.
    await untilOnPtyProcess('the first frame to be drawn', live, () =>
      cursorSequences(live?.output() ?? '').length > 0 ? true : null,
    );
    live.resize(40, 24);

    // The repaint that follows a SIGWINCH is the one under test. It arrives
    // with no event behind it, which is the common case and the one a session
    // that only re-laid out on the next event would fail — so what is waited
    // for is the terminal going quiet, not an event pushing a frame out.
    await untilQuiet(live);

    // What is *on screen* is the last frame written, and that is the whole of
    // what this asserts. "Everything since the resize" was the wrong window and
    // made this spec intermittent: a repaint already in flight when SIGWINCH
    // arrived is laid out at the **old** width and is correct to be — AC4 and
    // `render/screen.ts`'s `resize` both say the new width applies from the
    // next frame on — so including it failed the spec on documented behaviour,
    // whenever the machine was slow enough for one to be in flight.
    const onScreen = lastFrame(live.output(), RUN_ID);
    // Non-vacuity, twice over: nothing to measure would satisfy every width
    // assertion below, and so would a frame that was only its own top row.
    expect(onScreen, 'no frame was ever drawn, so there is nothing to re-lay out').not.toBeNull();
    expect(
      visibleLines(onScreen ?? '').length,
      'the frame on screen was one row, which is not a frame',
    ).toBeGreaterThan(1);
    // Every printable line of it fits 40 columns, or is a single token that
    // could not be broken (KAR-18.9 AC4).
    for (const line of visibleLines(onScreen ?? '')) {
      if (line.length <= 40) continue;
      expect(line.trim().split(/\s+/), `"${line}" ran off a 40-column window`).toHaveLength(1);
    }

    completeRun();
    const { exitCode } = await live.exited;
    expect(exitCode).toBe(0);
  }, 120_000);
});

suite('EPIC-21-S44 — every exit leaves the cursor at the start of a clean line (AC8)', () => {
  for (const ending of ['the run completing', 'SIGTERM'] as const) {
    it(`erases the frame and ends on a fresh line after ${ending}`, async () => {
      const { dataDir, cwd } = await watchableRun();
      live = watchOnPty({ dataDir, cwd, cols: 80, rows: 24 });

      await untilOnPtyProcess('the first frame to be drawn', live, () =>
        cursorSequences(live?.output() ?? '').length > 0 ? true : null,
      );

      if (ending === 'SIGTERM') live.kill('SIGTERM');
      else completeRun();

      await live.exited;
      const transcript = live.output();

      // The frame came down: the last erase in the transcript is after the last
      // frame, and nothing of it is left painted at the end.
      const lastErase = transcript.lastIndexOf(`${ESC}[2K`);
      expect(lastErase, 'no erase was ever written, so no frame was ever drawn').toBeGreaterThan(
        -1,
      );

      // And the cursor ends at column 0. The erase stream begins by putting it
      // there and then only ever moves *up*, which leaves the column alone —
      // so the column is 0 wherever the stream ends.
      expect(transcript, 'the erase never returned the cursor to column 0').toContain(`${ESC}[G`);
      // The fresh-line half. Either the command finished a line of its own
      // after taking the frame down — the verdict, on a completing run — or it
      // wrote nothing printable at all and the cursor is sitting on the blank
      // row the frame used to occupy. Both leave the shell prompt somewhere it
      // can be read; what neither allows is half a line of stale frame.
      const printable = visibleText(transcript.slice(lastErase));
      expect(
        printable === '' || printable.endsWith('\n'),
        `the transcript ended mid-line with ${JSON.stringify(printable.slice(-40))}`,
      ).toBe(true);
      // The cursor is visible again, which is the other half of what a session
      // borrowed from the terminal.
      expect(transcript).toContain(`${ESC}[?25h`);
    }, 120_000);
  }
});

/**
 * The printable lines in a chunk of terminal output.
 *
 * Control sequences are removed rather than counted: they cost no columns, so a
 * line's *visible* width is what a wrapping assertion is about. Split on the
 * CSI introducer rather than matched with one pattern containing the escape
 * byte, which `no-control-regex` rightly objects to.
 */
function visibleText(text: string): string {
  return text
    .split(`${ESC}[`)
    .map((part, index) => (index === 0 ? part : part.replace(/^[0-9;?]*[A-Za-z]/, '')))
    .join('')
    .replaceAll('\r', '');
}

function visibleLines(text: string): string[] {
  return visibleText(text)
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/**
 * The frame the terminal is currently showing, or `null` if none was drawn.
 *
 * Found by its **first line** — the run id with its status, which is the frame's
 * top row (KAR-21.1 AC4) — rather than by the erase that precedes a repaint.
 * The erase looks like the obvious boundary and is not one: a transcript line
 * is emitted by rendering `[]`, writing the line and rendering the frame again,
 * and by then the screen is occupying zero rows, so `eraseRows(0)` writes
 * nothing at all and that frame arrives with no erase in front of it. Anchoring
 * on the last erase therefore swept the transcript line in with the frame, and
 * a gate announcement printed at 80 columns — correctly, before the window ever
 * changed size — read as a frame row that had run off the edge.
 *
 * The last occurrence is the frame's, because the frame is the last thing a
 * settled session writes; the same text earlier in the transcript is the
 * command's opening line, and it is only reachable here if no frame was ever
 * drawn — which the caller checks for.
 */
function lastFrame(transcript: string, runId: string): string | null {
  const top = `run ${runId}`;
  const start = transcript.lastIndexOf(top);
  return start < 0 ? null : transcript.slice(start);
}

/**
 * Waits until the terminal has received nothing at all for `quietMs`.
 *
 * The right anchor for a claim about what is *on screen*, and the reason this
 * exists rather than "wait for one more repaint": a repaint that was already in
 * flight when the window changed size is still on its way, and a spec that
 * measured the first thing to arrive after the resize would measure that one.
 * Quiet means the session has finished reacting and the last frame written is
 * the frame an operator would be looking at.
 */
async function untilQuiet(live: PtyProcess, quietMs = 1_000): Promise<void> {
  let seen = -1;
  let unchangedSince = Date.now();
  await untilOnPtyProcess('the terminal to stop being written to', live, () => {
    const length = live.output().length;
    if (length !== seen) {
      seen = length;
      unchangedSince = Date.now();
      return null;
    }
    return Date.now() - unchangedSince >= quietMs ? true : null;
  });
}
