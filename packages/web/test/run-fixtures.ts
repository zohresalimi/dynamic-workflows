/**
 * The recorded ledgers the projection suite folds, as the `Event`s a projection
 * actually receives.
 *
 * Not a mock and not a hand-written array: each file under
 * `test/fixtures/runs/<name>/events.jsonl` is either an export of a real
 * `ledger.db` (`compaction`, `gate-failure-repair`, `crash-resume-seq-gap` —
 * see `packages/ledger/scripts/export-events-jsonl.ts`) or an assembly built
 * through the production constructors (`happy-path-12`, `three-patches` — see
 * `packages/core/scripts/build-ui-run-fixtures.ts`).
 *
 * **Every line is re-read through `parseEvent` here too**, and that is not
 * belt-and-braces. A projection's whole contract is over the parsed `Event`
 * union, so a spec that fed it raw JSON would be testing the projection against
 * a shape nothing on the wire produces — and would keep passing after a payload
 * schema changed underneath it.
 *
 * `node:fs` and `node:path` are why this lives in `test/` rather than beside the
 * projections: the modules under test import neither, and the lint rule in
 * `packages/web/src/ledger/projections/purity.test.ts` is what keeps it that
 * way.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RUN_FIXTURES = [
  'happy-path-12',
  'three-patches',
  'compaction',
  'gate-failure-repair',
  'crash-resume-seq-gap',
] as const;

export type RunFixture = (typeof RUN_FIXTURES)[number];

const DIR = new URL('../../../test/fixtures/runs/', import.meta.url);

const cache = new Map<RunFixture, readonly Event[]>();

/** Every event of `fixture`, in `seq` order, parsed. */
export function ledger(fixture: RunFixture): readonly Event[] {
  const held = cache.get(fixture);
  if (held !== undefined) return held;

  const path = fileURLToPath(new URL(`${fixture}/events.jsonl`, DIR));
  const events = readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const parsed = parseEvent(JSON.parse(line));
      if (parsed.status !== 'ok') {
        throw new Error(
          `${fixture}/events.jsonl line ${index + 1} is not readable by this build: ` +
            `${JSON.stringify(parsed)} — rebuild the fixture from its own script`,
        );
      }
      return parsed.event;
    });

  cache.set(fixture, events);
  return events;
}

/** Folds `apply` over every event of `fixture`, and returns the final state. */
export function fold<S>(
  fixture: RunFixture,
  create: () => S,
  apply: (state: S, event: Event) => void,
): S {
  const state = create();
  for (const event of ledger(fixture)) apply(state, event);
  return state;
}

/**
 * An envelope of a kind this build has never heard of.
 *
 * Cast rather than declared, and deliberately: the whole point is that no
 * member of the `Event` union has this `kind`, so there is no honest way to
 * type it — which is exactly the situation a tab is in when the daemon it is
 * talking to is newer than it is.
 */
export function unknownKind(seq: number, runId: string): Event {
  return {
    seq,
    runId,
    ts: 1_786_000_000_000,
    kind: 'node.telemetry.sampled',
    v: 1,
    epoch: 3,
    payload: { node: 'impl-signup', rssBytes: 41_000_000 },
  } as unknown as Event;
}
