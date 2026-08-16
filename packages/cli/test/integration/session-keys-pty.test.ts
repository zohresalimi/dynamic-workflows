/**
 * KAR-21.2 AC4 / EPIC-21-S13, S14, S15 — the terminal is given back on every
 * path, including the ones nobody writes tests for.
 *
 * Raw mode is a global mutation of the operator's terminal. A process that
 * enters it and dies without restoring leaves a shell with no echo and no line
 * editing, and the remedy is `reset` or a new window — a worse outcome than
 * anything this epic adds. So these three run under a **real pty**, and the
 * attributes are read from the master **after the child has exited**: the
 * process is the suspect, and reading the mode from inside it would be asking
 * the suspect for an alibi.
 *
 * The shell on the pty is the witness. It records `stty -g` before the child is
 * spawned and again after it is gone, and the two strings must be identical —
 * the whole attribute set, in the exact form `stty` would accept back, rather
 * than a hand-picked subset that could pass while some other flag stayed
 * clobbered.
 *
 * Three paths, because they fail differently: a normal exit (the `finally`), a
 * signal (the handler), and a throw (the `finally`, before the message is
 * printed). SIGHUP is in the same suite as SIGTERM because it is the one that
 * actually happens — it is what a closed ssh session sends, and an operator
 * whose link dropped is exactly the operator who opens a new terminal and finds
 * the old shell unusable.
 *
 * ## What the attribute comparison here can and cannot fail on
 *
 * Measured on macOS 26 / Node 26 while implementing KAR-21.2, by deleting
 * `setRawMode(false)` from `keyboard.ts` and re-running this file: **all five
 * specs stayed green.** The platform puts the terminal back on its own. A bare
 * script that sets raw mode and is then killed with SIGKILL — which no handler
 * can intercept — leaves the pty cooked all the same, while the same terminal
 * driven raw by `stty raw` from a shell prompt stays raw. So the restoration is
 * genuinely happening at process death, below anything this repository writes,
 * and `after === before` is a claim about the platform as much as about the CLI.
 *
 * These specs are kept, and are worth keeping, for what they *do* discriminate:
 * that `deflow run` runs at all on a real terminal, that it genuinely enters raw
 * mode (`keyboardIsLive` presses a bare key with no newline, which only a raw
 * reader can see — without it these would pass against a CLI with no keyboard),
 * that it exits with the right status on a normal exit and under SIGTERM and
 * SIGHUP, and that a multi-line error is readable afterwards. What they must not
 * be cited for is AC4 itself.
 *
 * **AC4's discriminating evidence is `../../src/run/session/keyboard.test.ts`**,
 * where the same deletion fails seven assertions across close, double-close,
 * SIGINT, SIGTERM, SIGHUP, the normal return and the throw. That suite asserts
 * the *call* rather than the terminal, which the flow file rightly calls asking
 * the suspect — but on this platform the terminal cannot answer, and an
 * assertion that cannot fail is worse than one that admits what it is measuring.
 *
 * Verifies: EPIC-21-S13, EPIC-21-S14, EPIC-21-S15 · AC4 (partially — see above)
 * · test plan #13, #14, #15
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { appendEvents } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { CLI_BIN, HERMETIC_PATH } from './support/cli-process.ts';
import {
  alivePid,
  announcedPid,
  attributeFile,
  cookedModeFlags,
  openShell,
  ptyEnv,
  readAttributes,
  recordAttributes,
  type Shell,
  untilOnPty,
} from './support/pty.ts';
import { framedRun } from './support/run-fixture.ts';

const KEYS_CHILD = fileURLToPath(new URL('./support/keys-child.ts', import.meta.url));
const RUN_ID = RunIdSchema.parse('run_20260816T101500Z_0c0c0c');

let tmp = '';
let booted: Booted | undefined;
let shell: Shell | undefined;

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  shell?.kill();
  shell = undefined;
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

/** A shell on a fresh pty, with the attributes recorded before anything runs. */
async function witness(dataDir: string, cwd: string): Promise<{ before: string }> {
  shell = openShell({ cwd, env: ptyEnv({ dataDir, path: HERMETIC_PATH }) });
  const before = attributeFile(tmp, 'before');
  recordAttributes(shell, before);
  await untilOnPty('the attributes to be recorded', shell, () => {
    try {
      return readAttributes(before) === '' ? null : true;
    } catch {
      return null;
    }
  });
  return { before: readAttributes(before) };
}

/**
 * Proof, from outside the process, that raw mode is genuinely on right now.
 *
 * Without this S13 and S14 are **vacuous**: "the terminal was given back" is
 * trivially true of a terminal that was never borrowed, so both scenarios go
 * green against a `deflow run` that has no keyboard at all — which is exactly
 * what they did before this story was written. A bare `i` with no newline can
 * only be seen by something reading the terminal in raw mode; in canonical mode
 * it sits in the line buffer and the interjection row never opens.
 *
 * `interject:` rather than `interject`, because the key-hint line names the key
 * by that word and would match from the first frame onwards.
 */
async function keyboardIsLive(live: Shell): Promise<void> {
  live.type('i');
  await untilOnPty('a bare key press to open the interjection row', live, () =>
    live.output().includes('interject:') ? true : null,
  );
}

