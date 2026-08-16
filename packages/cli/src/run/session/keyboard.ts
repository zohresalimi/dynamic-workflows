/**
 * KAR-21.2 AC3, AC4 — the one file that touches the operator's terminal, and the
 * one promise it must never break.
 *
 * Raw mode is a **global mutation of the operator's terminal**. Something that
 * enters it and dies without restoring leaves a shell with no echo and no line
 * editing, and the remedy is `reset` or a new window — a worse outcome than
 * anything this epic adds. So:
 *
 * - the restoration is registered in **one place** (`close`), not at each exit;
 * - it is **idempotent**, because the signal path and the `finally` path both
 *   reach it and a `setRawMode(false)` on a stream somebody else has since taken
 *   over is precisely the bug idempotence is for;
 * - it runs **before** anything is printed on the way out. In raw mode a bare
 *   `\n` moves down without returning to column 0, so a stack trace from a
 *   process that has not restored the terminal renders as a diagonal staircase
 *   — unreadable at exactly the moment the operator most needs to read it. That
 *   is why `withKeyboard` closes in a `finally` rather than after the rethrow.
 *
 * Raw mode is entered **only when the input is a terminal** (AC3), and that
 * decision is not made here: it is made once by the caller, where the streams
 * are known, and expressed by whether this is called at all. `setRawMode` on a
 * pipe throws, so a guard that lived at a call site would be one forgotten guard
 * away from `deflow run` dying at startup in CI.
 *
 * Every seam is **injected, never mocked**: the input is an interface a test
 * satisfies with a plain object, the signal registry is a function, and the
 * escape wait is a timer the caller owns (NF9). `test/integration/support/
 * keys-child.ts` runs the shipped functions under a real pty so what the master
 * observes after the child has gone is this restore path and not a copy of it.
 */
import process from 'node:process';
import type { DecodedKey, Intent } from './keys.ts';
import { createKeyDecoder, ESCAPE_WAIT_MS } from './keys.ts';

/**
 * The part of an input stream this needs, and nothing more.
 *
 * Narrow on purpose: `process.stdin` satisfies it, and so does an object a test
 * writes in ten lines, which is what keeps every assertion below about
 * behaviour rather than about a mocking library.
 */
export interface RawInput {
  setRawMode(raw: boolean): void;
  setEncoding(encoding: 'utf8'): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  off(event: 'data', listener: (chunk: string) => void): void;
  resume(): void;
  pause(): void;
}

/**
 * The signals that end a process while it is holding the terminal.
 *
 * SIGHUP is not padding: it is what a closed ssh session sends, and an operator
 * whose link dropped is exactly the operator who then opens a new terminal and
 * finds the old shell unusable.
 */
export const FATAL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type FatalSignal = (typeof FATAL_SIGNALS)[number];

/**
 * The numbers a shell adds to 128 when it reports a signal death.
 *
 * Needed because this cannot re-raise. The obvious way to die of the signal you
 * just handled is `process.kill(process.pid, signal)`, and `test/
 * one-kill-site.test.ts` forbids that anywhere in the runtime tree: every signal
 * in DeFlow goes through `killTree`, because a second kill site is how the
 * positive-pid form gets reintroduced and quietly orphans an agent's
 * grandchildren (KAR-08.6 AC1). That rule is structural on purpose and a
 * terminal restore is not a good enough reason to put a hole in it.
 *
 * `128 + signo` is what the shell would have reported had the signal been left
 * to its default disposition, so `$?` reads the same to anything downstream.
 * What it does not reproduce is `WIFSIGNALED`, so a parent inspecting the wait
 * status rather than the code sees an exit where it would have seen a kill.
 * That is the price of the rule above, and it is stated rather than hidden.
 */
const SIGNAL_NUMBERS: Readonly<Record<FatalSignal, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

export interface Keyboard {
  /** Give the terminal back. Idempotent; safe from a signal handler. */
  close(): void;
}

/** What a caller asks for when it wants a keyboard — the whole of `run.ts`'s
 * side of the seam, so a test can pass its own `stdin` by spreading this. */
