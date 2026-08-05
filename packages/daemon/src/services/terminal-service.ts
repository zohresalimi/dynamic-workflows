/**
 * The transport-neutral terminal service (docs/07-provider-adapter-layer.md
 * §3, §9.2).
 *
 * The command allowlist, environment scrubbing and the permission ladder are
 * EPIC-08 (KAR-08.4) and plug in behind `CommandPolicy`. The 1 MiB ring buffer
 * and blob spilling are KAR-05.4; what is here is a bounded buffer that keeps
 * the **tail**, because a truncated head is what you want when a build fails
 * after ten thousand lines of progress output.
 *
 * A plain `spawn`, not a pty, at M1. §9.2 reserves the pty for the cases that
 * genuinely need one (a vendor CLI that refuses to run without a TTY), and
 * `@lydell/node-pty` is an optional dependency precisely so an unsupported
 * platform degrades instead of failing to install.
 *
 * `detached: true` for the same reason the agent gets it: a command that
 * spawns its own children is only reachable as a process group.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

/** What EPIC-08 plugs in. Throws to refuse; returns to allow. */
export interface CommandPolicy {
  authorize(command: string, args: readonly string[]): void;
}

export interface TerminalServiceOptions {
  /** The node's worktree: the default cwd for every command. */
  readonly root: string;
  readonly policy?: CommandPolicy;
  /** Bytes of output kept per terminal. KAR-05.4 makes this a ring buffer
   * with blob spilling; the bound itself is §10's. */
  readonly captureBytes?: number;
}

export const DEFAULT_CAPTURE_BYTES = 1024 * 1024;

export interface CreateTerminalRequest {
  readonly command: string;
  readonly args?: readonly string[];
  /** `null` and absent both mean "the node's worktree" — ACP sends the former. */
  readonly cwd?: string | null;
  readonly env?: readonly { name: string; value: string }[] | null;
}

export interface TerminalExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface TerminalOutput {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus: TerminalExit | null;
}

export interface TerminalService {
  create(request: CreateTerminalRequest): string;
  output(terminalId: string): TerminalOutput;
  waitForExit(terminalId: string): Promise<TerminalExit>;
  kill(terminalId: string): void;
  release(terminalId: string): void;
  /** Everything every terminal of this session has written, for diagnostics. */
  snapshot(): string;
}

interface Terminal {
  readonly child: ChildProcess;
  readonly exited: Promise<TerminalExit>;
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  exit: TerminalExit | null;
}

class UnknownTerminal extends Error {
  constructor(terminalId: string) {
    super(`no terminal with id "${terminalId}" is open on this session`);
    this.name = 'UnknownTerminal';
  }
}

export function createTerminalService(options: TerminalServiceOptions): TerminalService {
  const root = resolve(options.root);
  const capture = options.captureBytes ?? DEFAULT_CAPTURE_BYTES;
  const terminals = new Map<string, Terminal>();
  let next = 0;
  const released: string[] = [];

  const get = (terminalId: string): Terminal => {
    const terminal = terminals.get(terminalId);
    if (terminal === undefined) throw new UnknownTerminal(terminalId);
    return terminal;
  };

  const keep = (terminal: Terminal, bytes: Buffer): void => {
    terminal.chunks.push(bytes);
    terminal.bytes += bytes.byteLength;
    while (terminal.bytes > capture && terminal.chunks.length > 1) {
      // The tail is what explains a failure; the head is what scrolled past.
      terminal.bytes -= (terminal.chunks.shift() as Buffer).byteLength;
      terminal.truncated = true;
    }
  };

  return {
    create(request) {
      options.policy?.authorize(request.command, request.args ?? []);
      next += 1;
      const terminalId = `term-${next}`;
      const child = spawn(request.command, [...(request.args ?? [])], {
        cwd: request.cwd === undefined || request.cwd === null ? root : resolve(root, request.cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env:
          request.env === undefined || request.env === null
            ? process.env
            : { ...process.env, ...Object.fromEntries(request.env.map((e) => [e.name, e.value])) },
      });

      const terminal: Terminal = {
        child,
        chunks: [],
        bytes: 0,
        truncated: false,
        exit: null,
        exited: new Promise<TerminalExit>((settle) => {
          child.once('exit', (exitCode, signal) => {
            const exit = { exitCode, signal };
            terminal.exit = exit;
            settle(exit);
          });
          child.once('error', () => {
            const exit = { exitCode: null, signal: null };
            terminal.exit = exit;
            settle(exit);
          });
        }),
      };
      // The command's own output is not a stream DeFlow has to pace: it is
      // bounded here, and `capture` is the bound.
      child.stdout.on('data', (bytes: Buffer) => keep(terminal, bytes));
      child.stderr.on('data', (bytes: Buffer) => keep(terminal, bytes));
      terminals.set(terminalId, terminal);
      return terminalId;
    },

    output(terminalId) {
      const terminal = get(terminalId);
      return {
        output: Buffer.concat(terminal.chunks).toString('utf8'),
        truncated: terminal.truncated,
        exitStatus: terminal.exit,
      };
    },

    waitForExit: (terminalId) => get(terminalId).exited,

    kill(terminalId) {
      const pid = get(terminalId).child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    },

    release(terminalId) {
      const terminal = get(terminalId);
      released.push(Buffer.concat(terminal.chunks).toString('utf8'));
      terminal.child.stdout?.destroy();
      terminal.child.stderr?.destroy();
      terminals.delete(terminalId);
    },

    snapshot: () =>
      [
        ...released,
        ...[...terminals.values()].map((t) => Buffer.concat(t.chunks).toString('utf8')),
      ].join(''),
  };
}
