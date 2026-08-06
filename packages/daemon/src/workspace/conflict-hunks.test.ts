/**
 * KAR-07.7 — the pure half of "the conflicted hunks, and only the conflicted
 * hunks" (docs/09-workspace-and-safety.md §7.2; AC5).
 *
 * Written before ./conflict-hunks.ts exists. The hunk reader must return the
 * conflicted regions and nothing else, because everything it returns is going
 * into a paid context window and everything it silently drops is a conflict the
 * resolver never sees. (The stage-line parser it is fed from lives with the
 * subcommand, in ../git/merge-tree.ts, and is tested there.)
 *
 * Verifies: EPIC-07-S27 · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { parseMergeTreeStages } from '../git/merge-tree.ts';
import { conflictedPaths, extractConflictHunks, MalformedConflictError } from './conflict-hunks.ts';

const OID_A = 'f0f2307464291'.padEnd(40, '0');
const OID_B = '06dbbe8d2863d'.padEnd(40, '0');
const OID_C = '7555a85da063e'.padEnd(40, '0');
const TREE = 'c5f9ef0a7e578'.padEnd(40, '0');

/** `git merge-tree --write-tree -z`'s real framing, verified on git 2.50.1:
 * the tree oid, then one `<mode> <oid> <stage>\t<path>` field per stage, then
 * an empty field, then the informational messages. */
const framed = (entries: readonly string[], messages: readonly string[] = []): string =>
  [TREE, ...entries, '', ...messages].join('\0');

const stageLine = (oid: string, stage: number, path: string): string =>
  `100644 ${oid} ${stage}\t${path}`;

suite('conflictedPaths (AC5)', () => {
  it('lists each conflicted path once, in stage order', () => {
    const parsed = parseMergeTreeStages(
      framed([
        stageLine(OID_A, 1, 'src/a.ts'),
        stageLine(OID_B, 2, 'src/a.ts'),
        stageLine(OID_C, 3, 'src/a.ts'),
        stageLine(OID_B, 2, 'src/b.ts'),
        stageLine(OID_C, 3, 'src/b.ts'),
      ]),
    );
    expect(conflictedPaths(parsed?.stages ?? [])).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

suite('extractConflictHunks (AC5)', () => {
  const merged = [
    'l1',
    '<<<<<<< DeFlow/int/r1',
    'N1',
    '=======',
    'N2',
    '>>>>>>> DeFlow/r1__n2',
    'l3',
    'l4',
    '<<<<<<< DeFlow/int/r1',
    'X1',
    '=======',
    'X2',
    '>>>>>>> DeFlow/r1__n2',
    'l5',
  ].join('\n');

  it('returns each conflicted region, markers included', () => {
    expect(extractConflictHunks(merged)).toEqual([
      '<<<<<<< DeFlow/int/r1\nN1\n=======\nN2\n>>>>>>> DeFlow/r1__n2',
      '<<<<<<< DeFlow/int/r1\nX1\n=======\nX2\n>>>>>>> DeFlow/r1__n2',
    ]);
  });

  it('returns no unconflicted line at all — that is the whole point (AC5)', () => {
    const hunks = extractConflictHunks(merged).join('\n');
    for (const clean of ['l1', 'l3', 'l4', 'l5']) {
      expect(hunks.split('\n')).not.toContain(clean);
    }
  });

  it('keeps the diff3 base section when git wrote one', () => {
    const diff3 = ['<<<<<<< ours', 'A', '||||||| base', 'B', '=======', 'C', '>>>>>>> theirs'].join(
      '\n',
    );
    expect(extractConflictHunks(diff3)).toEqual([diff3]);
  });

  it('is empty for a file with no markers', () => {
    expect(extractConflictHunks('l1\nl2\n')).toEqual([]);
  });

  it('throws on an unterminated hunk rather than dropping it', () => {
    // Silently returning [] here would hand the resolver a packet that says
    // "nothing conflicted" about a file that did.
    expect(() => extractConflictHunks('l1\n<<<<<<< ours\nA\n=======\nB\n')).toThrow(
      MalformedConflictError,
    );
  });
});
