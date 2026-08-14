/**
 * `deflow run` as an operator meets it: a real process, a real signal, a real
 * exit code.
 *
 * The in-process specs next door drive `runRun` directly, which is right for
 * everything about *what the command does*. Signals are not that: "the first
 * Ctrl-C detaches" and "SIGKILL the launcher and the daemon lives" are claims
 * about process groups and about what the kernel delivers to whom, and neither
 * is observable from inside one process.
 *
 * `PATH` holds only a directory holding nothing but `node` plus git's, and
 * whatever a spec asks for — so a spec cannot find the developer's own agent
 * CLI and pass for the wrong reason.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
export const CLI_BIN = join(repoRoot, 'packages/cli/src/bin.ts');
export const MOCK_AGENT_BIN = join(repoRoot, 'packages/mock-agent/bin/mock-agent.ts');

/**
 * A directory holding a `node` and nothing else, one per test process.
 *
 * The shebang problem, solved without the side effect. Every fake here is a
 * `#!/usr/bin/env node` script, so `node` has to be findable — but putting
 * *its own directory* on `PATH` puts the npm global bin directory there with
 * it on every normal installation, which is where a developer's real
 * `claude-agent-acp` lives. A spec asserting "zero providers" then finds the
 * author's own, and admission resolves it as `adapter-missing` for the wrong
 * reason — a real package the spec never mentioned, rather than nothing at
 * all.
 *
 * Corrected 2026-08-12 while implementing KAR-19.2 — same correction as
 * `e2e/support/up.ts`'s `nodeOnlyDir`, for the same reason, found the same way.
 */
function nodeOnlyDir(): string {
  const dir = join(tmpdir(), `DeFlow-cli-node-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'node');
  if (!existsSync(link)) symlinkSync(process.execPath, link);
  return dir;
}

/**
 * A directory holding `node` and nothing else, plus git's, and nothing more.
 *
 * git is on it because `deflow run` refuses to start a run on a machine whose
 * git is below 2.38 (AC6's fifth code) — a hermetic PATH with no git at all
 * would make every spec here exit 5 for a reason none of them is about.
 */
export const HERMETIC_PATH = [
  nodeOnlyDir(),
  dirname(
    execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  ),
].join(':');

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RunProcess {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnRunOptions {
  readonly dataDir: string;
  readonly cwd: string;
  /** Everything after `run`. */
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Where stdout goes. A file descriptor makes stdout a **pipe-like** target
   * that is not a TTY, which is what EPIC-18-S25 is about. */
  readonly stdoutFd?: number;
}

export function spawnRun(options: SpawnRunOptions): RunProcess {
  const out: string[] = [];
  const err: string[] = [];

  const child = spawn(process.execPath, [CLI_BIN, 'run', ...options.args], {
    cwd: options.cwd,
    env: {
      PATH: HERMETIC_PATH,
      HOME: options.dataDir,
      DeFlow_DATA_DIR: options.dataDir,
      DeFlow_LOG_LEVEL: 'silent',
      DeFlow_DEV: '0',
      BROWSER: 'none',
      ...options.env,
    },
    stdio: ['ignore', options.stdoutFd ?? 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk.toString()));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return { child, stdout: () => out.join(''), stderr: () => err.join(''), exited };
}

export interface DaemonFile {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

/** `<dataDir>/daemon.json`, once the autostarted daemon has written one. */
export function daemonFile(dataDir: string): DaemonFile | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as DaemonFile;
  } catch {
    return null;
  }
}

/**
 * A request to the autostarted daemon, with **its** bearer token.
 *
 * Not `authorizedFetch()` from the testkit: that one carries
 * `TEST_DAEMON_TOKEN`, which is right for a daemon a spec booted with it and
 * wrong here — this daemon minted its own 32 random bytes, and reading them out
 * of the file it wrote is the same handoff `deflow run` itself performs.
 */
export async function api(
  dataDir: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const file = daemonFile(dataDir);
  if (file === null) throw new Error(`no daemon.json in ${dataDir}`);
  return await fetch(`http://127.0.0.1:${file.port}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${file.token}`,
      'X-DeFlow-Submitted-By': 'cli',
    },
  });
}

/** Waits for `predicate` to hold, or throws with what was seen instead. */
export async function until<T>(what: string, read: () => T | null, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await sleep(25);
  }
  throw new Error(`${what} did not happen within ${timeoutMs} ms`);
}

/** True while the process exists at all — `kill(pid, 0)` and nothing more. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The daemon this data directory holds, stopped. Idempotent. */
export async function stopDaemon(dataDir: string): Promise<void> {
  const file = daemonFile(dataDir);
  if (file === null) return;
  try {
    process.kill(file.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100 && alive(file.pid); attempt += 1) await sleep(50);
  if (alive(file.pid)) {
    try {
      process.kill(file.pid, 'SIGKILL');
    } catch {
      // Already gone between the check and the signal.
    }
  }
}
