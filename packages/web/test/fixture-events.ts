/**
 * The recorded ledgers, for the specs that run in a **browser**.
 *
 * `./run-fixtures.ts` next door does the same job for the projection suite, and
 * it does it with `node:fs` — which a page cannot do. So the same `events.jsonl`
 * arrives here through Vite's `?raw` import instead, and is parsed through the
 * production `parseEvent` for exactly the reason that file gives: a spec that
 * fed a projection raw JSON would be testing it against a shape nothing on the
 * wire produces, and would keep passing after a payload schema changed
 * underneath it.
 *
 * One fixture is exported rather than all five. `happy-path-12` is the one
 * KAR-17.1's test plan names, and it is the one that happens to contain **all
 * seven display states at once** — pending, running, blocked, passed, failed,
 * abandoned and awaiting-human — which is what lets EPIC-17-S2's state matrix
 * be asserted against a real recording rather than against seven hand-built
 * nodes. Add another here when a spec needs one; do not hand-write events.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import raw from '../../../test/fixtures/runs/happy-path-12/events.jsonl?raw';

/** The run the `happy-path-12` recording belongs to. */
export const HAPPY_PATH_RUN = 'run_20260811T090000Z_a1b2c3';

let parsed: readonly Event[] | null = null;

/** Every event of `happy-path-12`, in `seq` order, parsed. */
export function happyPath12(): readonly Event[] {
  if (parsed !== null) return parsed;

  parsed = raw
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const result = parseEvent(JSON.parse(line));
      if (result.status !== 'ok') {
        throw new Error(
          `happy-path-12/events.jsonl line ${index + 1} is not readable by this build: ` +
            `${JSON.stringify(result)} — rebuild the fixture from its own script`,
        );
      }
      return result.event;
    });
  return parsed;
}
