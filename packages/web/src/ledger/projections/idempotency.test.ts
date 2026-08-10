/**
 * KAR-16.3 AC10 — the same event applied twice changes nothing, for all seven.
 *
 * Verifies: EPIC-16-S23, EPIC-16-S24 · AC10, AC11
 *
 * This is not a defensive nicety. `subscribe` backfills a newly watched run
 * from the cursor the *connection* opened at, and a reconnect re-delivers from
 * the tab's own cursor — both windows overlap events the tab already applied,
 * **by design** (docs/11 §5). So the overlap is a designed-in property of the
 * subscribe path rather than an error case, and a projection that double-counted
 * would corrupt a number the Operator is about to make a decision on, silently,
 * on a perfectly healthy stream.
 *
 * The guard is a per-projection `seq` high-water mark and never a global dedupe
 * set: a set of every envelope ever seen is unbounded memory, which is exactly
 * what KAR-16.4 exists to prevent.
 */
import { expect, it, describe as suite } from 'vitest';
import { ledger, type RunFixture, unknownKind } from '../../../test/run-fixtures.ts';
import { PROJECTIONS, type ProjectionModule } from './index.ts';

const FIXTURES: readonly RunFixture[] = [
  'happy-path-12',
  'three-patches',
  'compaction',
  'gate-failure-repair',
];

/** The fixture each projection has something to say about. */
const HOME: Readonly<Record<string, RunFixture>> = {
  plan: 'happy-path-12',
  planHistory: 'three-patches',
  blackboard: 'happy-path-12',
  context: 'compaction',
  gates: 'gate-failure-repair',
  cost: 'happy-path-12',
  timeline: 'happy-path-12',
};

function foldedTo<S>(module: ProjectionModule<S>, fixture: RunFixture): S {
  const state = module.create();
  for (const event of ledger(fixture)) module.apply(state, event);
  return state;
}

suite('EPIC-16-S23 — double-apply is a no-op (AC10)', () => {
  it.each(PROJECTIONS)('$name is deep-equal after the last envelope is applied twice', (module) => {
    const fixture = HOME[module.name] ?? 'happy-path-12';
    const events = ledger(fixture);
    const last = events.at(-1);
    if (last === undefined) throw new Error(`${fixture} is empty`);

    const state = foldedTo(module, fixture);
    const before = structuredClone(state);
    module.apply(state, last);

    expect(state).toEqual(before);
  });

  it.each(PROJECTIONS)('$name is deep-equal after EVERY envelope is applied twice', (module) => {
    const fixture = HOME[module.name] ?? 'happy-path-12';

    const once = foldedTo(module, fixture);
    const twice = module.create();
    for (const event of ledger(fixture)) {
      module.apply(twice, event);
      module.apply(twice, event);
    }

    expect(twice).toEqual(once);
  });
});

suite('EPIC-16-S24 — subscribe-backfill overlaps the cursor (AC10)', () => {
  it.each(PROJECTIONS)('$name is byte-identical after a replayed backfill window', (module) => {
    const fixture = HOME[module.name] ?? 'happy-path-12';
    const events = ledger(fixture);
    // The daemon backfills from the cursor the *connection* opened at, so the
    // window that arrives overlaps the tail the tab already folded.
    const overlap = events.slice(Math.max(0, events.length - 6));

    const state = foldedTo(module, fixture);
    const before = structuredClone(state);
    for (const event of overlap) module.apply(state, event);

    expect(state).toEqual(before);
  });

  it.each(PROJECTIONS)('$name never rewinds its own cursor on a stale frame', (module) => {
    const fixture = HOME[module.name] ?? 'happy-path-12';
    const state = foldedTo(module, fixture);
    const applied = seqOf(state);
    const [first] = ledger(fixture);
    if (first === undefined) throw new Error(`${fixture} is empty`);

    module.apply(state, first);

    expect(seqOf(state)).toBe(applied);
  });
});

suite('AC11 — an unknown kind is ignored by every projection', () => {
  it.each(PROJECTIONS)('$name neither throws nor partially mutates', (module) => {
    const fixture = HOME[module.name] ?? 'happy-path-12';
    const runId = ledger(fixture)[0]?.runId ?? '';

    const state = foldedTo(module, fixture);
    const before = structuredClone(state);
    const applied = seqOf(state);

    expect(() => {
      module.apply(state, unknownKind(applied + 1_000, runId));
    }).not.toThrow();

    // Everything but the cursor. The cursor *must* move: an event this build
    // cannot read has still been seen, and a client that did not record that
    // would re-request it on every reconnect for the life of the run.
    expect({ ...(state as object), appliedSeq: applied }).toEqual(before);
    expect(seqOf(state)).toBe(applied + 1_000);
  });

  it.each(FIXTURES)('every projection folds %s and then shrugs off a foreign kind', (fixture) => {
    const runId = ledger(fixture)[0]?.runId ?? '';

    for (const module of PROJECTIONS) {
      const clean = foldedTo(module, fixture);
      const noisy = foldedTo(module, fixture);
      // A newer daemon's kind, arriving after everything this build understands
      // — which is the real shape of the problem, because the kind was added on
      // a backend this tab was not built against.
      module.apply(noisy, unknownKind(900_000, runId));

      expect({ ...(noisy as object), appliedSeq: 0 }).toEqual({
        ...(clean as object),
        appliedSeq: 0,
      });
    }
  });
});

const seqOf = (state: unknown): number => (state as { appliedSeq: number }).appliedSeq;
