/**
 * The transport-neutral terminal service (docs/07-provider-adapter-layer.md
 * §3, §9.2).
 *
 * The command allowlist and the permission ladder plug in behind
 * `CommandPolicy` (KAR-08.3, ./command-mediation.ts); environment scrubbing is
 * KAR-08.4's `childEnv` option, below. `terminal/create` is an ACP method the
 * *agent* invokes, which makes this exactly the boundary the Kiro incident
 * crossed: `childEnv` is required, never defaulted to `process.env`, because
 * a service that fell back to the daemon's own environment when a caller
 * forgot to build one would be the ambient-authority bug wearing an optional
 * parameter (docs/15-security-model.md §4). Build it once with
 * `buildChildEnv()` (../proc/env.ts) and pass the result in. The 1 MiB ring
 * buffer and blob spilling are KAR-05.4; what is here is a bounded buffer
 * that keeps the **tail**, because a truncated head is what you want when a
 * build fails after ten thousand lines of progress output.
 *
 * A plain `spawn`, not a pty, at M1. §9.2 reserves the pty for the cases that
 * genuinely need one (a vendor CLI that refuses to run without a TTY), and
 * `@lydell/node-pty` is an optional dependency precisely so an unsupported
 * platform degrades instead of failing to install.
 *
 * `detached: true` for the same reason the agent gets it: a command that
 * spawns its own children is only reachable as a process group.
 */
import { killTree } from '@DeFlow/adapters';
import type { Handle } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * What EPIC-08 plugs in. Throws to refuse; returns the cwd to run in.
 *
 * It answers with a path rather than with a boolean because the resolution and
 * the decision have to be the same act: a service that resolved the cwd itself
 * and then asked whether the policy liked the result would have two
 * resolutions of one string, and the one `spawn` received would be the one
 * nobody checked. Same rule as `PathPolicy` in ./fs-service.ts, and the same
 * reason.
 *
 * It is `async` because a gated command **waits for a human** — the request is
 * suspended, not pre-authorised, and nothing is spawned until the operator has
 * answered. A rejection is a thrown `PermissionDeniedError`, and by the time
 * it is thrown no process exists to have to clean up.
 */
export interface CommandPolicy {
  authorize(request: CreateTerminalRequest): Promise<string>;
}

/**
 * Where a terminal's **full** output goes, so the ring buffer in front of it
 * can stay bounded (KAR-05.4 AC7).
 *
 * A port rather than a direct dependency on the blob store: this service is
 * transport-neutral and storage-neutral, and the daemon is what knows there is
 * a `~/.DeFlow/blobs` to spill into. `@DeFlow/ledger`'s `openBlobSpill` is the
 * implementation it passes in — it hashes as it writes, so nothing here ever
 * holds the whole of a 40 MB build log.
 */
export interface TerminalCapture {
  write(bytes: Uint8Array): void;
  /** Publishes what has been captured and returns its handle. Idempotent. */
  publish(): Handle;
  discard(): void;
}

export interface TerminalServiceOptions {
  /** The node's worktree: the default cwd for every command. */
  readonly root: string;
  /**
   * The environment every terminal this service creates receives (KAR-08.4).
   * Build it once with `buildChildEnv()` — required, never defaulted to
   * `process.env`, so a caller cannot silently reintroduce the Kiro bug by
   * omitting it.
   */
  readonly childEnv: Readonly<Record<string, string>>;
  readonly policy?: CommandPolicy;
  /** Bytes of output kept per terminal, and answered to `terminal/output`.
   * The bound is §10's; the ring buffer keeps the tail. */
  readonly captureBytes?: number;
  /**
   * Opens the full-output capture for one terminal. Omitted, output beyond the
   * ring buffer is genuinely gone and `fullOutput` says so by returning null —
   * which is the honest answer, not a silent prefix.
   */
  readonly openCapture?: (terminalId: string) => TerminalCapture;
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
  /** Resolves once the policy has answered — which, for a gated command, is
   * once the operator has. No process exists before then. */
  create(request: CreateTerminalRequest): Promise<string>;
  output(terminalId: string): TerminalOutput;
  waitForExit(terminalId: string): Promise<TerminalExit>;
  kill(terminalId: string): void;
  release(terminalId: string): void;
  /**
   * The handle the terminal's **whole** output can be read back through, or
   * null when no capture was configured. This is what makes the truncation in
   * `output()` a bound rather than a loss (AC7).
   */
  fullOutput(terminalId: string): Handle | null;
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
  readonly capture: TerminalCapture | null;
  published: Handle | null;
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

