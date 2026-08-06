/**
 * KAR-07.6 — the pure half of the conflict matrix: which pairs get probed,
 * which stored rows may still be believed, and which node a detected conflict
 * demotes (docs/09-workspace-and-safety.md §6.2, §7.3).
 *
 * All three are decisions, not I/O, so they are unit-tested against plain
 * values here and the integration spec next door only has to prove that real
 * `git` and real SQLite agree with them.
 *
 * Verifies: EPIC-07-S25, EPIC-07-S30 · KAR-07.6 test plan rows 5, 6 · AC4-AC6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  demotions,
  type InFlightBranch,
  isProbeStale,
  type ProbeVerdict,
  probeTargets,
} from './conflict-matrix.ts';

const INT = 'DeFlow/int/r1';

const inFlight = (nodeId: string, startedAt: number): InFlightBranch => ({
  nodeId,
  branch: `DeFlow/r1__${nodeId}`,
  startedAt,
});

/** n1 started first, then n2, then n3 — the ordering every demotion turns on. */
const n1 = inFlight('n1', 1_000);
const n2 = inFlight('n2', 2_000);
const n3 = inFlight('n3', 3_000);

const verdict = (a: InFlightBranch, b: InFlightBranch, paths: readonly string[]): ProbeVerdict => ({
  branchA: a.branch,
  branchB: b.branch,
  clean: paths.length === 0,
  paths,
});

suite('probeTargets — the fan-out after one write node commits (AC4)', () => {
  it('probes the integration branch and every other in-flight branch, and nothing else', () => {
    expect(probeTargets(n2, [n1, n2, n3], INT)).toEqual([INT, n1.branch, n3.branch]);
  });

  it('never probes the committing branch against itself', () => {
    expect(probeTargets(n2, [n1, n2, n3], INT)).not.toContain(n2.branch);
  });

  it('is the integration branch alone when nothing else is in flight', () => {
    expect(probeTargets(n1, [n1], INT)).toEqual([INT]);
  });

  it('emits five targets for the third of five in-flight branches (EPIC-07-S25)', () => {
    const five = [n1, n2, n3, inFlight('n4', 4_000), inFlight('n5', 5_000)];
    expect(probeTargets(n3, five, INT)).toHaveLength(5);
  });
});

suite('isProbeStale — both tips are stored so staleness is a comparison (AC5)', () => {
  const row = {
    branchA: n1.branch,
    branchB: n2.branch,
    aCommit: 'a'.repeat(40),
    bCommit: 'b'.repeat(40),
  };

  it('is fresh when neither branch has advanced', () => {
    expect(
      isProbeStale(
        row,
        new Map([
          [n1.branch, 'a'.repeat(40)],
          [n2.branch, 'b'.repeat(40)],
        ]),
      ),
    ).toBe(false);
  });

  it('is stale when branch_a has advanced (test plan row 6)', () => {
    expect(
      isProbeStale(
        row,
        new Map([
          [n1.branch, 'c'.repeat(40)],
          [n2.branch, 'b'.repeat(40)],
        ]),
      ),
    ).toBe(true);
  });

  it('is stale when branch_b has advanced', () => {
    expect(
      isProbeStale(
        row,
        new Map([
          [n1.branch, 'a'.repeat(40)],
          [n2.branch, 'c'.repeat(40)],
        ]),
      ),
    ).toBe(true);
  });

  it('is stale when a tip is unknown — an unanswerable question is never a hit', () => {
    expect(isProbeStale(row, new Map([[n1.branch, 'a'.repeat(40)]]))).toBe(true);
  });
});

suite('demotions — the later starter is the one that blocks (AC6, test plan row 5)', () => {
  it('demotes the later starter of the one conflicting pair among three in flight', () => {
    const result = demotions(
      [n1, n2, n3],
      [verdict(n1, n2, ['src/a.ts']), verdict(n1, n3, []), verdict(n2, n3, [])],
    );

    expect(result).toEqual([
      {
        node: 'n2',
        conflictsWith: 'n1',
        branch: n2.branch,
        otherBranch: n1.branch,
        paths: ['src/a.ts'],
      },
    ]);
  });

  it('picks by start time, not by branch name or by id order', () => {
    // "n1" sorts before "n2" and starts *later*: a demotion chosen by name or
    // by the order of the in-flight list would name the wrong node here.
    const late = { nodeId: 'n1', branch: 'DeFlow/r1__n1', startedAt: 9_000 };
    const early = { nodeId: 'n2', branch: 'DeFlow/r1__n2', startedAt: 1_000 };

    expect(demotions([late, early], [verdict(late, early, ['src/a.ts'])])).toEqual([
      {
        node: 'n1',
        conflictsWith: 'n2',
        branch: late.branch,
        otherBranch: early.branch,
        paths: ['src/a.ts'],
      },
    ]);
  });

  it('reports nothing when every pair is clean — an overlap that never conflicts never blocks', () => {
    expect(demotions([n1, n2, n3], [verdict(n1, n2, []), verdict(n2, n3, [])])).toEqual([]);
  });

  it('ignores a conflict against a branch no in-flight node owns, such as the integration branch', () => {
    const againstIntegration: ProbeVerdict = {
      branchA: INT,
      branchB: n2.branch,
      clean: false,
      paths: ['src/a.ts'],
    };

    expect(demotions([n1, n2], [againstIntegration])).toEqual([]);
  });

  it('demotes each later starter once, whichever counterpart it collided with first', () => {
    const result = demotions(
      [n1, n2, n3],
      [verdict(n1, n3, ['src/a.ts']), verdict(n2, n3, ['src/b.ts'])],
    );

    expect(result).toEqual([
      {
        node: 'n3',
        conflictsWith: 'n1',
        branch: n3.branch,
        otherBranch: n1.branch,
        paths: ['src/a.ts'],
      },
    ]);
  });

  it('breaks an exact start-time tie by node id, so two daemons agree on the victim', () => {
    const a = { nodeId: 'n1', branch: 'DeFlow/r1__n1', startedAt: 5_000 };
    const b = { nodeId: 'n2', branch: 'DeFlow/r1__n2', startedAt: 5_000 };

    expect(demotions([a, b], [verdict(a, b, ['src/a.ts'])])[0]?.node).toBe('n2');
  });
});
