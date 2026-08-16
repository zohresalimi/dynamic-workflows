/**
 * KAR-21.1 AC8 / EPIC-21-S08 — the pipe is the environment in which none of
 * this epic exists and everything still works.
 *
 * `deflow run` with stdout redirected to a real file, through a real process,
 * against a real daemon. Three claims, and the third is the one that costs
 * something:
 *
 *  - no cursor-motion or erase sequence reaches the file;
 *  - no `Screen` is constructed at all, which is stronger — a screen that
 *    writes nothing because every write is guarded is a screen one forgotten
 *    guard away from filling somebody's CI log with escapes;
 *  - the bytes equal a golden **recorded before the first line of KAR-21.1 was
 *    written**. A golden captured afterwards records whatever the
 *    implementation happened to do, which is a tautology dressed as a
 *    regression test (docs/delivery/README.md §3).
 *
 * The golden is normalised through the testkit's serializer plus the two things
 * it does not cover and this transcript is full of — run ids and rendered
 * durations — because those vary per run and pinning them would pin the
 * machine rather than the output.
 *
 * Verifies: EPIC-21-S08 · KAR-21.1 AC8 · test plan #8
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import {
  makeRepo,
  makeTempDir,
  normaliseSnapshotText,
  removeTempDir,
  TEST_DAEMON_TOKEN,
} from '@DeFlow/testkit';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { createHeadlessScreen } from '../../src/render/screen.ts';
import { createStyle } from '../../src/render/style.ts';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { runRun } from '../../src/run/run.ts';
import { spawnRun, until } from './support/cli-process.ts';
import { framedRun, openSpecGate, waitForRun } from './support/run-fixture.ts';

/** The escape byte that must never reach a file. */
const ESC = '\u001B';

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

/**
 * The two unstable things in a run transcript the shared serializer does not
 * recognise: a run id is not a ULID, and `1.5s` is not a number under a key.
 */
function normaliseTranscript(text: string): string {
  return normaliseSnapshotText(text)
    .replaceAll(/run_\d{8}T\d{6}Z_[0-9a-f]+/g, '<run-id>')
    .replaceAll(/\b\d+m \d{2}s\b/g, '<dur>')
    .replaceAll(/\b\d+(?:\.\d+)?s\b/g, '<dur>')
    .replaceAll(/\b\d+ms\b/g, '<dur>');
}

/** `deflow run --no-wait`, to the F1.3 gate, with stdout on a real file. */
async function runToGateOnFile(): Promise<string> {
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

  const runId = await waitForRun(booted.db);
  await until('the CLI subscribed', () =>
    readFileSync(out, 'utf8').includes('task') ? true : null,
  );
  openSpecGate(RunIdSchema.parse(runId), { db: booted.db, epoch: booted.epoch, ts: Date.now() });

  await cli.exited;
  closeSync(fd);
  return readFileSync(out, 'utf8');
}

suite('EPIC-21-S08 — stdout is a file', () => {
  it('writes no cursor-motion or erase sequence, and matches the pre-story golden', async () => {
    const text = await runToGateOnFile();

    // Not "no ESC" alone: an erase is `ESC [ 2 K` and a cursor move is
    // `ESC [ nA`, and naming them is what makes the failure readable.
    expect(text).not.toContain(ESC);
    for (const sequence of ['[2K', '[1A', '[G', '[?25l', '[?25h']) {
      expect(text).not.toContain(`${ESC}${sequence}`);
    }

    await expect(normaliseTranscript(text)).toMatchFileSnapshot('__snapshots__/run-non-tty.txt');
  }, 120_000);

  it('constructs no Screen at all when stdout is not a terminal', async () => {
    // Stronger than "wrote no escape". A screen that writes nothing because
    // every write happens to be guarded is one forgotten guard away from
    // filling a CI log, so the claim is that it was never opened.
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const runId = RunIdSchema.parse('run_20260816T101500Z_0b0b0b');
    framedRun(runId, { db: booted.db, epoch: booted.epoch, ts: Date.now(), cwd: repo.dir });

    let opened = 0;
    const out: string[] = [];
    const exitCode = await runRun({
      argv: ['--no-wait', '--attach', runId],
      cwd: repo.dir,
      env: { ...process.env, DeFlow_DATA_DIR: dataDir },
      stdout: (chunk) => out.push(chunk),
      stderr: () => {},
      isTty: () => false,
      style: createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } }),
      openScreen: () => {
        opened += 1;
        return createHeadlessScreen();
      },
    });

    expect(opened).toBe(0);
    expect(exitCode).toBe(RUN_EXIT_CODES.awaitingHuman);
    expect(out.join('')).not.toContain(ESC);
  }, 60_000);
});
