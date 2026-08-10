/**
 * A real DeFlowd process, started the way the published binary starts it:
 * `node packages/daemon/src/main.ts`, no watcher, no Vite, its own data
 * directory.
 *
 * `dev-loop.ts` next door boots the *dev loop* — `pnpm dev`, `node --watch`,
 * Vite in middleware mode — because that is what its specs are about. These
 * specs are about two daemons contending for one data directory, and the
 * supervisor and the bundler are noise: a restart-on-save in the middle of a
 * lease assertion is a race the spec did not ask for.
 */
import { authorizedFetch } from '@DeFlow/testkit';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const MAIN = join(repoRoot, 'packages/daemon/src/main.ts');

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export const makeDataDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'DeFlow-'));

export const removeDataDir = (dir: string): Promise<void> =>
  process.env.DeFlow_KEEP_TMP === undefined
    ? rm(dir, { recursive: true, force: true })
    : Promise.resolve();

export interface DaemonProcess {
  readonly child: ChildProcess;
  readonly port: number;
  readonly origin: string;
  /**
   * The daemon's bearer token, read out of `<dataDir>/daemon.json` once it is
   * up (KAR-15.2 AC7).
   *
   * Read from the file the daemon actually wrote rather than injected, because
   * that file *is* the handoff: a spec that could not find the token here is a
   * spec telling you `DeFlow status` and `DeFlow run` could not either.
   */
  readonly token: () => string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves with the exit code (or null if it was signalled). */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stop: () => Promise<void>;
}

export interface SpawnOptions {
  readonly dataDir: string;
  readonly port: number;
}

/** Spawns DeFlowd. Does **not** wait for it to be ready — see `waitForHealth`. */
export function spawnDaemon({ dataDir, port }: SpawnOptions): DaemonProcess {
  const out: string[] = [];
  const err: string[] = [];

  const child = spawn(process.execPath, [MAIN], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DeFlow_DATA_DIR: dataDir,
      DeFlow_PORT: String(port),
      DeFlow_LOG_LEVEL: 'info',
      // Not the dev loop: no Vite, no watcher.
      DeFlow_DEV: '0',
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
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000).then(() => child.kill('SIGKILL'))]);
    await exited;
  };

  return {
    child,
    port,
    origin: `http://127.0.0.1:${port}`,
    token: () => {
      const file = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as {
        token: string;
      };
      return file.token;
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    exited,
    stop,
  };
}

export interface Health {
  readonly apiVersion: number;
  readonly build: string;
  readonly pid: number;
  readonly bootId: string;
  readonly uptimeMs: number;
  readonly daemonEpoch: number | null;
  readonly headSeq: number | null;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `/api/health` until it answers, or the daemon dies, or time runs out. */
export async function waitForHealth(daemon: DaemonProcess, timeoutMs = 30_000): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon.child.exitCode !== null) {
      throw new Error(
        `DeFlowd exited with ${daemon.child.exitCode} before answering:\n${daemon.stderr()}`,
      );
    }
    try {
      const response = await fetch(`${daemon.origin}/api/health`);
      if (response.ok) return (await response.json()) as Health;
    } catch {
      // Not listening yet.
    }
    await sleep(50);
  }
  throw new Error(`DeFlowd did not answer /api/health within ${timeoutMs} ms`);
}

/** True when this process can bind `port` — i.e. nobody else has. */
export function bindable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * A `fetch` that speaks to `daemon` as an authenticated client (KAR-15.2).
 *
 * Every route but `GET /api/health` needs the bearer token, and the token is
 * this daemon life's — so it is read from its own `daemon.json` per call
 * rather than captured once, which also means a spec that restarts a daemon
 * keeps working without knowing that it did.
 */
export function asClient(daemon: DaemonProcess): typeof globalThis.fetch {
  return (input, init) => authorizedFetch(daemon.token())(input, init);
}
