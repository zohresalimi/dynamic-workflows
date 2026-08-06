/**
 * KAR-07.5 Layer 3 — running `workspace.setup`, with its output on the wire
 * (docs/09-workspace-and-safety.md §5.1; EPIC-07-S21).
 *
 * A shell, deliberately: the configured value is a *command line*
 * (`pnpm install --frozen-lockfile && pnpm build:deps`), authored by the
 * repository's owner, and `&&` has no meaning without one. Splitting it here
 * on whitespace instead would silently run `pnpm` with `&&` as an argument.
 *
 * Raw `node:child_process` rather than execa, for the reason
 * ../git/run-git.ts states in reverse: execa is the git chokepoint and only
 * the git chokepoint, so that `test/spawn-chokepoint.test.ts` can keep saying
 * "the two forbidden-argument assertions run before every git spawn" without
 * qualification.
 *
 * Chunks are handed to the caller as they arrive and are not accumulated here,
 * so the ledger gets the transcript incrementally and a chatty install cannot
 * grow the daemon's heap by talking — the only bounded buffer anywhere in this
 * path is the caller's stderr tail. The exit code is *data*: a non-zero setup
 * is this module's normal return, and the decision to fail provisioning over
 * it belongs to the caller that knows an agent was about to be spawned.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import type { Readable } from 'node:stream';

export type SetupStream = 'stdout' | 'stderr';

export interface SetupCommandRequest {
  /** The user's command line, run through `/bin/sh -c`. */
  readonly command: string;
  /** The worktree. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Called for every chunk, in arrival order, while the child is alive. */
  onChunk(stream: SetupStream, data: Uint8Array): void;
}

export interface SetupOutcome {
  /** `null` only when the child was killed by a signal before exiting. */
  readonly exitCode: number;
  readonly signal: NodeJS.Signals | null;
}

/** Injected, so a spec can be a package manager that is not installed. */
export type SetupRunner = (request: SetupCommandRequest) => Promise<SetupOutcome>;

export const spawnSetup: SetupRunner = (request) =>
  new Promise<SetupOutcome>((resolve, reject) => {
    const child = spawn(request.command, {
      cwd: request.cwd,
      env: request.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pump = (readable: Readable, stream: SetupStream): void => {
      readable.on('data', (chunk: Buffer) => {
        request.onChunk(stream, new Uint8Array(chunk));
      });
    };
    pump(child.stdout, 'stdout');
    pump(child.stderr, 'stderr');

    child.on('error', reject);
    child.on('close', (code, signal) => {
      // A child killed by a signal never exited on its own, and reporting 0
      // for it would let a SIGKILLed install write a success marker.
      resolve({ exitCode: code ?? 1, signal });
    });
  });

/** The daemon's own environment, which a setup command inherits by default —
 * the user's `PATH` is how their package manager is found at all. */
export const setupChildEnv = (): Readonly<Record<string, string | undefined>> => ({
  ...process.env,
});
