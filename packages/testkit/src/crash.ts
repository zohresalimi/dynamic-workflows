/**
 * KAR-03.8 — a real child process that can be crashed, and the polling wait
 * that replaces the fake timer nobody may use here (EPIC-03-S26).
 *
 * Two rules from docs/14-testing-strategy.md §8 shape this file:
 *
 * 1. **`SIGKILL`, never `SIGTERM`.** SIGTERM tests the shutdown handler.
 *    SIGKILL tests durability, which is the only thing a crash-resume suite is
 *    about. There is no way to ask a process to be killed that rudely from
 *    inside itself, so the child has to be a real one.
 * 2. **No fake timers while a child is alive.** Their I/O would never arrive
 *    and the spec would deadlock for the whole timeout. `waitFor` polls a real
 *    clock on purpose.
 *
 * The child is started **detached**, which is what makes it a process-group
 * leader, and killed with `process.kill(-pid)`, which is what takes everything
 * it spawned with it. That is not tidiness: an agent that survives its daemon
 * and writes its side-effect line *after* the restart has already concluded
 * the effect never happened turns a correct restart into a duplicate key, and
 * the suite fails with no bug behind it. Killing the group makes the crash a
 * single instant instead of a window.
 */
import { type ChildProcess, spawn } from 'node:child_process';

export interface CrashableOptions {
  /** The script to run. It is executed by this Node, as TypeScript. */
  readonly script: string;
  readonly args?: readonly string[];
  /** The child's whole environment. Defaults to this process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface Crashable {
  readonly pid: number;
  /** Resolves when the child is gone, however it went. */
  readonly exited: Promise<Exit>;
  /**
   * `kill -9` on the child **and its whole process group**, resolving once it
   * is really gone. Safe on a process that has already exited.
   */
  sigkill(): Promise<Exit>;
  /** Everything the child has written to stdout so far. */
  stdout(): string;
  /** Everything the child has written to stderr so far. */
  stderr(): string;
}

/** Starts `script` as a real, killable, process-group-leading child. */
export function startCrashable(options: CrashableOptions): Crashable {
  const child: ChildProcess = spawn(process.execPath, [options.script, ...(options.args ?? [])], {
    // The whole point: a new process group, so one signal reaches the child
    // and every process it goes on to spawn.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: (options.env ?? process.env) as NodeJS.ProcessEnv,
  });

  const pid = child.pid;
  if (pid === undefined) throw new Error(`could not start ${options.script}`);

  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk;
  });

  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    pid,
    exited,
    async sigkill(): Promise<Exit> {
      try {
        // The negative pid is the group. ESRCH means it is already gone, which
        // is the outcome this function exists to produce.
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already reaped. `exited` has the answer.
        }
      }
      return exited;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

export interface WaitForOptions {
  /** What is being waited for. It becomes the failure message. */
  readonly describe: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * Polls `condition` on a **real** clock until it holds, or fails saying what it
 * was waiting for.
 *
 * A bare `Timed out after 5000ms` in a crash-fuzz log is unactionable; the
 * sentence this throws is the whole diagnosis for a harness that got stuck.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${options.describe}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A real, unfaked pause. @see waitFor for why the timers here are real. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
