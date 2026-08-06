/**
 * A minimal MCP client over a real `DeFlow-mcp` child process.
 *
 * Hand-written rather than `@modelcontextprotocol/sdk/client/index.js` for two
 * reasons, and both are the point of the story. First, AC4 bounds the whole
 * workspace to two deep server subpaths, and a spec that reached for a client
 * subpath would be the first crack in the rule it is meant to protect. Second,
 * the scenarios assert on **frames** — that a `notifications/tools/list_changed`
 * arrives, that a tool result carries `structuredContent` — and an SDK client
 * would fold those back into method calls and hide the thing under test.
 *
 * The child is spawned from an `McpServer` entry exactly as an agent would
 * spawn it: same `command`, same `args`, same `env`. Nothing here knows the
 * socket path or the token; it only replays what `session/new` carried.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';

export interface McpServerEntryShape {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

export interface JsonRpcMessage {
  readonly jsonrpc: '2.0';
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface ToolDescriptor {
  readonly name: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

export class McpCallFailed extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'McpCallFailed';
  }
}

/** The MCP revision `@modelcontextprotocol/sdk@1.30.0` declares as latest. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

export interface McpChild {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  /** Every notification the server pushed, in arrival order. */
  readonly notifications: JsonRpcMessage[];
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  listTools(): Promise<ToolDescriptor[]>;
  /** Resolves once `method` has been seen at least `count` times. */
  waitForNotification(method: string, count?: number): Promise<void>;
  /**
   * A barrier for one *specific* push: it counts what has already arrived and
   * resolves on the next `method` after that.
   *
   * `waitForNotification(method, n)` cannot express this. It is a claim about a
   * running total, so it is satisfied by anything that already happened — and
   * the caller that wants a barrier is always the caller that just did
   * something and needs to know that *that* has landed. Await this before
   * causing the change, not after:
   *
   *     const applied = agent.nextNotification(TOOL_LIST_CHANGED);
   *     grant.setPhase('analysis');
   *     await applied;
   */
  nextNotification(method: string): Promise<void>;
  /** EOF on the child's stdin — what an agent's death looks like from here. */
  closeStdin(): void;
  stderr(): string;
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
}

/**
 * Spawns the shim the way the agent would and completes the MCP handshake.
 *
 * `handshake: false` leaves the child unspoken-to, which is what the bad-token
 * spec needs: it asserts the process refuses *before* it ever serves a tool.
 */
export function spawnMcpServer(
  entry: McpServerEntryShape,
  options: { readonly handshake?: boolean } = {},
): { started: McpChild; ready: Promise<McpChild> } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of entry.env) env[variable.name] = variable.value;

  const child = spawn(entry.command, [...entry.args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  const notifications: JsonRpcMessage[] = [];
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  const notificationWaiters: { method: string; count: number; resolve: () => void }[] = [];
  let stderrText = '';
  let nextId = 1;
  let buffer = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      const message = JSON.parse(line) as JsonRpcMessage;
      if (message.id !== undefined && message.method === undefined) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
        continue;
      }
      notifications.push(message);
      for (const waiter of [...notificationWaiters]) {
        const seen = notifications.filter((n) => n.method === waiter.method).length;
        if (seen >= waiter.count) {
          notificationWaiters.splice(notificationWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    }
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const api: McpChild = {
    pid: child.pid ?? -1,
    child,
    notifications,
    request(method, params) {
      const id = nextId++;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, (message) => {
          if (message.error !== undefined) {
            reject(new McpCallFailed(message.error.message, message.error.code));
            return;
          }
          resolve(message.result ?? {});
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async listTools() {
      const result = await api.request('tools/list', {});
      return (result.tools ?? []) as ToolDescriptor[];
    },
    waitForNotification(method, count = 1) {
      const seen = notifications.filter((n) => n.method === method).length;
      if (seen >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        notificationWaiters.push({ method, count, resolve });
      });
    },
    nextNotification(method) {
      return api.waitForNotification(
        method,
        notifications.filter((n) => n.method === method).length + 1,
      );
    },
    closeStdin: () => child.stdin.end(),
    stderr: () => stderrText,
    exited: () => exit,
    kill: () => child.kill('SIGKILL'),
  };

  const ready = (async (): Promise<McpChild> => {
    if (options.handshake === false) return api;
    await api.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'DeFlow-test-agent', version: '0.0.0' },
    });
    api.notify('notifications/initialized', {});
    return api;
  })();

  return { started: api, ready };
}
