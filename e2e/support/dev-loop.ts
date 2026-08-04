/**
 * Boots the *real* dev loop for the e2e specs: the `dev` script exactly as it
 * is written in the root package.json, run from the repo root.
 *
 * The script is read rather than duplicated so the specs can never drift from
 * the command a developer actually types. It is executed with `sh -c` — which
 * is what pnpm does with a script body — so the process tree under test is the
 * `node --watch` supervisor and the daemon it supervises, with no extra pnpm
 * process muddying the "exactly one listening socket" assertion.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function devScript(): string {
  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const dev = root.scripts?.dev;
  if (dev === undefined) throw new Error('the root package.json declares no "dev" script');
  return dev;
}

/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
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

export interface Health {
  readonly apiVersion: number;
  readonly build: string;
  readonly pid: number;
  readonly bootId: string;
  readonly uptimeMs: number;
  readonly daemonEpoch: number | null;
  readonly headSeq: number | null;
}

export interface DevLoop {
  readonly child: ChildProcess;
  readonly port: number;
  readonly origin: string;
  /** Milliseconds from spawn to the first 200 on /api/health (NF3). */
  readonly coldStartMs: number;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

export interface StartOptions {
  /** Heartbeat cadence for /api/stream; tightened so specs do not wait 15 s. */
  readonly heartbeatMs?: number;
  readonly timeoutMs?: number;
}

export async function startDevLoop(options: StartOptions = {}): Promise<DevLoop> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const chunks: string[] = [];

  const startedAt = performance.now();
  const child = spawn('sh', ['-c', devScript()], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DeFlow_PORT: String(port),
      DeFlow_SSE_HEARTBEAT_MS: String(options.heartbeatMs ?? 250),
      DeFlow_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

  const output = () => chunks.join('');

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000).unref();
    });
  };

  try {
    await waitForHealth(origin, options.timeoutMs ?? 30_000, () => {
      if (child.exitCode !== null) {
        throw new Error(`the dev loop exited with code ${child.exitCode}:\n${output()}`);
      }
    });
  } catch (error) {
    await stop();
    throw new Error(`${(error as Error).message}\n--- dev loop output ---\n${output()}`);
  }

  return { child, port, origin, coldStartMs: performance.now() - startedAt, output, stop };
}

export async function health(origin: string): Promise<Health> {
  const response = await fetch(`${origin}/api/health`);
  if (!response.ok) throw new Error(`/api/health returned ${response.status}`);
  return (await response.json()) as Health;
}

export async function waitForHealth(
  origin: string,
  timeoutMs: number,
  check?: () => void,
): Promise<Health> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    check?.();
    try {
      return await health(origin);
    } catch (error) {
      last = (error as Error).message;
      await sleep(25);
    }
  }
  throw new Error(`/api/health never came up within ${timeoutMs} ms (last error: ${last})`);
}

/** Wait until /api/health reports a boot id other than the one given. */
export async function waitForRestart(
  origin: string,
  previousBootId: string,
  timeoutMs: number,
): Promise<{ health: Health; elapsedMs: number }> {
  const startedAt = performance.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = await health(origin);
      if (current.bootId !== previousBootId) {
        return { health: current, elapsedMs: performance.now() - startedAt };
      }
    } catch {
      // The window where the old process has died and the new one has not yet
      // bound the port is the restart itself, not a failure.
    }
    await sleep(20);
  }
  throw new Error(`the daemon did not restart within ${timeoutMs} ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ListeningSocket {
  readonly address: string;
  readonly port: number;
}

/**
 * Every TCP socket the given pid is listening on. Used to prove D10's premise:
 * middleware mode means one socket, where the two-process shape means two.
 */
export function listeningSockets(pid: number): ListeningSocket[] {
  const lsof = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (lsof.error !== undefined || lsof.stdout === null) {
    throw new Error(
      'lsof is required to count listening sockets and is not available on this machine',
    );
  }
  const sockets: ListeningSocket[] = [];
  for (const line of lsof.stdout.split('\n').slice(1)) {
    const match = /(\S+):(\d+)\s+\(LISTEN\)/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      sockets.push({ address: match[1], port: Number(match[2]) });
    }
  }
  return sockets;
}
