/**
 * KAR-05.6 — `DeFlow-mcp`: `StdioServerTransport` on one side, a Unix domain
 * socket back to DeFlowd on the other, and as little as possible in between.
 *
 * It is a shim and not a server. No tool does any work here: every call is
 * relayed to DeFlowd, which owns the ledger, the blackboard and the decision
 * about whether the caller is allowed to make it. What the shim owns is the
 * MCP surface — the tool descriptors with both schemas, the `tools/list`
 * answer, and the `sendToolListChanged()` push when a phase changes it.
 *
 * **Two SDK imports, both deep subpaths.** `server/mcp.js` and
 * `server/stdio.js` and nothing else, enforced repo-wide by
 * `checkMcpSdkImports`. The package root pulls express, hono, cors, jose and
 * eventsource into a process that speaks over a pipe, and `npx DeFlow up` pays
 * for that on every start (NF6, docs/07-provider-adapter-layer.md §7.3).
 *
 * **It exits when its stdin closes** (AC7). An agent's death closes the pipe,
 * and a shim that survived it would sit holding a socket nobody will speak on
 * again — one leaked process per crashed node, which is the shape of leak
 * nobody notices until a machine is out of file descriptors.
 *
 * **A tool call the shim itself refuses is still reported.** The MCP SDK
 * short-circuits a disabled tool before the handler runs, so without the
 * observation hook below, "the agent called a tool the phase withdrew" would
 * be invisible to the run that needs to explain itself. The hook sits on the
 * transport's `onmessage`, which is the same place KAR-05.7's tee sits and for
 * the same reason: it is the last point where the frame is still a frame.
 */

import { createConnection } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { M1_TOOLS } from './catalog.ts';
import {
  BRIDGE_VERSION,
  encodeFrame,
  type HostFrame,
  lineReader,
  parseHostFrame,
} from './protocol.ts';
import { RUN_TOKEN_ENV } from './server-entry.ts';

export const SHIM_NAME = 'DeFlow-mcp';
export const SHIM_VERSION = '0.0.0';

/** Exit codes, so a spec and an operator read the same failures. */
export const EX_USAGE = 64;
export const EX_UNAVAILABLE = 69;
/** The daemon refused the token. Its own code because it is not a crash. */
export const EX_REFUSED = 77;

export interface ShimOptions {
  /** argv after the entry path: `--socket <path> --run <runId>`. */
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** Where refusals and usage errors go. Never stdout: that is MCP's. */
  readonly stderr: Writable;
}

/** The one member of the MCP transport this shim observes. @see runMcpShim */
interface MessageHook {
  onmessage?: (message: unknown, extra?: unknown) => void;
}

interface ParsedArgv {
  readonly socket: string;
  readonly run: string;
}

export function parseShimArgv(argv: readonly string[]): ParsedArgv {
  let socket = '';
  let run = '';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--socket') socket = argv[index + 1] ?? '';
    if (argv[index] === '--run') run = argv[index + 1] ?? '';
  }
  if (socket === '' || run === '') {
    throw new Error(`usage: ${SHIM_NAME} --socket <path> --run <runId>`);
  }
  return { socket, run };
}

/**
 * Runs the shim to completion and resolves with the process exit code.
 *
 * Never throws: every failure this can have is one an agent caused, and an
 * unhandled rejection inside a process the agent spawned is a stack trace on
 * somebody else's stderr.
 */
