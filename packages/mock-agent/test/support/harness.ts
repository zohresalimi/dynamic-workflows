/**
 * The harness plays the part DeFlowd plays in production: it spawns the real
 * `DeFlow-mock-agent` binary as a child process and talks ACP to it over the
 * child's own stdin and stdout.
 *
 * Two things here are deliberate rather than incidental.
 *
 * The **absolute path**: `MOCK_AGENT_BIN` is resolved from this file's own URL
 * and handed to `spawn` verbatim. DeFlowd's `PATH` at daemon start is not the
 * user's login-shell `PATH`, so production code stores a resolved path rather
 * than a bare name it looks up again at spawn time
 * (docs/07-provider-adapter-layer.md §4.3), and the harness mirrors that rule.
 *
 * The **tee**: every byte the child writes is kept in `stdout()` *and* fed to
 * `acp.ndJsonStream`, because two different questions are asked of the same
 * output. "Did the turn complete?" is a question about parsed frames; "are two
 * seeded runs byte-identical?" is a question about bytes, and normalising the
 * bytes through a parser first would answer a weaker question than the one
 * EPIC-04-S2 asks.
 *
 * `detached: true` is the production spawn mode (§9.3); testing under
 * `detached: false` would exercise a process-group topology DeFlowd never
 * creates.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

/** The binary under test, absolute. Never a bare name looked up on PATH. */
export const MOCK_AGENT_BIN = fileURLToPath(new URL('../../bin/mock-agent.ts', import.meta.url));

/**
 * The one directory the suite's scenario files live in (KAR-04.2 AC7), so a
 * spec names a scenario rather than spelling a relative path that quietly
 * stops resolving when the spec moves.
 */
export const SCENARIO_DIR = fileURLToPath(new URL('../../scenarios/', import.meta.url));

/** Absolute path to a scenario in `SCENARIO_DIR`. */
export function scenarioPath(name: string): string {
  return join(SCENARIO_DIR, name);
}

export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnMockAgentOptions {
  /** Replaces the child's environment wholesale when given. */
  readonly env?: NodeJS.ProcessEnv;
  /** The binary to spawn. Defaults to `MOCK_AGENT_BIN`. */
  readonly bin?: string;
  /**
   * The child's working directory. Defaults to the runner's own.
   *
   * Only a determinism spec has any use for it: "the document is the same
   * whatever machine it was generated on" is not answerable without moving the
   * process somewhere else first.
   */
  readonly cwd?: string;
}

export interface SpawnedAgent {
  readonly child: ChildProcessWithoutNullStreams;
  /** The ndjson transport, ready to be handed to an `acp.ClientApp`. */
  readonly stream: acp.Stream;
  /** Every byte the child has written to stdout so far, in order. */
  stdout(): Buffer;
  stderr(): string;
  /** Closes stdin and resolves once the child has exited. */
  finish(): Promise<AgentExit>;
  /** Resolves once the child has exited, without touching stdin. */
  exited(): Promise<AgentExit>;
}

export function spawnMockAgent(
  args: readonly string[],
  options: SpawnMockAgentOptions = {},
): SpawnedAgent {
  const child = spawn(options.bin ?? MOCK_AGENT_BIN, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  const rawStdout: Buffer[] = [];
  const rawStderr: Buffer[] = [];
  const tee = new PassThrough();
  child.stdout.on('data', (bytes: Buffer) => {
    rawStdout.push(bytes);
    tee.write(bytes);
  });
  child.stdout.on('end', () => {
    tee.end();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    rawStderr.push(bytes);
  });

  // Registered at spawn time, not when finish() is called: an exit that lands
  // between the two would otherwise never be observed and the test would hang
  // until the slice timeout rather than failing on the assertion.
  //
  // It resolves on the *later* of the exit event and the end of stdout, because
  // the two are not ordered: a child can be reaped while its last frame is
  // still in the pipe, and a spec that asserted on `stdout()` at exit would
  // then read a truncated buffer and report the mock's bug as its own.
  const exit = Promise.all([
    new Promise<AgentExit>((resolve) => {
      child.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    }),
    new Promise<void>((resolve) => {
      child.stdout.on('end', resolve);
      child.stdout.on('close', resolve);
    }),
  ]).then(([status]) => status);

  return {
    child,
    stream: acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(tee)),
    stdout: () => Buffer.concat(rawStdout),
    stderr: () => Buffer.concat(rawStderr).toString('utf8'),
    exited: () => exit,
    finish: async () => {
      child.stdin.end();
      return exit;
    },
  };
}

