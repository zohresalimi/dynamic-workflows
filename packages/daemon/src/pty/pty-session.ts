/**
 * One live pty, and the fan-out in front of it (KAR-15.8, docs/11 §7.7).
 *
 * The design rule is one sentence and everything here follows from it: **the
 * socket is a live interactive channel only.** Output is written to the
 * durable sink first and handed to attached viewers second, so a panel that
 * closes loses nothing, and detaching the last viewer neither kills the child
 * nor stops the writing. That is what makes a terminal panel a *view* of a
 * node rather than the node's lifeline — the same relationship the SSE stream
 * has to the ledger.
 *
 * The pty itself is `@lydell/node-pty` (docs/02-tech-stack.md §10.9), imported
 * dynamically and behind an injectable loader: it is the project's one
 * `optionalDependency`, and a platform without a prebuild has to degrade to a
 * pipe spawn rather than fail to start a run. The degraded session runs the
 * same child, writes the same `io_chunk` rows and answers `tty: false`, which
 * is the honest signal for "this node has no terminal" — `resize` on it is a
 * no-op because there is genuinely nothing to resize.
 *
 * `detached: true` and `killTree` for the same reason as everywhere else in
 * the daemon (KAR-08.6 AC1): a vendor CLI spawns its own children, and a
 * positive-pid kill leaves them compiling.
 */
import { killTree } from '@DeFlow/adapters';
import type { NodeId, RunId } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { log } from '../logging.ts';

const pty = log.child({ mod: 'pty' });

/**
 * Where a session's output lands **regardless of who is watching** — the
 * daemon passes `ledgerPtySink`, which appends `io_chunk` rows.
 *
 * A port rather than a `Db`: this module owns a process, not a database, and
 * the one test that matters for AC4 is "the bytes are on disk after the panel
 * closed", which reads the real table through the real sink.
 */
export interface PtyOutputSink {
  write(bytes: Buffer): void;
}

export interface PtyExit {
  readonly code: number | null;
  readonly signal: number | null;
}

/** One attached viewer: a terminal panel's socket, and nothing else. */
export interface PtyAttachment {
  onData(bytes: Buffer): void;
  onExit(exit: PtyExit): void;
}

/** The subset of `@lydell/node-pty` this module uses. */
interface PtyLike {
  readonly pid: number;
  onData(listener: (data: unknown) => void): { dispose(): void };
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModuleLike {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
      encoding?: string | null;
    },
  ): PtyLike;
}

