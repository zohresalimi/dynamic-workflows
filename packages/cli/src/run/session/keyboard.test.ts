/**
 * KAR-21.2 AC3, AC4, AC6 — the impure edge, and the one promise it must never
 * break.
 *
 * Raw mode is a **global mutation of the operator's terminal**. A process that
 * enters it and dies without restoring leaves a shell with no echo and no line
 * editing, and the remedy is `reset` or a new window — worse than anything this
 * epic adds. So the restoration is registered in one place, is idempotent, and
 * is asserted here on every path a unit test can reach: return, throw, and each
 * of the three signals. The paths a unit test *cannot* reach — a real terminal
 * being handed back after a real kill — are EPIC-21-S13, S14 and S15, under a
 * real pty.
 *
 * Every seam here is injected rather than mocked: `stdin` is a plain object
 * recording what was asked of it, and the signal registry is a map. Nothing in
 * this file touches `process`.
 *
 * Verifies: EPIC-21-S13, EPIC-21-S14, EPIC-21-S15 (unit half) · AC3, AC4, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  FATAL_SIGNALS,
  type FatalSignal,
  openKeyboard,
  type RawInput,
  withKeyboard,
} from './keyboard.ts';
import type { Intent } from './keys.ts';

const ESC = String.fromCodePoint(0x1b);
const CTRL_C = String.fromCodePoint(0x03);

interface Recorder {
  readonly stdin: RawInput;
  /** Every `setRawMode` argument, in order. */
  readonly rawModeCalls: boolean[];
  /** Pushes a `data` event at whatever is listening. */
  emit(chunk: string): void;
  readonly listeners: () => number;
  readonly resumed: () => number;
  readonly paused: () => number;
}

function recorder(): Recorder {
  const rawModeCalls: boolean[] = [];
  const data: ((chunk: string) => void)[] = [];
  let resumed = 0;
  let paused = 0;

  const stdin: RawInput = {
    setRawMode(raw) {
      rawModeCalls.push(raw);
    },
    setEncoding() {
      /* the encoding is a detail of the stream, not of the decoder */
    },
    on(_event, listener) {
      data.push(listener);
    },
    off(_event, listener) {
      const index = data.indexOf(listener);
      if (index >= 0) data.splice(index, 1);
    },
    resume() {
      resumed += 1;
    },
    pause() {
      paused += 1;
    },
  };

  return {
    stdin,
    rawModeCalls,
    emit: (chunk) => {
      // A copy: a listener may close the keyboard, which deregisters itself
      // mid-iteration, and that is a path this file deliberately exercises.
      for (const listener of data.slice()) listener(chunk);
    },
    listeners: () => data.length,
    resumed: () => resumed,
    paused: () => paused,
  };
}

/** A signal registry that is a `Map` rather than a process. */
function signals(): {
  readonly onSignal: (signal: FatalSignal, handler: () => void) => () => void;
  raise(signal: FatalSignal): void;
  readonly registered: () => FatalSignal[];
} {
  const handlers = new Map<FatalSignal, (() => void)[]>();
  return {
    onSignal: (signal, handler) => {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler]);
      return () => {
        handlers.set(
          signal,
          (handlers.get(signal) ?? []).filter((entry) => entry !== handler),
        );
      };
    },
    raise: (signal) => {
      // Copied for the same reason as `emit`: the handler under test is exactly
      // the one that deregisters itself.
      for (const handler of (handlers.get(signal) ?? []).slice()) handler();
    },
    registered: () => [...handlers.entries()].filter(([, list]) => list.length > 0).map(([s]) => s),
  };
}

/** A timer seam, so the escape wait is a value a test advances rather than a
 * race a test hopes for (NF9). */
function timers(): {
  readonly setTimer: (ms: number, fn: () => void) => { cancel(): void };
  fire(): void;
  readonly pending: () => number;
} {
  let queue: (() => void)[] = [];
  return {
    setTimer: (_ms, fn) => {
      queue.push(fn);
      return {
        cancel() {
          queue = queue.filter((entry) => entry !== fn);
        },
      };
    },
    fire: () => {
      const due = queue;
      queue = [];
      for (const fn of due) fn();
    },
    pending: () => queue.length,
  };
}

interface Harness {
  readonly input: Recorder;
  readonly signal: ReturnType<typeof signals>;
  readonly timer: ReturnType<typeof timers>;
  readonly intents: Intent[];
  readonly fatal: FatalSignal[];
  readonly keyboard: ReturnType<typeof openKeyboard>;
}

function harness(): Harness {
  const input = recorder();
  const signal = signals();
  const timer = timers();
  const intents: Intent[] = [];
  const fatal: FatalSignal[] = [];

  const keyboard = openKeyboard({
    stdin: input.stdin,
    onIntent: (intent) => intents.push(intent),
    onSignal: signal.onSignal,
    onFatal: (received) => fatal.push(received),
    setTimer: timer.setTimer,
  });

  return { input, signal, timer, intents, fatal, keyboard };
}

