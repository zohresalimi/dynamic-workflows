/**
 * The one place a first-party vendor CLI is spawned as a child process.
 *
 * **Generalised from `../gh/run-gh.ts` by KAR-22.6, not copied.** KAR-22.4
 * extracted a single `gh` spawn site out of `../intake/resolve-issue.ts`
 * precisely so there would be one door to check; KAR-22.6 then needed the same
 * child for Atlassian's `acli`, and a second `spawn()` would have undone the
 * thing the first extraction bought. `../gh/run-gh.ts` is now a named call into
 * this, and `./run-cli.ts` is the door.
 *
 * Why one door matters more here than it looks: ADR-0003's claim is that DeFlow
 * *never captures a login command's output*. That claim is only checkable if
 * there is one call site to check —
 * `packages/daemon/test/connector-credential-guard.test.ts` reads this module's
 * import graph and its argv patterns, and it can only do that over a chokepoint.
 *
 * Everything about *how* the child is run is KAR-10.1's, unchanged, and the
 * reasons are worth keeping where the code is:
 *
 * - `node:child_process.spawn` rather than `execa`, because
 *   `packages/daemon/test/spawn-chokepoint.test.ts` (KAR-07.1,
 *   docs/09-workspace-and-safety.md §1.1) enforces `execa` as
 *   `../git/run-git.ts`'s alone.
 * - The timeout is `clock.setTimer`, never a raw `setTimeout`:
 *   `packages/daemon/test/no-timer-waits.test.ts` (KAR-06.6 AC1) allowlists
 *   `../clock.ts` as the one place a timer global may be named, so every wait
 *   in the daemon goes through the injected `Clock` (NF9).
 * - A wedged child is signalled through `killTree`, never `child.kill()`:
 *   `test/one-kill-site.test.ts` (KAR-08.6 AC1) enforces one process-kill seam,
 *   because `child.kill()` signals the direct subprocess only and leaves
 *   anything the CLI itself spawned running. `detached: true` is what makes the
 *   negated-pid signal reach a *group* rather than a stranger.
 *
 * `spawned` is why the result is a value rather than a throw. KAR-10.1 turned a
 * missing `gh` into a thrown `IssueResolutionFailed`, which is right for intake
 * — an operator who pasted a URL wants a refusal. It is wrong for a connectors
 * screen, where "the CLI is not installed" is a *state to render*, with an
 * install link. So the failure to spawn is returned and each caller decides
 * what it means.
 */
import { killTree } from '@DeFlow/adapters';
import type { Clock } from '@DeFlow/core';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { text } from 'node:stream/consumers';

/** How long a vendor CLI invocation may take before it is signalled. */
export const CLI_TIMEOUT_MS = 15_000;

export interface CliInvocation {
  /** `false` when the binary is not on `PATH` — not an error, a state. */
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why the spawn itself failed, when `spawned` is `false`. */
  readonly spawnError: string | null;
}

export interface RunCliOptions {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /**
   * The full child environment — `PATH` above all. Defaults to the daemon's
   * own, so a hermetic spec overrides it (or its own `process.env.PATH`) to put
   * a fake binary in front of a real one.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where to run. The GitHub connector passes the project's own working tree,
   * which is how `gh` resolves *which repository* without DeFlow parsing a git
   * remote — the CLI's own inference, rather than a second one here.
   */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * Runs `binary` with `args` and returns everything it did.
 *
 * Never throws for anything the CLI itself did: a non-zero exit, a signal and a
 * missing binary are all values, because every caller has to render them.
 */
export async function runCli(
  binary: string,
  args: readonly string[],
  options: RunCliOptions,
): Promise<CliInvocation> {
  const child = spawn(binary, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the timeout below can negate its pid safely.
    detached: true,
    env: options.env ?? process.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // Registered at spawn time, not awaited until the end: an exit landing
  // before then must still be observed.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const timer = options.clock.setTimer(options.timeoutMs ?? CLI_TIMEOUT_MS, () => {
    const pid = child.pid;
    if (pid === undefined) return; // Not spawned yet; nothing to signal.
    try {
      killTree(pid, 'SIGKILL');
    } catch {
      // Already gone, or unsignalable — `exited` resolves from 'exit' anyway.
    }
  });

  try {
    try {
      await started;
    } catch (error) {
      return {
        spawned: false,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error.message : String(error),
      };
    }

    // Drained to the end of the *stream*, not to 'exit': a CLI that calls
    // process.exit right after writing can leave bytes in the pipe that 'exit'
    // wins the race against if nothing is already consuming them.
    const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr)]);
    const { code, signal } = await exited;
    return { spawned: true, exitCode: code, signal, stdout, stderr, spawnError: null };
  } finally {
    timer.cancel();
  }
}

/** The first non-empty line of a stream — what the CLI actually said. */
export const firstLine = (value: string): string =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '';