/** `stty -g` and `stty -a` after the child is gone, read through the shell. */
async function attributesAfter(): Promise<{ after: string; dump: string }> {
  const live = shell;
  if (live === undefined) throw new Error('no shell');
  const after = attributeFile(tmp, 'after');
  const dump = attributeFile(tmp, 'dump');
  live.send(`/bin/stty -g > ${after}; /bin/stty -a > ${dump}; exit`);
  await live.exited;
  return { after: readAttributes(after), dump: readFileSync(dump, 'utf8') };
}

suite('EPIC-21-S13 — the terminal is given back after a normal exit (AC4)', () => {
  it('leaves the pty exactly as it found it, with echo and icanon on', async () => {
    const { dataDir, cwd } = await watchableRun();
    const { before } = await witness(dataDir, cwd);
    const live = shell as Shell;

    live.send(`${process.execPath} ${CLI_BIN} run --attach ${RUN_ID}; echo "DONE=$?"`);
    // Not `output().includes(RUN_ID)`: the shell echoes the command line it was
    // handed, so that string is on the pty before the CLI has started. The
    // keyboard being live is both an unambiguous cue and the thing that stops
    // this scenario passing vacuously.
    await keyboardIsLive(live);

    completeRun();

    const code = await untilOnPty('deflow run to exit', live, () => {
      const match = /DONE=(\d+)/.exec(live.output());
      return match?.[1] === undefined ? null : Number(match[1]);
    });
    expect(code).toBe(0);

    const { after, dump } = await attributesAfter();

    expect(after).toBe(before);
    expect(cookedModeFlags(dump)).toEqual({ echo: true, icanon: true });
  }, 120_000);
});

suite('EPIC-21-S14 — the terminal is given back after a signal (AC4)', () => {
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    it(`leaves the pty exactly as it found it after ${signal}`, async () => {
      const { dataDir, cwd } = await watchableRun();
      const { before } = await witness(dataDir, cwd);
      const live = shell as Shell;

      // `exec` so the pid the shell announces *is* the process under test:
      // signalling the wrapper instead would prove nothing about the CLI.
      live.send(
        `/bin/sh -c 'echo PID=$$; exec ${process.execPath} ${CLI_BIN} run --attach ${RUN_ID}'; ` +
          `echo "DONE=$?"`,
      );

      const pid = await untilOnPty('the CLI to announce its pid', live, () =>
        announcedPid(live.output()),
      );
      await untilOnPty('deflow run to be watching the run', live, () =>
        live.output().includes(`run ${RUN_ID}`) ? true : null,
      );
      // Raw mode has to be genuinely on before the signal lands, or this passes
      // by never having entered it at all. Asserted rather than slept for: a
      // `sleep(500)` states the hope, a decoded key press states the fact.
      await keyboardIsLive(live);

      process.kill(pid, signal);

      await untilOnPty('the CLI to exit', live, () =>
        /DONE=(\d+)/.test(live.output()) ? true : null,
      );
      expect(alivePid(pid)).toBe(false);

      const { after, dump } = await attributesAfter();

      expect(after).toBe(before);
      expect(cookedModeFlags(dump)).toEqual({ echo: true, icanon: true });
    }, 120_000);
  }
});

suite('EPIC-21-S15 — the terminal is given back after an unexpected throw (AC4)', () => {
  it('restores before the message is printed, so the message is readable', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const { before } = await witness(dataDir, tmp);
    const live = shell as Shell;

    live.send(`${process.execPath} ${KEYS_CHILD} throw; echo "DONE=$?"`);

    const code = await untilOnPty('the throwing session to exit', live, () => {
      const match = /DONE=(\d+)/.exec(live.output());
      return match?.[1] === undefined ? null : Number(match[1]);
    });

    // A bug in the session is a non-zero exit, not a shell to reset afterwards.
    expect(code).not.toBe(0);
    expect(live.output()).toContain('raw');

    const transcript = live.output();
    // The second Then, and the part people discover the hard way: in raw mode a
    // bare `\n` moves down without returning to column 0, so a message printed
    // before the terminal was restored renders as a diagonal staircase. `\r\n`
    // in the pty's own bytes is the terminal saying ONLCR was back on.
    expect(transcript).toContain('the session fell over\r\n');
    expect(transcript).toContain('and it said so on a second line');

    const { after, dump } = await attributesAfter();

    expect(after).toBe(before);
    expect(cookedModeFlags(dump)).toEqual({ echo: true, icanon: true });
  }, 60_000);

  it('gives it back when a signal ends a session that was still running', async () => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    const { before } = await witness(dataDir, tmp);
    const live = shell as Shell;

    live.send(
      `/bin/sh -c 'echo PID=$$; exec ${process.execPath} ${KEYS_CHILD} wait'; echo "DONE=$?"`,
    );

    const pid = await untilOnPty('the session to announce its pid', live, () =>
      announcedPid(live.output()),
    );
    await untilOnPty('the session to enter raw mode', live, () =>
      live.output().includes('raw') ? true : null,
    );

    // The keyboard is genuinely live: a key pressed now is decoded, which is
    // what makes the restore below a restore rather than a no-op.
    live.send('a');
    await untilOnPty('the key to be decoded', live, () =>
      live.output().includes('intent:answer') ? true : null,
    );

    process.kill(pid, 'SIGHUP');

    await untilOnPty('the session to exit', live, () =>
      /DONE=(\d+)/.test(live.output()) ? true : null,
    );

    const { after, dump } = await attributesAfter();

    expect(after).toBe(before);
    expect(cookedModeFlags(dump)).toEqual({ echo: true, icanon: true });
  }, 60_000);
});
