/**
 * The `DeFlow` binary, spawned the way `npx DeFlow up` spawns it: one argv, one
 * process, one exit code.
 *
 * `daemon.ts` next door starts `packages/daemon/src/main.ts` directly, because
 * its specs are about the daemon. These are about the **command** — the argv
 * parser, the refusals, the signal handling and the exit codes — so they go
 * through `packages/cli/src/bin.ts`, which is the file `dist/bin.mjs` is built
 * from and the one `npx` runs.
 *
 * The environment is hermetic by construction: `PATH` holds only what a spec
 * asks for plus the directory `node` lives in, so a spec asserting "no agent
 * CLI is installed" cannot find the developer's own and pass for the wrong
 * reason.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const CLI_BIN = join(repoRoot, 'packages/cli/src/bin.ts');
export const MOCK_AGENT_BIN = join(repoRoot, 'packages/mock-agent/bin/mock-agent.ts');

/**
 * git's own directory, which is on the hermetic PATH and nothing else is.
 *
 * `DeFlow up` never shells out to git; `DeFlow run` refuses to start a run on a
 * machine whose git is below 2.38 (KAR-18.3 AC6's fifth code), so a PATH with
 * no git at all would make every `run` spec here exit 5 for a reason none of
 * them is about. git is not an agent CLI, so the "nothing is installed" specs
 * are unaffected.
 */
export const GIT_DIR = dirname(
  execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).trim(),
);

export const makeDataDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'DeFlow-up-'));

export const removeDataDir = (dir: string): Promise<void> =>
  process.env.DeFlow_KEEP_TMP === undefined
    ? rm(dir, { recursive: true, force: true })
    : Promise.resolve();

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface CliProcess {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGINT, then SIGKILL if it will not go. Idempotent. */
  readonly stop: () => Promise<void>;
}

export interface SpawnUpOptions {
  readonly dataDir: string;
  /** Everything after `up`. */
  readonly args?: readonly string[];
  /** Directories prepended to `PATH`, in order. */
  readonly binDirs?: readonly string[];
  /** Merged over the hermetic base. */
  readonly env?: NodeJS.ProcessEnv;
  /** The working directory. Defaults to the repository root. */
  readonly cwd?: string;
}

export interface SpawnCliOptions extends SpawnUpOptions {
  /** The subcommand and everything after it. */
  readonly argv: readonly string[];
}

export function spawnUp(options: SpawnUpOptions): CliProcess {
  return spawnCli({ ...options, argv: ['up', ...(options.args ?? [])] });
}

/**
 * Any `DeFlow` subcommand, spawned the way `npx DeFlow …` spawns it.
 *
 * `spawnUp` above is this with `up` in front of the argv, kept because every
 * KAR-18.2 spec reads that way. KAR-18.3's specs need `run` and `--attach`, and
 * a second copy of the hermetic environment is exactly the thing that drifts.
 */
export function spawnCli(options: SpawnCliOptions): CliProcess {
  const out: string[] = [];
  const err: string[] = [];

  const child = spawn(process.execPath, [CLI_BIN, ...options.argv], {
    cwd: options.cwd ?? repoRoot,
    env: {
      PATH: [...(options.binDirs ?? []), dirname(process.execPath), GIT_DIR].join(':'),
      HOME: options.dataDir,
      DeFlow_DATA_DIR: options.dataDir,
      DeFlow_LOG_LEVEL: 'silent',
      // Not the dev loop: no Vite, no watcher.
      DeFlow_DEV: '0',
      // Step 8 must never launch a real browser from a test run; a spec that
      // wants to assert the launch sets its own $BROWSER.
      BROWSER: 'none',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk.toString()));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([exited, sleep(10_000).then(() => child.kill('SIGKILL'))]);
    await exited;
  };

  return { child, stdout: () => out.join(''), stderr: () => err.join(''), exited, stop };
}

/** The handoff URL the command prints, once it prints one. */
export async function waitForUrl(cli: CliProcess, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /^http:\/\/127\.0\.0\.1:\d+\/#token=\S+$/m.exec(cli.stdout());
    if (match !== null) return match[0];
    if (cli.child.exitCode !== null) {
      throw new Error(
        `DeFlow up exited with ${cli.child.exitCode} before printing a URL:\n${cli.stderr()}`,
      );
    }
    await sleep(50);
  }
  throw new Error(`DeFlow up printed no URL within ${timeoutMs} ms:\n${cli.stderr()}`);
}