  /**
   * The ring buffer, and the whole of AC7's "bounded on the way in".
   *
   * Two things it must do that the obvious loop does not. It has to cut
   * *inside* a chunk once dropping whole ones is not enough, or the bound
   * becomes "`captureBytes`, or one read, whichever is larger" — which happens
   * to be 1 MiB + 64 KiB today only because that is how much Node reads from a
   * pipe at a time, and is not a property of this service. And it has to hand
   * every byte to the capture *first*, because what the capture holds is the
   * output this buffer is allowed to forget.
   */
  const keep = (terminal: Terminal, bytes: Buffer): void => {
    terminal.capture?.write(bytes);

    terminal.chunks.push(bytes);
    terminal.bytes += bytes.byteLength;
    while (terminal.bytes > capture) {
      const oldest = terminal.chunks[0] as Buffer;
      terminal.truncated = true;
      const excess = terminal.bytes - capture;
      if (excess >= oldest.byteLength) {
        terminal.chunks.shift();
        terminal.bytes -= oldest.byteLength;
        continue;
      }
      // The tail is what explains a failure; the head is what scrolled past.
      terminal.chunks[0] = oldest.subarray(excess);
      terminal.bytes -= excess;
    }
  };

  return {
    async create(request) {
      // The policy answers with the cwd, and there is no other source for one:
      // resolving it again here is how the path that was checked and the path
      // that is used come apart. Its rejection propagates — the ACP front
      // turns it into a JSON-RPC error — and nothing below has run by then.
      const cwd =
        options.policy === undefined
          ? request.cwd === undefined || request.cwd === null
            ? root
            : resolve(root, request.cwd)
          : await options.policy.authorize(request);
      next += 1;
      const terminalId = `term-${next}`;
      const child = spawn(request.command, [...(request.args ?? [])], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        // KAR-08.4: the scrubbed base first, then the agent's own explicit
        // `terminal/create` env — an agent may still *set* a value for its
        // own command (e.g. `NODE_ENV=test`), which grants it nothing it did
        // not already have. What it can no longer do is inherit DeFlowd's.
        env: {
          ...options.childEnv,
          ...(request.env === undefined || request.env === null
            ? {}
            : Object.fromEntries(request.env.map((e) => [e.name, e.value]))),
        },
      });

      const terminal: Terminal = {
        child,
        chunks: [],
        bytes: 0,
        truncated: false,
        exit: null,
        capture: options.openCapture?.(terminalId) ?? null,
        published: null,
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

    fullOutput(terminalId) {
      const terminal = get(terminalId);
      if (terminal.capture === null) return null;
      // Published once and remembered: content addressing makes a second
      // publish harmless, but it is still a rename and an fsync.
      terminal.published ??= terminal.capture.publish();
      return terminal.published;
    },

    waitForExit: (terminalId) => get(terminalId).exited,

    /**
     * ACP `terminal/kill`, which is a **group** kill: the command was spawned
     * `detached`, and anything it spawned in turn shares its pgid.
     *
     * Through `killTree` like every other signal in the daemon (KAR-08.6 AC1).
     * A local `process.kill(-pid, …)` here was a second copy of the one
     * function whose positive-pid variant leaves grandchildren compiling — and
     * it had no answer for `pid === 0`, where the negation signals DeFlowd's own
     * process group. `killTree` refuses that pid instead of taking the daemon
     * down; a group that has already been reaped comes back as `'gone'`.
     */
    kill(terminalId) {
      const pid = get(terminalId).child.pid;
      if (pid === undefined) return;
      killTree(pid, 'SIGKILL');
    },

    release(terminalId) {
      const terminal = get(terminalId);
      released.push(Buffer.concat(terminal.chunks).toString('utf8'));
      // An unpublished capture is a staged file nobody will ever ask for, so
      // releasing the terminal is what unlinks it. A published one is already
      // in the store under its digest and is not this service's to remove.
      if (terminal.published === null) terminal.capture?.discard();
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
