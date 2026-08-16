/**
 * A real pty with a real shell on it, for the three scenarios that can only be
 * answered from outside the process under test.
 *
 * EPIC-21-S13, S14 and S15 all ask the same question — *did it give the
 * terminal back?* — and the process that borrowed it is the suspect, so the
 * answer has to come from somewhere else. Here that is a `/bin/sh` sitting on
 * the same pty: it records `stty -g` before the child is spawned and reads it
 * again **after the child has exited**, which is the vantage point the flow
 * file names.
 *
 * `stty -g` rather than a field-by-field comparison: it is the terminal's whole
 * attribute set in the one form both macOS and Linux agree is exact, and it is
 * the string `stty` itself will accept back. A comparison over a hand-picked
 * subset would pass while some other flag stayed clobbered.
 *
 * Lines are sent **one at a time**, each awaited, because the shell and the
 * child share one keyboard: a script written ahead of the prompt would be read
 * by whatever is in raw mode at the time, which is the very thing under test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawn as spawnPty } from '@lydell/node-pty';
import { sleep } from './cli-process.ts';

/** Every spec here opens the pty at the flow file's stated size. */
export const PTY_COLS = 80;
export const PTY_ROWS = 24;

export interface Shell {
  /** Everything the pty master has seen, as the terminal received it. */
  readonly output: () => string;
  /** Writes one line to the pty, exactly as a keyboard would. */
  send(line: string): void;
  /**
   * Writes bytes with **no newline** — one key press rather than one line.
   *
   * The distinction matters here and nowhere else in this file: a line is read
   * by whatever is in canonical mode, and a bare key press is only ever seen by
   * something in raw mode. It is what lets S13 and S14 prove raw mode was
   * genuinely entered before asserting it was given back.
   */
  type(bytes: string): void;
  readonly pid: number;
  readonly exited: Promise<{ readonly exitCode: number }>;
  kill(): void;
}

export function openShell(options: {
  readonly cwd: string;
  readonly env: Record<string, string>;
}): Shell {
  const child = spawnPty('/bin/sh', [], {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: options.cwd,
    env: options.env,
  });

  const chunks: string[] = [];
  child.onData((data) => chunks.push(data));

  const exited = new Promise<{ exitCode: number }>((resolve) => {
    child.onExit(({ exitCode }) => resolve({ exitCode }));
  });

  return {
    output: () => chunks.join(''),
    send: (line) => child.write(line.endsWith('\n') ? line : `${line}\n`),
    type: (bytes) => child.write(bytes),
    pid: child.pid,
    exited,
    kill: () => {
      try {
        child.kill();
      } catch {
        // Already gone, which is the state this wanted anyway.
      }
    },
  };
}

/** Waits for `read` to answer, or throws with the pty's whole transcript. */
export async function untilOnPty<T>(
  what: string,
  shell: Shell,
  read: () => T | null,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await sleep(25);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms. The pty saw:\n${shell.output()}`);
}

/**
 * The terminal's attributes, recorded through the shell into a file.
 *
 * A file rather than the pty's own output because the transcript is full of
 * whatever the child printed, and `stty -g`'s answer must be read exactly.
 */
export function recordAttributes(shell: Shell, path: string): void {
  shell.send(`/bin/stty -g > ${path}`);
}

export const readAttributes = (path: string): string => readFileSync(path, 'utf8').trim();

/**
 * Whether a `stty -a` dump says echo and canonical mode are on.
 *
 * Both are matched with a boundary on each side: `echoe`, `echok` and `echoctl`
 * all contain "echo", and a substring test would call a terminal with echo off
 * healthy because some unrelated flag was on.
 */
export function cookedModeFlags(dump: string): { echo: boolean; icanon: boolean } {
  const on = (flag: string): boolean => {
    const enabled = new RegExp(`(^|[\\s])${flag}([\\s,]|$)`).test(dump);
    const disabled = new RegExp(`(^|[\\s])-${flag}([\\s,]|$)`).test(dump);
    return enabled && !disabled;
  };
  return { echo: on('echo'), icanon: on('icanon') };
}

/**
 * The environment a `deflow` on a pty runs in: hermetic, but with `/bin` on it.
 *
 * `stty` is not a shell builtin, and a `PATH` with only `node` on it would make
 * every spec here fail at the first attribute read rather than at the claim.
 * `TERM` is set because a terminal that will not say what it is gets the
 * 80-column fallback, and the pty was opened at 80 for a reason.
 */
export function ptyEnv(options: {
  readonly dataDir: string;
  readonly path: string;
}): Record<string, string> {
  return {
    PATH: [options.path, '/bin', '/usr/bin'].join(':'),
    HOME: options.dataDir,
    DeFlow_DATA_DIR: options.dataDir,
    DeFlow_LOG_LEVEL: 'silent',
    DeFlow_DEV: '0',
    BROWSER: 'none',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    PS1: '',
  };
}

/** The pid of the one child `sh -c 'echo PID=$$; exec …'` announced. */
export function announcedPid(output: string): number | null {
  const match = /(?:^|[^A-Z_])PID=(\d+)/m.exec(output);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** True while the process exists at all. */
export function alivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const attributeFile = (tmp: string, name: string): string => join(tmp, `stty-${name}`);
