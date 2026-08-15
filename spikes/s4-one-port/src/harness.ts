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

/**
 * `port` if this machine will let us have it, and a free one if it will not.
 *
 * KAR-00.10. `AC1_PORT` is 7777 because AC1 is a claim about that socket, and
 * for a long time every spec in `test/integration/spike-s4-one-port.test.ts`
 * was handed it flat. A fixed port is a shared resource on a developer's
 * machine, and 7777 is not just any fixed port: it is DeFlow's own default
 * (docs/03-local-development.md §9), so the thing most likely to be sitting on
 * it is a `deflow up` from earlier in the day. Twelve leaked daemons were
 * cleared off this machine on 2026-08-15 and one of them held it. The result
 * was that the whole file died in `beforeAll` with twenty-five skipped tests
 * and a message about a foreign pid — a suite-level failure that says nothing
 * about SSE, HMR, mount order or resume, which is all those specs are about.
 *
 * Deliberately not `freePort()`: preferring 7777 keeps the ordinary run binding
 * the port the spike is written about, so the demonstration is the real one.
 * This only steps aside when it has to, and the caller that genuinely means
 * "this exact port or nothing" — `startHarness` with an explicit `S4_PORT` —
 * still gets the named refusal below.
 *
 * There is a race between letting the probe go and the child binding: something
 * else can take the port in between. That is what the pid comparison in
 * `spawnAndWait` is for, and it turns the race into a named failure rather than
 * a silently wrong subject.
 */
export async function preferredPort(port: number): Promise<number> {
  const available = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  return available ? port : await freePort();
}

const started: Harness[] = [];

export async function stopAll(): Promise<void> {
  while (started.length > 0) {
    const harness = started.pop();
    if (harness !== undefined) await harness.stop();
  }
}

/**
 * Reads the pid out of a `/api/health` body, or `undefined` when the body is
 * not this server's own health payload.
 *
 * Two of the harness's own modes answer that route with something else, and
 * both are the point of the spec that uses them rather than accidents:
 * `S4_MODE=fallback-first` deliberately lets the SPA fallback shadow the API,
 * so the body is `index.html`, and `proxy.ts` forwards the route to its target,
 * so the pid it returns is the *target's* and never its own. Neither can answer
 * "is this the child I spawned", so neither is asked.
 */
async function reportedPid(response: Response): Promise<number | undefined> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return undefined;
  try {
    const body = (await response.json()) as { pid?: unknown };
    return typeof body.pid === 'number' ? body.pid : undefined;
  } catch {
    return undefined;
  }
}

async function spawnAndWait(
  entry: string,
  port: number,
  env: Record<string, string>,
  what: string,
  /** False where `/api/health` is not this process's own — see `reportedPid`. */
  ownsHealth = true,
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
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) {
        // "Something answers here" is not "the child I just spawned answers
        // here", and on a fixed port they come apart. `startHarness` is handed
        // AC1_PORT — 7777, because AC1 is a claim about that exact socket — so
        // a stray server left behind by an earlier run answers this probe
        // perfectly: same code, same routes, same headers. The child that was
        // just spawned meanwhile dies of EADDRINUSE, and because its exit is
        // raced against this fetch, the loop can return before noticing.
        //
        // Everything downstream then runs against the stranger. Routing,
        // headers and socket-count specs pass, because a stranger running the
        // same code serves those identically; only a spec whose meaning depends
        // on *this* run's history can tell, and it reports the disagreement as
        // a broken stream. Measured on the EPIC-19 gate: a `server.ts` from six
        // days earlier still on 7777, and `EPIC-00-S13`'s Last-Event-ID spec
        // failing twice with "0 received" against a server whose sequence had
        // been climbing the whole time.
        //
        // The payload has always carried the server's own pid. Comparing it is
        // the difference between that and a failure that names the squatter.
        const reported = ownsHealth ? await reportedPid(response) : undefined;
        if (reported !== undefined && reported !== child.pid) {
          await stop();
          throw new Error(
            `${what} was asked for 127.0.0.1:${port}, but pid ${String(reported)} is already ` +
              `listening there — this run spawned pid ${String(child.pid)}. Adopting it would ` +
              `test somebody else's server.\n` +
              // The fix, spelled out. 7777 is DeFlow's own default port, so the
              // usual squatter is a `deflow up` somebody forgot, and "it is
              // already in use" is not an actionable sentence at 6pm.
              `  Find it:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
              `  Free it:  kill ${String(reported)}\n` +
              (port === AC1_PORT
                ? `  Or leave it: the specs no longer need ${String(AC1_PORT)} in particular — see preferredPort() in this file.\n`
                : '') +
              output(),
          );
        }
        return harness;
      }
    } catch (error) {
      // A refusal raised above is the answer, not a "not listening yet".
      if (error instanceof Error && error.message.includes('is already')) throw error;
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
    // The proxy forwards `/api/health` to the harness behind it, so the pid it
    // reports is that harness's. There is nothing here to compare a pid to.
    false,
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
