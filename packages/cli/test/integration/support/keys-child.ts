/**
 * EPIC-21-S15's *"a session configured to throw once the stream is open"*.
 *
 * A child rather than an in-process spec because the claim is about a real
 * terminal: the only vantage point that can answer whether a process gave the
 * terminal back is the pty master, after the process has gone. Asking the
 * suspect for an alibi is what an in-process assertion would be.
 *
 * It opens the keyboard through the **shipped** `openKeyboard`/`withKeyboard`
 * — not a copy of their two lines — so what the pty observes is the production
 * restore path and not a re-implementation of it that happens to be correct.
 *
 * `throw` is the scenario; `wait` is its control: the same child, the same raw
 * mode, ended by a signal instead. A restore that only worked on the throw path
 * would pass one and fail the other.
 */
import process from 'node:process';
import { openKeyboard, withKeyboard } from '../../../src/run/session/keyboard.ts';

/** Two lines on purpose: in raw mode a bare `\n` moves down without returning
 * to column 0, so a message printed by a process that has not restored the
 * terminal renders as a diagonal staircase. */
export const THROWN_MESSAGE = 'the session fell over\nand it said so on a second line';

const mode = process.argv[2] ?? 'throw';

const keyboard = openKeyboard({
  stdin: process.stdin,
  onIntent: (intent) => {
    process.stdout.write(`intent:${intent}\n`);
  },
});

process.stdout.write('raw\n');

await withKeyboard(keyboard, async () => {
  if (mode === 'throw') throw new Error(THROWN_MESSAGE);
  // `wait` — held open until a signal ends it, which is the other half of AC4.
  await new Promise<never>(() => {
    /* never resolves */
  });
});