suite('raw mode is entered once and given back once (AC3, AC4)', () => {
  it('enters raw mode when it is opened, and reads the keyboard', () => {
    const { input, intents, keyboard } = harness();

    expect(input.rawModeCalls).toEqual([true]);
    expect(input.listeners()).toBe(1);
    expect(input.resumed()).toBe(1);

    input.emit('a');

    expect(intents).toEqual(['answer']);
    keyboard.close();
  });

  it('gives the terminal back on close, and twice is not twice (AC4)', () => {
    const { input, keyboard } = harness();

    keyboard.close();
    keyboard.close();
    keyboard.close();

    // Not `[true, false, false, false]`: "does not restore twice" is the whole
    // clause, and a `setRawMode(false)` on a stream somebody else has since
    // taken over is exactly the bug idempotence is for.
    expect(input.rawModeCalls).toEqual([true, false]);
    expect(input.listeners()).toBe(0);
    expect(input.paused()).toBe(1);
  });

  it('stops decoding once it is closed', () => {
    const { input, intents, keyboard } = harness();

    keyboard.close();
    input.emit('a');

    expect(intents).toEqual([]);
  });

  it('registers the restoration for every signal AC4 names', () => {
    const { signal, keyboard } = harness();

    expect(signal.registered().toSorted()).toEqual([...FATAL_SIGNALS].toSorted());

    keyboard.close();

    // And deregisters them: a handler left behind holds the process open and
    // outlives the terminal it was restoring.
    expect(signal.registered()).toEqual([]);
  });

  for (const received of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(`restores the terminal on ${received}`, () => {
      const { input, signal } = harness();

      signal.raise(received);

      expect(input.rawModeCalls).toEqual([true, false]);
    });
  }

  it('re-raises SIGTERM and SIGHUP after restoring, and never SIGINT', () => {
    // SIGINT is KAR-18.3 AC3's: the first press detaches and the command
    // returns an exit code of its own. A keyboard that killed the process here
    // would replace that contract with a third meaning.
    const term = harness();
    term.signal.raise('SIGTERM');
    expect(term.fatal).toEqual(['SIGTERM']);

    const hup = harness();
    hup.signal.raise('SIGHUP');
    expect(hup.fatal).toEqual(['SIGHUP']);

    const int = harness();
    int.signal.raise('SIGINT');
    expect(int.fatal).toEqual([]);
  });

  it('restores once when a signal arrives and close follows', () => {
    const { input, signal, keyboard } = harness();

    signal.raise('SIGHUP');
    keyboard.close();

    expect(input.rawModeCalls).toEqual([true, false]);
  });
});

suite('the escape wait is a timer the caller owns (AC2)', () => {
  it('holds a lone escape, and yields dismiss when the wait passes', () => {
    const { input, intents, timer, keyboard } = harness();

    input.emit(ESC);

    expect(intents).toEqual([]);
    expect(timer.pending()).toBe(1);

    timer.fire();

    expect(intents).toEqual(['dismiss']);
    keyboard.close();
  });

  it('cancels the wait when the rest of the sequence arrives', () => {
    const { input, intents, timer, keyboard } = harness();

    input.emit(ESC);
    input.emit('[A');

    expect(intents).toEqual(['select-up']);
    expect(timer.pending()).toBe(0);
    keyboard.close();
  });

  it('cancels the wait on close, so nothing fires after the terminal is back', () => {
    const { input, timer, keyboard } = harness();

    input.emit(ESC);
    keyboard.close();

    expect(timer.pending()).toBe(0);
  });
});

suite('Ctrl-C arrives as a byte once raw mode is on (AC5)', () => {
  it('decodes it to the interrupt intent rather than swallowing it', () => {
    // In raw mode the terminal stops turning Ctrl-C into SIGINT, so a session
    // that did not decode this byte would have silently removed the one
    // interactive verb `deflow run` already had.
    const { input, intents, keyboard } = harness();

    input.emit(CTRL_C);

    expect(intents).toEqual(['interrupt']);
    keyboard.close();
  });
});

suite('withKeyboard gives the terminal back whatever happens (AC4)', () => {
  it('restores after the body returns', async () => {
    const input = recorder();
    const opened = openKeyboard({
      stdin: input.stdin,
      onIntent: () => {},
      onSignal: () => () => {},
    });

    const value = await withKeyboard(opened, () => Promise.resolve(7));

    expect(value).toBe(7);
    expect(input.rawModeCalls).toEqual([true, false]);
  });

  it('restores before the throw leaves it, and rethrows unchanged', async () => {
    // The order is the whole point. In raw mode a bare `\n` moves down without
    // returning to column 0, so a stack trace printed by a process that has not
    // restored the terminal renders as a diagonal staircase — at exactly the
    // moment the operator most needs to read it (EPIC-21-S15).
    const input = recorder();
    const opened = openKeyboard({
      stdin: input.stdin,
      onIntent: () => {},
      onSignal: () => () => {},
    });
    const boom = new Error('the session fell over\nand said so on two lines');

    let restoredWhenThrown: boolean | undefined;
    await expect(
      withKeyboard(opened, () => {
        restoredWhenThrown = input.rawModeCalls.includes(false);
        return Promise.reject(boom);
      }),
    ).rejects.toBe(boom);

    expect(restoredWhenThrown).toBe(false);
    expect(input.rawModeCalls).toEqual([true, false]);
  });
});
