/**
 * KAR-07.7 — the stage-line form of `git merge-tree --write-tree`
 * (docs/09-workspace-and-safety.md §7.2; AC5).
 *
 * Written before the parser existed. `--name-only`'s framing is already pinned
 * against real git in ../../test/integration/conflict-probe.test.ts; this is
 * the *other* section of the same output — the `<mode> <oid> <stage>\t<path>`
 * entries §7.2 names as the source of a conflict's shape — and it has the same
 * failure mode: a parser that runs to the end of the string instead of
 * stopping at the section terminator returns git's informational messages as
 * though they were repository entries.
 *
 * Verifies: EPIC-07-S27 · KAR-07.7 AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { parseMergeTreeStages } from './merge-tree.ts';

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

suite('parseMergeTreeStages (AC5)', () => {
  it('reads the tree oid and the three stages of a content conflict', () => {
    const parsed = parseMergeTreeStages(
      framed([
        stageLine(OID_A, 1, 'a.txt'),
        stageLine(OID_B, 2, 'a.txt'),
        stageLine(OID_C, 3, 'a.txt'),
      ]),
    );

    expect(parsed?.treeOid).toBe(TREE);
    expect(parsed?.stages).toEqual([
      { mode: '100644', oid: OID_A, stage: 1, path: 'a.txt' },
      { mode: '100644', oid: OID_B, stage: 2, path: 'a.txt' },
      { mode: '100644', oid: OID_C, stage: 3, path: 'a.txt' },
    ]);
  });

  it('stops at the section terminator rather than reading the messages as stages', () => {
    const parsed = parseMergeTreeStages(
      framed(
        [stageLine(OID_B, 2, 'a.txt'), stageLine(OID_C, 3, 'a.txt')],
        ['1', 'a.txt', 'CONFLICT (contents)', 'CONFLICT (content): Merge conflict in a.txt'],
      ),
    );
    expect(parsed?.stages).toHaveLength(2);
  });

  it('returns null when stdout does not begin with a tree oid — the merge never ran', () => {
    expect(parseMergeTreeStages('merge-tree: nope - not something we can merge\n')).toBeNull();
    expect(parseMergeTreeStages('')).toBeNull();
  });

  it('keeps a path containing a space intact', () => {
    const parsed = parseMergeTreeStages(framed([stageLine(OID_B, 2, 'my dir/a b.txt')]));
    expect(parsed?.stages[0]?.path).toBe('my dir/a b.txt');
  });
});