export interface PtySessionOptions {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 1-based, matching `io_chunk.attempt` (docs/05 §5.1). */
  readonly attempt: number;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  /**
   * Built with `buildChildEnv()` (KAR-08.4) and required for the same reason
   * `TerminalService` requires it: a default of `process.env` is the ambient
   * authority bug wearing an optional parameter.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  readonly sink: PtyOutputSink;
  /**
   * How the optional native module is loaded. Injected so the no-TTY
   * degradation is a *tested* path rather than a branch that only runs on a
   * platform nobody in the project has.
   */
  readonly loadPty?: () => Promise<PtyModuleLike | null>;
}

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export interface PtySession {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly pid: number | undefined;
  /** False when the platform has no `@lydell/node-pty`: a pipe, not a terminal. */
  readonly tty: boolean;
  /** Bytes from a keystroke, straight through to the child's stdin. */
  write(bytes: Uint8Array): void;
  /** A no-op without a tty, because there is nothing there to resize. */
  resize(cols: number, rows: number): void;
  /** Returns the detach function. Detaching never touches the child. */
  attach(attachment: PtyAttachment): () => void;
  /**
   * How many panels are watching. Zero is an ordinary state — a node runs the
   * same whether anyone is looking — and it is what "the socket was refused
   * before it existed" is asserted against.
   */
  readonly viewers: number;
  readonly exit: PtyExit | null;
  waitForExit(): Promise<PtyExit>;
  /** The kill switch's group kill (KAR-08.6): the child and everything it spawned. */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * The real loader. `@lydell/node-pty` resolving to nothing is not an error
 * here — it is the platform saying it has no prebuild, and the caller degrades.
 */
export async function loadNodePty(): Promise<PtyModuleLike | null> {
  try {
    return (await import('@lydell/node-pty')) as unknown as PtyModuleLike;
  } catch (error) {
    pty.warn({ err: String(error) }, 'no @lydell/node-pty; terminals degrade to a pipe spawn');
    return null;
  }
}

export async function openPtySession(options: PtySessionOptions): Promise<PtySession> {
  const cols = options.cols ?? DEFAULT_COLS;
  const rows = options.rows ?? DEFAULT_ROWS;
  const args = [...(options.args ?? [])];
  const load = options.loadPty ?? loadNodePty;
  const module = await load();

  const attachments = new Set<PtyAttachment>();
  let exit: PtyExit | null = null;
  let settleExit: (exit: PtyExit) => void = () => undefined;
  const exited = new Promise<PtyExit>((resolve) => {
    settleExit = resolve;
  });

  /**
   * Durable first, viewers second — and each viewer inside its own try, so one
   * broken socket cannot cost the next one its output or the ledger its row.
   */
  const publish = (bytes: Buffer): void => {
    options.sink.write(bytes);
    for (const attachment of attachments) {
      try {
        attachment.onData(bytes);
      } catch (error) {
        pty.warn({ err: String(error) }, 'an attached viewer threw on data; detaching it');
        attachments.delete(attachment);
      }
    }
  };

  const finish = (next: PtyExit): void => {
    if (exit !== null) return;
    exit = next;
    settleExit(next);
    // A copy of the keys, not of the set: `onExit` may detach, and mutating a
    // Set while iterating it skips the neighbour of whatever was removed.
    for (const attachment of Array.from(attachments)) {
      try {
        attachment.onExit(next);
      } catch (error) {
        pty.warn({ err: String(error) }, 'an attached viewer threw on exit');
      }
    }
    attachments.clear();
  };

  const attach = (attachment: PtyAttachment): (() => void) => {
    // An attach after the exit still owes the viewer the exit: a panel that
    // opened one tick late would otherwise wait forever for a frame that has
    // already been sent.
    if (exit !== null) {
      attachment.onExit(exit);
      return () => undefined;
    }
    attachments.add(attachment);
    return () => {
      attachments.delete(attachment);
    };
  };

  /**
   * The half that differs between a real pty and the degraded pipe spawn. It
   * is assembled separately and the session is built from it in **one** object
   * literal, because `exit` is a getter and a getter does not survive a
   * spread: `{ ...base }` would freeze it at the value it had when the session
   * was created, which is `null` forever.
   */
  interface Transport {
    readonly pid: number | undefined;
    readonly tty: boolean;
    write(bytes: Uint8Array): void;
    resize(cols: number, rows: number): void;
    kill(signal?: NodeJS.Signals): void;
  }

  const build = (transport: Transport): PtySession => ({
    runId: options.runId,
    nodeId: options.nodeId,
    attempt: options.attempt,
    pid: transport.pid,
    tty: transport.tty,
    write: (bytes) => transport.write(bytes),
    resize: (nextCols, nextRows) => transport.resize(nextCols, nextRows),
    attach,
    get viewers(): number {
      return attachments.size;
    },
    get exit(): PtyExit | null {
      return exit;
    },
    waitForExit: () => exited,
    kill: (signal) => transport.kill(signal),
  });

  if (module === null) {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.on('data', (bytes: Buffer) => publish(bytes));
    child.stderr.on('data', (bytes: Buffer) => publish(bytes));
    child.once('exit', (code, signal) =>
      finish({ code, signal: signal === null ? null : signalNumber(signal) }),
    );
    child.once('error', (error) => {
      pty.warn({ err: String(error) }, 'the degraded terminal child failed to start');
      finish({ code: null, signal: null });
    });

    return build({
      pid: child.pid,
      tty: false,
      write: (bytes) => void child.stdin.write(Buffer.from(bytes)),
      resize: () => undefined,
      kill: (signal = 'SIGKILL') => killChild(child.pid, signal),
    });
  }

  const terminal = module.spawn(options.command, args, {
    name: options.env['TERM'] ?? 'xterm-256color',
    cols,
    rows,
    cwd: options.cwd,
    env: { ...options.env },
    // Raw bytes, not decoded strings: a pty splits UTF-8 wherever the read
    // landed, and a decoder here would turn one truncated character into a
    // replacement character *in the durable record* rather than in a
    // renderer, where it can still be repaired by the next chunk.
    encoding: null,
  });

  terminal.onData((data) => publish(toBuffer(data)));
  terminal.onExit(({ exitCode, signal }) =>
    finish({ code: exitCode, signal: signal === undefined || signal === 0 ? null : signal }),
  );

  return build({
    pid: terminal.pid,
    tty: true,
    write: (bytes) => terminal.write(Buffer.from(bytes)),
    resize: (nextCols, nextRows) => terminal.resize(nextCols, nextRows),
    kill: (signal = 'SIGKILL') => killChild(terminal.pid, signal),
  });
}

/** `encoding: null` hands back a Buffer through a signature that says string. */
function toBuffer(data: unknown): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
}

function killChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  killTree(pid, signal);
}

/**
 * `node:child_process` reports a signal by name and node-pty by number, and
 * `PtyExit` carries one shape. The table is the POSIX one for the signals this
 * daemon actually sends (KAR-08.6's ladder); anything else lands as 0, which
 * reads as "signalled, name unknown" rather than as a wrong name.
 */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

function signalNumber(signal: NodeJS.Signals): number {
  return SIGNAL_NUMBERS[signal] ?? 0;
}