/**
 * Kills the child's whole process group.
 *
 * The only way to end a wedged agent, and the only way to reach the
 * grandchildren a crashed one leaves behind — which is why DeFlowd records the
 * pgid rather than the pid (docs/07-provider-adapter-layer.md §9.3). The
 * negative pid is the group; `detached: true` at spawn is what makes the child
 * its leader.
 */
export function killProcessGroup(agent: SpawnedAgent, signal: NodeJS.Signals = 'SIGKILL'): void {
  const pid = agent.child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already reaped. Nothing to do, and nothing to report: a spec that
    // finished normally has usually already ended the child.
  }
}

/** One outbound request the agent made back into the client. */
export interface ClientCallRecord {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface ClientStubs {
  /**
   * Answers `session/request_permission` with a `RequestPermissionOutcome` —
   * the inner value, which is what EPIC-04-S6's table is written in. Defaults
   * to `{ outcome: 'cancelled' }`, the variant implementations forget.
   */
  readonly permission?: (
    params: acp.RequestPermissionRequest,
  ) => acp.RequestPermissionOutcome | Promise<acp.RequestPermissionOutcome>;
  /**
   * Answers one of the seven `fs/*` / `terminal/*` methods. Returning
   * `undefined` falls through to the stock reply; throwing an
   * `acp.RequestError` is how a spec makes the client refuse.
   */
  readonly respond?: (method: string, params: Record<string, unknown>) => unknown;
}

export interface ConnectedClient {
  readonly connection: acp.ClientConnection;
  /** Every `session/update` notification, in arrival order. */
  readonly updates: acp.SessionNotification[];
  /**
   * `performance.now()` at the moment each notification was handled, one entry
   * per `updates` entry. Cadence is a property of *arrival*, so it has to be
   * sampled here rather than read out of the frame the agent wrote.
   */
  readonly arrivals: number[];
  /** Every request the agent sent back into the client, in call order. */
  readonly calls: ClientCallRecord[];
}

/** The stock replies, so a spec only writes the one answer it cares about. */
const STOCK_REPLIES: Record<string, unknown> = {
  'fs/read_text_file': { content: 'stub file content\n' },
  'fs/write_text_file': {},
  'terminal/create': { terminalId: 'stub-terminal-1' },
  'terminal/output': { output: 'stub terminal output\n', truncated: false },
  'terminal/wait_for_exit': { exitCode: 0, signal: null },
  'terminal/kill': {},
  'terminal/release': {},
};

/** The seven client methods a `clientCall` step can name, in lifecycle order. */
export const CLIENT_METHODS = [
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
] as const;

/** An ACP client built on the SDK, wrapped around a spawned agent's pipes. */
export function connectClient(agent: SpawnedAgent, stubs: ClientStubs = {}): ConnectedClient {
  const updates: acp.SessionNotification[] = [];
  const arrivals: number[] = [];
  const calls: ClientCallRecord[] = [];

  const app = acp.client().onNotification('session/update', ({ params }) => {
    updates.push(params);
    arrivals.push(performance.now());
  });

  app.onRequest('session/request_permission', async ({ params }) => {
    calls.push({ method: 'session/request_permission', params: params as never });
    return { outcome: (await stubs.permission?.(params)) ?? { outcome: 'cancelled' } };
  });

  for (const method of CLIENT_METHODS) {
    // The handler is registered for every method whether or not the spec
    // stubs it: a method the client never registered comes back as a JSON-RPC
    // -32601, which would make "the agent skipped the step" and "the client
    // does not implement it" the same observation.
    app.onRequest(method, ({ params }) => {
      calls.push({ method, params: params as never });
      const answered = stubs.respond?.(method, params as never);
      return (answered ?? STOCK_REPLIES[method]) as never;
    });
  }

  return { connection: app.connect(agent.stream), updates, arrivals, calls };
}

/** The client capabilities EPIC-04-S1 sends: real fs and terminal support. */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
} as const;

/** Every non-empty line the child wrote, parsed. */
export function frames(stdout: Buffer): Record<string, unknown>[] {
  return stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