export interface KeyboardRequest {
  /**
   * One decoded key: what it means, and what it typed.
   *
   * KAR-21.4 added the second argument, and both facts travel because which of
   * them applies depends on whether a row is open — the caller's question, not
   * this file's. `text` is `null` for every key that typed nothing.
   */
  readonly onIntent: (intent: Intent, text: string | null) => void;
  /**
   * KAR-21.5 AC8 — anything else the caller owes the terminal, given back here.
   *
   * Called **after** the terminal is back and **before** the process is allowed
   * to stop, from the one `close` every path already reaches. `run.ts` passes
   * the session's own `close`, which erases the frame — and the reason it is
   * routed through here rather than registered separately is the signal path:
   * `onFatal` calls `process.exit`, so a `finally` in `run.ts` never runs and a
   * SIGTERM would leave the shell prompt printed on top of a stale status
   * region. One restoration site, two things restored.
   *
   * Must not throw: it runs inside a signal handler, where there is nobody left
   * to catch it.
   */
  readonly onRestore?: (() => void) | undefined;
}

export interface KeyboardOptions extends KeyboardRequest {
  readonly stdin: RawInput;
  /** Registers a handler and returns its deregistration. */
  readonly onSignal?: (signal: FatalSignal, handler: () => void) => () => void;
  /**
   * What to do once the terminal is back and a **fatal** signal is why.
   *
   * SIGINT never reaches it: KAR-18.3 AC3 owns Ctrl-C, the first press detaches
   * and `deflow run` returns an exit code of its own, and a keyboard that killed
   * the process here would replace that contract with a third meaning.
   */
  readonly onFatal?: (signal: FatalSignal) => void;
  readonly setTimer?: (ms: number, fn: () => void) => { cancel(): void };
}

const defaultOnSignal = (signal: FatalSignal, handler: () => void): (() => void) => {
  process.on(signal, handler);
  return () => {
    process.off(signal, handler);
  };
};

/**
 * Stop, now that the terminal is back.
 *
 * `process.exit` rather than `process.exitCode` — the whole reason this runs is
 * that the process was told to stop, and setting a code would leave the watch
 * loop running with nothing to report to. The terminal has already gone back by
 * the time this is called: `close()` runs first, so nothing here can write
 * through a raw terminal.
 */
const defaultOnFatal = (signal: FatalSignal): void => {
  process.exit(128 + SIGNAL_NUMBERS[signal]);
};

/** Unref'd: a 50 ms escape wait must never be the reason a finished command sits
 * there with nothing left to do. */
const defaultSetTimer = (ms: number, fn: () => void): { cancel(): void } => {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
};

export function openKeyboard(options: KeyboardOptions): Keyboard {
  const onSignal = options.onSignal ?? defaultOnSignal;
  const onFatal = options.onFatal ?? defaultOnFatal;
  const setTimer = options.setTimer ?? defaultSetTimer;

  const decoder = createKeyDecoder();
  let removals: (() => void)[] = [];
  let wait: { cancel(): void } | null = null;
  let closed = false;

  const cancelWait = (): void => {
    wait?.cancel();
    wait = null;
  };

  const emit = (keys: readonly DecodedKey[]): void => {
    for (const key of keys) options.onIntent(key.intent, key.text);
  };

  const listener = (chunk: string): void => {
    if (closed) return;
    cancelWait();
    emit(decoder.feed(chunk));
    // A held escape gets exactly one wait. If the rest of the sequence arrives
    // the next `data` event cancels it above; if nothing arrives the key meant
    // Escape, which is the other half of the ssh bug `keys.ts` describes.
    if (decoder.pending()) {
      wait = setTimer(ESCAPE_WAIT_MS, () => {
        wait = null;
        if (!closed) emit(decoder.flush());
      });
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    cancelWait();
    options.stdin.off('data', listener);
    options.stdin.setRawMode(false);
    options.stdin.pause();
    // After the terminal is back, so whatever this writes goes through a
    // restored one rather than rendering as a diagonal staircase (AC4).
    options.onRestore?.();
    for (const remove of removals) remove();
    removals = [];
  };

  options.stdin.setRawMode(true);
  options.stdin.setEncoding('utf8');
  options.stdin.on('data', listener);
  options.stdin.resume();

  // Registered after the terminal is borrowed, so there is never an instant
  // where a signal could find a handler with nothing to restore.
  removals = FATAL_SIGNALS.map((signal) =>
    onSignal(signal, () => {
      close();
      if (signal !== 'SIGINT') onFatal(signal);
    }),
  );

  return { close };
}

/**
 * Run `body` with the keyboard open, and give the terminal back whatever
 * happens.
 *
 * The `finally` is the whole function. It covers the normal return, the throw,
 * and the stream closing under the session — and it runs **before** the
 * rejection reaches whatever prints it, which is what stops an error message
 * rendering as a staircase.
 */
export async function withKeyboard<T>(keyboard: Keyboard, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } finally {
    keyboard.close();
  }
}
