/**
 * KAR-21.1 AC6 / EPIC-21-S05 — the frame is added below the transcript, not
 * instead of it.
 *
 * The epic's own boundary: `deflow run`'s existing output is a **fixed point**,
 * and any change to it is a regression rather than a feature. So one run is
 * watched twice over one ledger — once with the session on, once with it off —
 * and the bytes that are not the screen's must be identical.
 *
 * The two runs attach to the **same run id** on the **same daemon** rather than
 * submitting two tasks, because two submissions would differ in the one place
 * this assertion cannot tolerate: the id itself. Replaying one ledger twice
 * makes every event byte-for-byte the same, and the only remaining variance is
 * the wall-clock the verdict line carries, which is normalised.
 *
 * Which bytes are "the screen's" is not guessed at. The session writes its
 * frames through the `Screen` it was handed, so the spec hands it one that
 * records what it writes *and* forwards it to the same sink the transcript goes
 * to — exactly as `bin.ts` does with `process.stdout`. Subtracting the recorded
 * chunks from the sink is mechanical, and what is left is the transcript.
 *
 * Verifies: EPIC-21-S05 · AC6 · test plan #5
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { createScreen, type Screen } from '../../src/render/screen.ts';
import { createStyle } from '../../src/render/style.ts';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { runRun } from '../../src/run/run.ts';
import { framedRun } from './support/run-fixture.ts';

/** The escape byte the transcript half of stdout must never carry. */
const ESC = '\u001B';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

/** A run id no run in this test suite can collide with. */
const RUN_ID = RunIdSchema.parse('run_20260816T101500Z_0a0a0a');

/** No colour either way, so the only difference between the two is the screen. */
const PIPED = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });

interface Watched {
  /** Everything that reached stdout that the screen did not write. */
  readonly transcript: string;
  readonly frames: readonly (readonly string[])[];
  readonly exitCode: number;
}

/** Attaches to `RUN_ID` and watches it to the gate, with or without a session. */
async function watch(options: {
  readonly dataDir: string;
  readonly cwd: string;
  readonly session: boolean;
}): Promise<Watched> {
  /** Every chunk stdout received, tagged with who wrote it. */
  const sink: { readonly from: 'transcript' | 'screen'; readonly text: string }[] = [];
  const frames: (readonly string[])[] = [];

  let screen: Screen | null = null;
  const openScreen = (): Screen => {
    screen = createScreen({
      width: PIPED.width,
      write: (text) => sink.push({ from: 'screen', text }),
    });
    return {
      render: (frame) => {
        frames.push([...frame]);
        screen?.render(frame);
      },
      close: () => screen?.close(),
    };
  };

  const exitCode = await runRun({
    argv: ['--no-wait', '--attach', RUN_ID],
    cwd: options.cwd,
    env: { ...process.env, DeFlow_DATA_DIR: options.dataDir },
    stdout: (text) => sink.push({ from: 'transcript', text }),
    stderr: () => {},
    isTty: () => options.session,
    style: PIPED,
    ...(options.session ? { openScreen } : {}),
  });

  return {
    transcript: sink
      .filter((chunk) => chunk.from === 'transcript')
      .map((chunk) => chunk.text)
      .join(''),
    frames,
    exitCode,
  };
}

/** The one thing two watches of one ledger legitimately disagree about. */
const normalise = (text: string): string =>
  text.replaceAll(/\b\d+(?:\.\d+)?s\b/g, '<dur>').replaceAll(/\b\d+ms\b/g, '<dur>');

suite('EPIC-21-S05 — the transcript is untouched by the session (AC6)', () => {
  it('emits the same transcript bytes with the session on and off', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const dataDir = `${tmp}/data`;
    booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
    framedRun(RUN_ID, {
      db: booted.db,
      epoch: booted.epoch,
      ts: Date.now(),
      cwd: repo.dir,
    });

    const on = await watch({ dataDir, cwd: repo.dir, session: true });
    const off = await watch({ dataDir, cwd: repo.dir, session: false });

    expect(normalise(on.transcript)).toBe(normalise(off.transcript));
    expect(on.exitCode).toBe(RUN_EXIT_CODES.awaitingHuman);
    expect(off.exitCode).toBe(on.exitCode);

    // And the session really was on: a spec that compared two runs with no
    // frame in either would pass forever.
    expect(on.frames.length).toBeGreaterThan(0);
    expect(off.frames).toEqual([]);
  });

  it("leaves the agent's own io bytes unwrapped and unprefixed either way", async ({ tmp }) => {
    // KAR-19.4 AC3's decision, which a frame that reflowed the region above it
    // would undo without anybody choosing to.
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const dataDir = `${tmp}/data`;
    booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
    framedRun(RUN_ID, {
      db: booted.db,
      epoch: booted.epoch,
      ts: Date.now(),
      cwd: repo.dir,
    });

    const on = await watch({ dataDir, cwd: repo.dir, session: true });

    // The transcript half of stdout carries no escape at all: every byte the
    // screen wrote was tagged as the screen's, so anything left is text.
    expect(on.transcript).not.toContain(ESC);
  });
});
