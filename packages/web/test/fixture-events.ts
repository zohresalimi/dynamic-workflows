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
 * Two of the fixtures are exported rather than all of them, and each earns its
 * place:
 *
 * - **`happy-path-12`** is the one KAR-17.1's test plan names, and it is the one
 *   that happens to contain **all seven display states at once** — pending,
 *   running, blocked, passed, failed, abandoned and awaiting-human — which is
 *   what lets EPIC-17-S2's state matrix be asserted against a real recording
 *   rather than against seven hand-built nodes. It is also the only recording
 *   carrying a `pin.integrity_violated` and the `safety.pin-integrity-violated`
 *   failure that goes with it, which is KAR-17.4 AC6.
 * - **`compaction`** is the only ledger holding **one `context.compacted` of
 *   each fidelity** — an `exact` one DeFlow measured both ends of, and a
 *   `partial` one the vendor reported a `pre_tokens` for and nothing else. It is
 *   exported from a real `ledger.db` rather than assembled, and KAR-17.4's
 *   *"render the gap as a gap"* has nothing to render without it.
 *
 * Add another here when a spec needs one; do not hand-write events.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import compactionRaw from '../../../test/fixtures/runs/compaction/events.jsonl?raw';
import happyRaw from '../../../test/fixtures/runs/happy-path-12/events.jsonl?raw';

/** The run the `happy-path-12` recording belongs to. */
export const HAPPY_PATH_RUN = 'run_20260811T090000Z_a1b2c3';

/** The run the `compaction` recording belongs to. */
export const COMPACTION_RUN = 'run_20260806T120000Z_c0ffee';

const cache = new Map<string, readonly Event[]>();

function parse(name: string, raw: string): readonly Event[] {
  const held = cache.get(name);
  if (held !== undefined) return held;

  const events = raw
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const result = parseEvent(JSON.parse(line));
      if (result.status !== 'ok') {
        throw new Error(
          `${name}/events.jsonl line ${index + 1} is not readable by this build: ` +
            `${JSON.stringify(result)} — rebuild the fixture from its own script`,
        );
      }
      return result.event;
    });

  cache.set(name, events);
  return events;
}

/** Every event of `happy-path-12`, in `seq` order, parsed. */
export const happyPath12 = (): readonly Event[] => parse('happy-path-12', happyRaw);

/** Every event of `compaction`, in `seq` order, parsed. */
export const compactionRun = (): readonly Event[] => parse('compaction', compactionRaw);
