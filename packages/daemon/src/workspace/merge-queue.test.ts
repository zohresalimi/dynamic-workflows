/**
 * KAR-07.7 test plan rows 1 and 2 — the merge queue's ordering, and the fact
 * that it is recomputed rather than remembered.
 *
 * Written before ./merge-queue.ts exists. The ordering is the whole of §7.1's
 * "lowest-overlap-first", and every one of these cases is a way of getting it
 * wrong that still looks ordered from the outside: reading the declared path
 * scopes instead of the probe table, missing the row because the pair was
 * canonicalised the other way round, counting a probe against another *node*
 * branch as though it were against the integration branch, or breaking a tie
 * on whatever the array order happened to be.
 *
 * Verifies: EPIC-07-S26 (first two scenarios) · AC2, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import type { ProbeVerdict } from './conflict-matrix.ts';
import { mergeQueue, queueOrder, reorderPayload, UnprobedBranchError } from './merge-queue.ts';

const INT = 'DeFlow/int/r1';
const branchOf = (node: string): string => `DeFlow/r1__${node}`;

/** A completed node branch waiting to be integrated. */
const candidate = (nodeId: string, completedAt: number) => ({
  nodeId,
  branch: branchOf(nodeId),
  completedAt,
});

/** A probe row as `conflict_probe` stores it: the pair canonicalised, and
 * `clean` derived from the path list. */
const probe = (a: string, b: string, paths: readonly string[]): ProbeVerdict => ({
  branchA: a,
  branchB: b,
  clean: paths.length === 0,
  paths,
});

const against = (node: string, paths: readonly string[]): ProbeVerdict =>
  // `DeFlow/i` < `DeFlow/r`, so the integration branch really is `branch_a`
  // for every node branch — the orientation the ledger writes.
  probe(INT, branchOf(node), paths);

// ── EPIC-07-S26, scenario 1 ─────────────────────────────────────────────────

suite('EPIC-07-S26: the initial order is ascending conflict count (AC2)', () => {
  // The scenario's own background: n1:0, n2:2, n3:1, n4:0.
  const candidates = [
    candidate('n1', 1_000),
    candidate('n2', 2_000),
    candidate('n3', 3_000),
    candidate('n4', 4_000),
  ];
  const probes = [
    against('n1', []),
    against('n2', ['src/a.ts', 'src/b.ts']),
    against('n3', ['src/a.ts']),
    against('n4', []),
  ];

  it('orders [n1, n4, n3, n2]', () => {
    expect(queueOrder(mergeQueue(candidates, probes, INT))).toEqual(['n1', 'n4', 'n3', 'n2']);
  });

  it('puts n1 before n4 because it completed first, not because it was listed first', () => {
    const reversed = candidates.toReversed();
    expect(queueOrder(mergeQueue(reversed, probes, INT))).toEqual(['n1', 'n4', 'n3', 'n2']);
  });

  it('carries the conflict count each branch was ordered on, so the order is auditable', () => {
    expect(mergeQueue(candidates, probes, INT).map((entry) => entry.pathCount)).toEqual([
      0, 0, 1, 2,
    ]);
  });

  it('breaks an exact completion-time tie on the node id, so two daemons agree', () => {
    const tied = [candidate('n9', 1_000), candidate('n2', 1_000)];
    const rows = [against('n9', []), against('n2', [])];
    expect(queueOrder(mergeQueue(tied, rows, INT))).toEqual(['n2', 'n9']);
  });
});

suite('the queue is read from the probe table, not from anywhere else', () => {
  it('finds the row when the pair was stored the other way round', () => {
    const rows = [probe(branchOf('n1'), INT, ['src/a.ts']), probe(branchOf('n2'), INT, [])];
    expect(queueOrder(mergeQueue([candidate('n1', 1), candidate('n2', 2)], rows, INT))).toEqual([
      'n2',
      'n1',
    ]);
  });

  it('ignores probes between two node branches', () => {
    // n1 conflicts violently with n2 — and that says nothing at all about
    // either one's cost against the integration branch, which is what the
    // queue orders on.
    const rows = [
      against('n1', []),
      against('n2', []),
      probe(branchOf('n1'), branchOf('n2'), ['src/a.ts', 'src/b.ts', 'src/c.ts']),
    ];
    expect(queueOrder(mergeQueue([candidate('n1', 1), candidate('n2', 2)], rows, INT))).toEqual([
      'n1',
      'n2',
    ]);
  });

  it('refuses to order a branch that has never been probed', () => {
    expect(() => mergeQueue([candidate('n1', 1)], [], INT)).toThrow(UnprobedBranchError);
  });

  it('names the unprobed branch in the error', () => {
    expect(() => mergeQueue([candidate('n1', 1)], [], INT)).toThrow(branchOf('n1'));
  });
});

// ── EPIC-07-S26, scenario 2 ─────────────────────────────────────────────────

suite('EPIC-07-S26: the queue is re-sorted after a merge (AC3)', () => {
  const remaining = [candidate('n2', 2_000), candidate('n3', 3_000), candidate('n4', 4_000)];
  const beforeMerge = [
    against('n2', ['src/a.ts', 'src/b.ts']),
    against('n3', ['src/a.ts']),
    against('n4', []),
  ];
  // The scenario's own numbers after n1 lands: n3:0, n4:1, n2:2.
  const afterMerge = [
    against('n2', ['src/a.ts', 'src/b.ts']),
    against('n3', []),
    against('n4', ['src/c.ts']),
  ];

  it('produces a different order from the same candidates on a new probe table', () => {
    expect(queueOrder(mergeQueue(remaining, beforeMerge, INT))).toEqual(['n4', 'n3', 'n2']);
    expect(queueOrder(mergeQueue(remaining, afterMerge, INT))).toEqual(['n3', 'n4', 'n2']);
  });

  it('the reorder payload carries both orders, so the change is observable', () => {
    const before = mergeQueue(remaining, beforeMerge, INT);
    const after = mergeQueue(remaining, afterMerge, INT);
    expect(reorderPayload(before, after)).toEqual({
      before: ['n4', 'n3', 'n2'],
      after: ['n3', 'n4', 'n2'],
    });
  });

  it('an empty queue still produces a payload, so "nothing is left" is recorded', () => {
    expect(reorderPayload([], [])).toEqual({ before: [], after: [] });
  });
});
