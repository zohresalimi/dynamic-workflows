/**
 * KAR-18.3 AC3's Ctrl-C contract, extracted so KAR-21.2 can **reuse** it.
 *
 * The behaviour is not new and none of it is restated here as a decision. The
 * daemon owns execution and was spawned into its own process group, so the
 * terminal's SIGINT never reaches it: killing the viewer of a six-hour run
 * should not kill the run. But a person pressing Ctrl-C usually means "stop". So
 * the first press says exactly what it did and what the two alternatives are,
 * and then waits three seconds — a second press inside that window is the cancel
 * they meant, and silence is the detach they were told about. The process cannot
 * exit on the first press and still hear a second one, which is why the window
 * exists rather than an immediate exit.
 *
 * What KAR-21.2 changes is only **where the press comes from**. Once raw mode is
 * on the terminal stops turning Ctrl-C into SIGINT and delivers byte 0x03
 * instead, so a session that did not decode it would silently have removed the
 * one interactive verb `deflow run` already had. Both paths — the SIGINT handler
 * the command always had, and the `interrupt` intent — call `press()` on this
 * one object. That is what makes "the session adds no third meaning to Ctrl-C" a
 * fact about the code rather than a promise in a comment: there is one
 * implementation and a session is not able to reach past it.
 *
 * Time is a seam (NF9): the window is a `sleep` the caller supplies, so a spec
 * resolves a promise where an operator waits three seconds.
 */
import { RUN_EXIT_CODES } from './exit-codes.ts';

/** How long a second Ctrl-C has to arrive before the detach stands (AC3). */
export const DETACH_WINDOW_MS = 3_000;

/**
 * AC3's sentence, verbatim.
 *
 * Both alternatives, because detach-by-default is surprising and a message that
 * named only one would leave the operator guessing about the other.
 */
export function detachSentence(runId: string): string {
  return (
    `detached — run ${runId} continues; 'deflow run --attach ${runId}' to watch, ` +
    `'deflow cancel ${runId}' to stop\n`
  );
}

export interface InterruptOptions {
  readonly runId: string;
  /** The transcript writer — the session's when there is one, so the sentence
   * lands above the frame rather than through it. */
  readonly out: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  /** Close the event stream. Called on the first press; a stream that opens
   * afterwards is closed by its own caller, which is what `pressed()` is for. */
  readonly closeStream: () => void;
  readonly cancel: () => Promise<{ readonly message: string }>;
  /** A **ref'd** wait. `systemClock.setTimer` unrefs, which is right for a
   * daemon's ticker and wrong here: while the stream is closed and this is the
   * only thing outstanding, an unref'd timer would let the runtime decide the
   * command had finished and exit before the window was over. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly windowMs?: number;
}

export interface Interrupt {
  /** One Ctrl-C, from a signal or from a decoded key. */
  press(): void;
  /** Whether anything has been pressed yet. */
  pressed(): boolean;
  /** Resolves once the command should stop, with the code it should stop on. */
  readonly exitCode: Promise<number>;
}

export function createInterrupt(options: InterruptOptions): Interrupt {
  let presses = 0;
  /** Set the instant the outcome is decided, so a key held down after the
   * window closed cannot cancel a run the operator already detached from. */
  let settled = false;
  let resolve: (code: number) => void = () => {};

  const exitCode = new Promise<number>((settle) => {
    resolve = settle;
  });

  const finish = (): void => {
    if (settled) return;
    settled = true;
    resolve(RUN_EXIT_CODES.interrupted);
  };

  return {
    pressed: () => presses > 0,
    exitCode,

    press() {
      if (settled) return;
      presses += 1;

      if (presses === 1) {
        // The viewer stops; the run does not. Printed before anything is
        // awaited, so the sentence is on screen while the window is open.
        options.out(detachSentence(options.runId));
        options.closeStream();
        void options.sleep(options.windowMs ?? DETACH_WINDOW_MS).then(() => {
          // Only if no second press arrived — otherwise the cancel below owns
          // the outcome, and finishing here would race it.
          if (presses === 1) finish();
        });
        return;
      }

      // The third and later presses are somebody holding the key down; one
      // cancel is what they asked for and the daemon is not asked twice.
      if (presses === 2) {
        void options
          .cancel()
          .then((outcome) => {
            options.stderr(`deflow run: ${outcome.message}\n`);
          })
          .finally(finish);
      }
    },
  };
}
