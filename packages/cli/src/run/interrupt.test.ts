/**
 * KAR-21.2 AC5 / EPIC-21-S16 — the one interactive verb the command already had
 * is unchanged.
 *
 * KAR-18.3 AC3's contract, extracted so a session can reuse it rather than
 * restate it: the first press prints `detachSentence(runId)` and detaches, and
 * a second press inside `DETACH_WINDOW_MS` cancels. A session is a place where
 * "quit the UI" would be a natural third meaning to add, and adding it would
 * silently make Ctrl-C kill runs it used to leave alone — so the sentence and
 * the window are referenced by name here, not re-specified.
 *
 * Extracted rather than rewritten: `run.ts` calls this from both the SIGINT
 * handler it always had and the `interrupt` intent KAR-21.2 adds, which is what
 * makes "the session adds no third meaning" a fact about the code rather than a
 * promise. `test/integration/run-signals.test.ts` still drives the same
 * contract through a real process and a real signal.
 *
 * Time is injected — `sleep` is a seam, per NF9 — so the window is a promise
 * this file resolves rather than three seconds a test waits.
 *
 * Verifies: EPIC-21-S16 · AC5 · test plan #16
 */
import { expect, it, describe as suite } from 'vitest';
import { RUN_EXIT_CODES } from './exit-codes.ts';
import { createInterrupt, DETACH_WINDOW_MS, detachSentence } from './interrupt.ts';

const RUN_ID = 'run_20260816T101500Z_0a0a0a';

interface Harness {
  readonly out: string[];
  readonly closes: () => number;
  readonly cancels: () => number;
  readonly windows: number[];
  /** Resolves the pending detach window, as if it had elapsed. */
  elapse(): void;
  readonly interrupt: ReturnType<typeof createInterrupt>;
}

function harness(options: { readonly cancelMessage?: string } = {}): Harness {
  const out: string[] = [];
  const windows: number[] = [];
  let closes = 0;
  let cancels = 0;
  let release: (() => void) | null = null;

  const interrupt = createInterrupt({
    runId: RUN_ID,
    out: (chunk) => out.push(chunk),
    stderr: (chunk) => out.push(chunk),
    closeStream: () => {
      closes += 1;
    },
    cancel: () => {
      cancels += 1;
      return Promise.resolve({ message: options.cancelMessage ?? `run ${RUN_ID} cancelled` });
    },
    sleep: (ms) => {
      windows.push(ms);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });

  return {
    out,
    windows,
    closes: () => closes,
    cancels: () => cancels,
    elapse: () => {
      release?.();
      release = null;
    },
    interrupt,
  };
}

suite('EPIC-21-S16 — one press detaches (AC5)', () => {
  it('prints exactly detachSentence(runId), closes the stream, cancels nothing', async () => {
    const h = harness();

    h.interrupt.press();

    // Exactly the sentence: not a paraphrase and not a second line about keys.
    expect(h.out.join('')).toBe(detachSentence(RUN_ID));
    expect(h.closes()).toBe(1);
    expect(h.cancels()).toBe(0);

    h.elapse();
    expect(await h.interrupt.exitCode).toBe(RUN_EXIT_CODES.interrupted);
    expect(h.cancels()).toBe(0);
  });

  it('waits DETACH_WINDOW_MS by default, and the caller may narrow it', () => {
    const h = harness();
    h.interrupt.press();
    expect(h.windows).toEqual([DETACH_WINDOW_MS]);
  });
});

suite('EPIC-21-S16 — two presses inside the window cancel (AC5)', () => {
  it('calls cancelRun exactly once and exits with the interrupted code', async () => {
    const h = harness();

    h.interrupt.press();
    h.interrupt.press();

    expect(await h.interrupt.exitCode).toBe(RUN_EXIT_CODES.interrupted);
    expect(h.cancels()).toBe(1);
    // The daemon's own sentence about what it did, on stderr, once.
    expect(h.out.join('')).toContain(`run ${RUN_ID} cancelled`);
  });

  it('cancels once however many times the key is held down', async () => {
    const h = harness();

    h.interrupt.press();
    h.interrupt.press();
    h.interrupt.press();
    h.interrupt.press();

    expect(await h.interrupt.exitCode).toBe(RUN_EXIT_CODES.interrupted);
    expect(h.cancels()).toBe(1);
  });

  it('detaches when the window closes first, and a later press cancels nothing', async () => {
    const h = harness();

    h.interrupt.press();
    h.elapse();

    expect(await h.interrupt.exitCode).toBe(RUN_EXIT_CODES.interrupted);

    h.interrupt.press();

    expect(h.cancels()).toBe(0);
  });
});

suite('the stream a press could not close is closed when it opens (AC5)', () => {
  it('closes a stream that arrived after the first press', () => {
    const h = harness();

    h.interrupt.press();
    expect(h.closes()).toBe(1);

    // KAR-18.3: a Ctrl-C that landed before the stream was open still detaches
    // — the press printed its sentence, and this closes what it could not.
    expect(h.interrupt.pressed()).toBe(true);
  });

  it('reports nothing pressed before anything was', () => {
    expect(harness().interrupt.pressed()).toBe(false);
  });
});
