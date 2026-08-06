/**
 * KAR-07.3 — `nodeBranch`/`integrationBranch` and the domain-layer half of
 * ref-name validation (docs/09-workspace-and-safety.md §2, §2.1).
 *
 * Verifies: EPIC-07-S5 (composition), EPIC-07-S6 (the generator can never
 * reproduce the hierarchical shape), EPIC-07-S7 (the reject set) · KAR-07.3
 * test plan rows 1-2.
 */
import { mulberry32 } from '@DeFlow/testkit';
import { expect, it, describe as suite } from 'vitest';
import { integrationBranch, nodeBranch, salvageBranch, UnsafeRefError } from './branch-name.ts';

suite('S5: names are composed (test plan row 1)', () => {
  it('nodeBranch("r1", "n1") returns the flat scheme', () => {
    expect(nodeBranch('r1', 'n1')).toBe('DeFlow/r1__n1');
  });

  it('integrationBranch("r1") returns the reserved prefix', () => {
    expect(integrationBranch('r1')).toBe('DeFlow/int/r1');
  });

  it('neither name contains a slash beyond the two literal ones (AC1)', () => {
    expect(nodeBranch('r1', 'n1').split('/')).toHaveLength(2);
    expect(integrationBranch('r1').split('/')).toHaveLength(3);
  });
});

suite('S7: the domain layer rejects before git is ever asked (test plan row 2)', () => {
  const REJECTS: ReadonlyArray<readonly [string, string]> = [
    ['node.lock', 'a component ending in .lock is invalid'],
    ['a..b', '".." sequence'],
    ['trailing ', 'trailing space'],
    ['ref@{1}', '"@{" is invalid'],
    ['-n', 'leading dash is a flag, not a name'],
    ['N1', 'ids are normalized to a single case first'],
    ['a'.repeat(65), 'exceeds the 64-character BRANCH_SAFE bound'],
  ];

  it.each(REJECTS)('nodeId %j (%s) throws UnsafeRefError naming "nodeId"', (nodeId) => {
    let caught: unknown;
    try {
      nodeBranch('r1', nodeId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsafeRefError);
    expect((caught as UnsafeRefError).component).toBe('nodeId');
    expect((caught as UnsafeRefError).value).toBe(nodeId);
  });

  it('a valid nodeId does not throw', () => {
    expect(() => nodeBranch('r1', 'n1')).not.toThrow();
  });

  it('an unsafe runId is rejected too, naming "runId"', () => {
    let caught: unknown;
    try {
      nodeBranch('-r1', 'n1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsafeRefError);
    expect((caught as UnsafeRefError).component).toBe('runId');
  });

  it('integrationBranch validates runId with the same rule', () => {
    expect(() => integrationBranch('-r1')).toThrow(UnsafeRefError);
    expect(() => integrationBranch('R1')).toThrow(UnsafeRefError);
  });
});

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomValidId(random: () => number): string {
  const length = 1 + Math.floor(random() * 12);
  let id = '';
  for (let i = 0; i < length; i += 1) {
    id += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  // The generator above can produce a leading digit-only id that still
  // matches BRANCH_SAFE (digits are a valid first character too), so no
  // extra fixup is needed — every character it emits is already in
  // BRANCH_SAFE's class and it never emits ".lock" or "..".
  return id;
}

suite("S6: DeFlow's own generator can never produce the hierarchical shape", () => {
  it('200 random valid (runId, nodeId) pairs never produce more than two "/"', () => {
    const random = mulberry32(0x0705_0703); // KAR-07.3, fixed for reproducibility
    for (let i = 0; i < 200; i += 1) {
      const runId = randomValidId(random);
      const nodeId = randomValidId(random);
      const name = nodeBranch(runId, nodeId);
      expect(name.split('/')).toHaveLength(2);
    }
  });

  it('no generated name is a prefix of another followed by "/"', () => {
    const random = mulberry32(0x0705_0703);
    const names: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const runId = randomValidId(random);
      const nodeId = randomValidId(random);
      names.push(nodeBranch(runId, nodeId));
    }
    for (const a of names) {
      for (const b of names) {
        if (a === b) continue;
        expect(b.startsWith(`${a}/`)).toBe(false);
      }
    }
  });

  it('an integration branch is never a prefix (or suffix) collision with a node branch under the same run', () => {
    const int = integrationBranch('r1');
    const node = nodeBranch('r1', 'n1');
    expect(node.startsWith(`${int}/`)).toBe(false);
    expect(int.startsWith(`${node}/`)).toBe(false);
  });
});

suite('KAR-07.4 AC6: the throwaway branch a detached salvage lands on', () => {
  it('composes DeFlow/salvage/<runId>__<nodeId>', () => {
    expect(salvageBranch('r1', 'n2')).toBe('DeFlow/salvage/r1__n2');
  });

  it('validates both components with the same rule, naming the one that failed', () => {
    let caught: unknown;
    try {
      salvageBranch('r1', '-n2');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsafeRefError);
    expect((caught as UnsafeRefError).component).toBe('nodeId');
    expect(() => salvageBranch('R1', 'n2')).toThrow(UnsafeRefError);
  });

  it('cannot collide with a node branch: no id pair composes to the bare name "salvage"', () => {
    const random = mulberry32(0x0705_0704); // KAR-07.4, fixed for reproducibility
    for (let i = 0; i < 200; i += 1) {
      const runId = randomValidId(random);
      const nodeId = randomValidId(random);
      // refs/heads/DeFlow/salvage/ is a *directory*; every node branch is a
      // file directly under refs/heads/DeFlow/, and the `__` separator is
      // always there, so `DeFlow/salvage` is not a name nodeBranch can emit.
      expect(nodeBranch(runId, nodeId)).not.toBe('DeFlow/salvage');
      expect(salvageBranch(runId, nodeId).startsWith('DeFlow/salvage/')).toBe(true);
    }
  });

  it('is never flag-shaped, so the -- separator is belt and braces rather than the only guard', () => {
    expect(salvageBranch('r1', 'n2').startsWith('-')).toBe(false);
  });
});
