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
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

/** The binary under test, absolute. Never a bare name looked up on PATH. */
export const MOCK_AGENT_BIN = fileURLToPath(new URL('../../bin/mock-agent.ts', import.meta.url));

export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnMockAgentOptions {
  /** Replaces the child's environment wholesale when given. */
  readonly env?: NodeJS.ProcessEnv;
  /** The binary to spawn. Defaults to `MOCK_AGENT_BIN`. */
  readonly bin?: string;
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

export interface ConnectedClient {
  readonly connection: acp.ClientConnection;
  /** Every `session/update` notification, in arrival order. */
  readonly updates: acp.SessionNotification[];
}

/** An ACP client built on the SDK, wrapped around a spawned agent's pipes. */
export function connectClient(agent: SpawnedAgent): ConnectedClient {
  const updates: acp.SessionNotification[] = [];
  const app = acp.client().onNotification('session/update', ({ params }) => {
    updates.push(params);
  });
  return { connection: app.connect(agent.stream), updates };
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
