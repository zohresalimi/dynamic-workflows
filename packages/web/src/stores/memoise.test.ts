/**
 * KAR-16.4 — the memoisation the selectors are built on.
 *
 * Verifies: EPIC-16-S28 (scenario 2) · AC3, AC4
 *
 * `./run-store-rendering.test.ts` proves the consequence — one node changes,
 * one subtree is patched — through a real renderer. This file proves the two
 * properties that make it work and that a renderer cannot show you:
 *
 * 1. **Reuse is by content, not by identity.** The projection mutates its node
 *    objects in place, so "did this change?" cannot be `held === live`.
 * 2. **The span comparator looks inside `suspensions`.** That array is the one
 *    nested collection a projection in this codebase appends to in place, so a
 *    shallow compare is quietly wrong for it: an answered suspension is what
 *    turns six idle hours into a number, and it would never reach the screen.
 *
 * The cache pruning matters for the same reason everything else in this story
 * does — it is bounded by the plan, so a run that abandons a node stops paying
 * for it.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  copy,
  copySpan,
  edgeUnchanged,
  memoise,
  shallowUnchanged,
  spanUnchanged,
} from './memoise.ts';

interface Node {
  readonly id: string;
  phase: string | null;
  failure: { readonly reason: string } | null;
}

const node = (id: string, phase: string | null = null): Node => ({ id, phase, failure: null });

suite('memoise — reuse by content', () => {
  it('hands back the identical object when nothing changed', () => {
    const cache = new Map<string, Node>();
    const live = new Map([['a', node('a')]]);

    const first = memoise(cache, live, shallowUnchanged, copy);
    const second = memoise(cache, live, shallowUnchanged, copy);

    expect(second[0]).toBe(first[0]);
  });

  it('hands back a fresh object for an entry mutated in place', () => {
    const cache = new Map<string, Node>();
    const one = node('a');
    const live = new Map([['a', one]]);
    const first = memoise(cache, live, shallowUnchanged, copy);

    // Exactly what `applyPlan` does on `node.progress`: the same object, a
    // different field. Identity comparison sees nothing here.
    one.phase = 'running';
    const second = memoise(cache, live, shallowUnchanged, copy);

    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.phase).toBe('running');
    expect(first[0]?.phase).toBeNull();
  });

  it('leaves the unchanged neighbours of a changed entry alone', () => {
    const cache = new Map<string, Node>();
    const live = new Map([
      ['a', node('a')],
      ['b', node('b')],
      ['c', node('c')],
    ]);
    const first = memoise(cache, live, shallowUnchanged, copy);

    (live.get('b') as Node).phase = 'running';
    const second = memoise(cache, live, shallowUnchanged, copy);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[2]).toBe(first[2]);
  });

  it('never hands out the projection’s own object', () => {
    const cache = new Map<string, Node>();
    const one = node('a');

    const [snapshot] = memoise(cache, new Map([['a', one]]), shallowUnchanged, copy);

    expect(snapshot).not.toBe(one);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('freezes the list, so a caller cannot sort the store’s answer in place', () => {
    const list = memoise(
      new Map<string, Node>(),
      new Map([['a', node('a')]]),
      shallowUnchanged,
      copy,
    );

    expect(Object.isFrozen(list)).toBe(true);
  });

  it('drops the snapshot of an entry the projection no longer holds', () => {
    const cache = new Map<string, Node>();
    const live = new Map([
      ['a', node('a')],
      ['b', node('b')],
    ]);
    memoise(cache, live, shallowUnchanged, copy);

    live.delete('b');
    const after = memoise(cache, live, shallowUnchanged, copy);

    expect(cache.size).toBe(1);
    expect(after.map((one) => one.id)).toEqual(['a']);
  });

  it('sees a nested object that was replaced wholesale, which is how nodes change', () => {
    const cache = new Map<string, Node>();
    const one = node('a');
    const live = new Map([['a', one]]);
    const first = memoise(cache, live, shallowUnchanged, copy);

    one.failure = { reason: 'exit-2' };
    const second = memoise(cache, live, shallowUnchanged, copy);

    expect(second[0]).not.toBe(first[0]);
  });
});

suite('edgeUnchanged — the carries array is compared by content', () => {
  const edge = (carries: string[]) => ({ id: 'a→b:data', kind: 'data', carries });

  it('reuses an edge whose carries are the same values in a new array', () => {
    expect(edgeUnchanged(edge(['x', 'y']), edge(['x', 'y']))).toBe(true);
  });

  it('refreshes one whose carries changed', () => {
    expect(edgeUnchanged(edge(['x']), edge(['x', 'y']))).toBe(false);
    expect(edgeUnchanged(edge(['x']), edge(['z']))).toBe(false);
  });
});

suite('spanUnchanged — the suspensions array is appended to in place', () => {
  const span = () => ({
    nodeId: 'n-a',
    endSeq: null as number | null,
    endTs: null as number | null,
    open: true,
    outcome: null as string | null,
    suspendedMs: null as number | null,
    suspensions: [] as { untilSeq: number | null; untilTs: number | null }[],
  });

  it('reuses a span nothing happened to', () => {
    expect(spanUnchanged(span(), span())).toBe(true);
  });

  it('refreshes one that closed', () => {
    const live = span();
    live.open = false;
    live.endSeq = 12;
    live.outcome = 'passed';

    expect(spanUnchanged(span(), live)).toBe(false);
  });

  it('refreshes one a suspension was appended to', () => {
    const live = span();
    live.suspensions.push({ untilSeq: null, untilTs: null });

    expect(spanUnchanged(span(), live)).toBe(false);
  });

  it('refreshes one whose open suspension was answered', () => {
    const held = span();
    held.suspensions.push({ untilSeq: null, untilTs: null });
    const live = span();
    live.suspensions.push({ untilSeq: 40, untilTs: 1_754_140_000_040 });

    // The failure a shallow compare would produce: same length, same array
    // shape, a different answer. Six idle hours become a number here.
    expect(spanUnchanged(held, live)).toBe(false);
  });

  it('copies the suspensions, so the snapshot cannot grow underneath a render', () => {
    const live = span();
    live.suspensions.push({ untilSeq: null, untilTs: null });

    const snapshot = copySpan(live);
    live.suspensions.push({ untilSeq: null, untilTs: null });

    expect(snapshot.suspensions).toHaveLength(1);
    expect(Object.isFrozen(snapshot.suspensions)).toBe(true);
  });
});