export function runMcpShim(options: ShimOptions): Promise<number> {
  return new Promise<number>((resolve) => {
    const fail = (code: number, message: string): void => {
      options.stderr.write(`${SHIM_NAME}: ${message}\n`);
      resolve(code);
    };

    let parsed: ParsedArgv;
    try {
      parsed = parseShimArgv(options.argv);
    } catch (error) {
      fail(EX_USAGE, error instanceof Error ? error.message : String(error));
      return;
    }

    const token = options.env[RUN_TOKEN_ENV] ?? '';
    if (token === '') {
      fail(EX_USAGE, `${RUN_TOKEN_ENV} is not set; this bin is spawned by DeFlowd, not by hand`);
      return;
    }

    const socket = createConnection(parsed.socket);
    socket.setEncoding('utf8');
    const read = lineReader();

    const server = new McpServer(
      { name: SHIM_NAME, version: SHIM_VERSION },
      { capabilities: { tools: { listChanged: true } } },
    );

    /** id → the resolver waiting for the daemon's answer. */
    const pending = new Map<number, (frame: HostFrame) => void>();
    let nextId = 1;
    let permitted: ReadonlySet<string> = new Set();
    let connected = false;
    let settled = false;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      void server.close().catch(() => {
        // Closing a transport whose stdin already ended is not a failure.
      });
      resolve(code);
    };

    const call = (tool: string, args: Record<string, unknown>): Promise<HostFrame> => {
      const id = nextId++;
      return new Promise<HostFrame>((answer) => {
        pending.set(id, answer);
        socket.write(encodeFrame({ t: 'call', id, tool, args }));
      });
    };

    const registered = M1_TOOLS.map((tool) => ({
      tool,
      handle: server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        },
        async (args: Record<string, unknown>) => {
          const answer = await call(tool.name, args);
          if (answer.t === 'result') {
            return {
              structuredContent: answer.value,
              content: [{ type: 'text' as const, text: JSON.stringify(answer.value) }],
            };
          }
          const message = answer.t === 'error' ? answer.message : 'the daemon closed the socket';
          // `isError` rather than a thrown McpError: a refusal is information
          // the model can act on inside its own loop, and the SDK skips output
          // validation for an error result.
          return { isError: true, content: [{ type: 'text' as const, text: message }] };
        },
      ),
    }));

    /** Applies the daemon's tool list and announces the change (AC6). */
    const applyTools = (tools: readonly string[], announce: boolean): void => {
      permitted = new Set(tools);
      for (const entry of registered) {
        const allowed = permitted.has(entry.tool.name);
        if (entry.handle.enabled === allowed) continue;
        // enable()/disable() each send their own list_changed; the explicit
        // call below is what makes the *set* change one announcement rather
        // than one per tool.
        if (allowed) entry.handle.enable();
        else entry.handle.disable();
      }
      if (announce) server.sendToolListChanged();
    };

    socket.on('error', (error: Error) => {
      if (settled) return;
      fail(EX_UNAVAILABLE, `cannot reach DeFlowd on ${parsed.socket}: ${error.message}`);
      settled = true;
    });

    socket.on('close', () => {
      for (const answer of pending.values()) answer({ t: 'refused', reason: 'socket closed' });
      pending.clear();
      // A daemon that goes away mid-run takes the shim with it: staying alive
      // would leave the agent holding tools that can no longer do anything.
      if (connected) finish(0);
    });

    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = read(chunk);
      } catch (error) {
        fail(EX_UNAVAILABLE, error instanceof Error ? error.message : String(error));
        settled = true;
        return;
      }
      for (const line of lines) {
        let frame: HostFrame;
        try {
          frame = parseHostFrame(line);
        } catch (error) {
          fail(EX_UNAVAILABLE, error instanceof Error ? error.message : String(error));
          settled = true;
          return;
        }
        if (frame.t === 'refused') {
          if (!connected) {
            fail(EX_REFUSED, `DeFlowd refused this connection: ${frame.reason}`);
            settled = true;
            socket.destroy();
          }
          continue;
        }
        if (frame.t === 'welcome') {
          connected = true;
          applyTools(frame.tools, false);
          void start();
          continue;
        }
        if (frame.t === 'tools') {
          applyTools(frame.tools, true);
          continue;
        }
        const answer = pending.get(frame.id);
        pending.delete(frame.id);
        answer?.(frame);
      }
    });

    socket.on('connect', () => {
      socket.write(encodeFrame({ t: 'hello', v: BRIDGE_VERSION, run: parsed.run, token }));
    });

    /** Connected and told what it may serve — only now is stdio spoken on. */
    const start = async (): Promise<void> => {
      const transport = new StdioServerTransport(options.stdin, options.stdout);
      await server.connect(transport);

      // The observation hook. `server.connect` has just installed the SDK's
      // own `onmessage`; wrapping it here is the only seam that sees a
      // `tools/call` for a tool the SDK is about to refuse on its own.
      //
      // Read through a local shape rather than the SDK's generic signature:
      // this wrapper deliberately looks at nothing but `method` and
      // `params.name` and forwards the frame untouched, and typing it as the
      // generic would be claiming a knowledge of the frame it does not have
      // and must not act on.
      const hook = transport as unknown as MessageHook;
      const inner = hook.onmessage;
      hook.onmessage = (message: unknown, extra?: unknown): void => {
        const request = message as { method?: string; params?: { name?: string } };
        const name = request.params?.name;
        if (request.method === 'tools/call' && name !== undefined && !permitted.has(name)) {
          socket.write(encodeFrame({ t: 'denied', tool: name }));
        }
        inner?.(message, extra);
      };

      // AC7. The agent's death is an EOF on this pipe and nothing else, so
      // this is the one signal that must never be missed.
      options.stdin.once('end', () => finish(0));
      options.stdin.once('close', () => finish(0));
    };
  });
}
