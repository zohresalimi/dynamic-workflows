/**
 * Booting the spike's harness as a real subprocess, and looking at it from the
 * outside.
 *
 * Everything here is deliberately observational: `lsof` for the socket count,
 * HTTP for the connection bookkeeping. A spike that proved "one port" by asking
 * the process under test to tell us how many ports it opened would prove
 * nothing at all.
 *
 * Node built-ins only, so the repository's own test slices can import it
 * without depending on this throwaway workspace's node_modules.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const SPIKE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MEASUREMENTS_DIR = fileURLToPath(new URL('../measurements/', import.meta.url));

/** AC1 names this port explicitly, so the recorded run really binds it. */
export const AC1_PORT = 7777;

export interface Harness {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly port: number;
  readonly origin: string;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

export interface Health {
  readonly pid: number;
  readonly port: number;
  readonly mode: string;
  readonly intervalMs: number;
  readonly headSeq: number;
}

export interface Observation {
  readonly at: number;
  readonly path: string;
  readonly since: string | null;
  readonly lastEventId: string | null;
  readonly resumedAfter: number | null;
  readonly mode: string;
}

export interface Observations {
  readonly connections: Observation[];
  readonly open: number;
  readonly closed: number;
}

export interface ListeningSocket {
  readonly address: string;
  readonly port: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const started: Harness[] = [];

export async function stopAll(): Promise<void> {
  while (started.length > 0) {
    const harness = started.pop();
    if (harness !== undefined) await harness.stop();
  }
}

async function spawnAndWait(
  entry: string,
  port: number,
  env: Record<string, string>,
  what: string,
): Promise<Harness> {
  const origin = `http://127.0.0.1:${port}`;
  const chunks: string[] = [];
  const child = spawn(process.execPath, [entry], {
    cwd: SPIKE_ROOT,
    env: { ...process.env, ...env },
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
      }, 4_000).unref();
    });
  };

  const harness: Harness = { child, pid: child.pid ?? -1, port, origin, output, stop };
  started.push(harness);

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${what} exited with ${child.exitCode}:\n${output()}`);
    }
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return harness;
    } catch {
      // Not listening yet.
    }
    await sleep(25);
  }
  await stop();
  throw new Error(`${what} never became healthy:\n${output()}`);
}

/** The one-process harness: Hono, an SSE route, and Vite in middleware mode. */
export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const port = env.S4_PORT === undefined ? await freePort() : Number(env.S4_PORT);
  return await spawnAndWait('server.ts', port, { ...env, S4_PORT: String(port) }, 'the harness');
}

/**
 * The misconfiguration EPIC-00-S12 exists to reproduce once, on purpose: a real
 * Vite dev server with `server.proxy` in front of the harness — the two-port
 * shape D10 rejects. It lives in this throwaway workspace and nowhere else;
 * KAR-01.3's AC7 guard forbids the key anywhere in `packages/`.
 */
export async function startProxy(targetPort: number): Promise<Harness> {
  const port = await freePort();
  return await spawnAndWait(
    'proxy.ts',
    port,
    { S4_PROXY_PORT: String(port), S4_TARGET_PORT: String(targetPort) },
    'the proxy',
  );
}

export async function health(origin: string): Promise<Health> {
  const response = await fetch(`${origin}/api/health`);
  if (!response.ok) throw new Error(`/api/health returned ${response.status}`);
  return (await response.json()) as Health;
}

export async function observations(origin: string): Promise<Observations> {
  const response = await fetch(`${origin}/api/observations`);
  if (!response.ok) throw new Error(`/api/observations returned ${response.status}`);
  return (await response.json()) as Observations;
}

/**
 * Every TCP socket a pid is listening on. The cheapest possible proof that HMR
 * really rides the daemon's own server: if Vite opened its own, the count is
 * two and D10's central claim is false.
 */
export function listeningSockets(pid: number): ListeningSocket[] {
  const lsof = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (lsof.error !== undefined || lsof.stdout === null) {
    throw new Error('lsof is required to count listening sockets and is not available here');
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
