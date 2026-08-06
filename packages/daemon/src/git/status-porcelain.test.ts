/**
 * KAR-07.4 test 1 — the `status --porcelain=v2 -z` parser, over the exact bytes
 * real git produced (docs/09-workspace-and-safety.md §4.4).
 *
 * The fixture is not invented. It was captured from `git status --porcelain=v2
 * -z` on git 2.50.1 (2026-08-06) in a repository holding, deliberately, the
 * three shapes that break a naive parser at once:
 *
 * - a **rename**, whose `2 ` record carries *two* NUL-terminated fields — the
 *   new path and then the old one — so a parser that treats every NUL field as
 *   one entry invents a fourth file that does not exist;
 * - **paths containing a space**, which `-z` does not quote, so a parser that
 *   splits the record on whitespace truncates `src/new name.ts` to `src/new`;
 * - an **untracked** file, whose record has no XY code at all.
 *
 * Every one of those is a file an agent's work could be in, and a parser that
 * loses one loses exactly the work KAR-07.4 exists to salvage.
 *
 * Verifies: EPIC-07-S17 · AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { isDirty, parseStatusPorcelainV2 } from './status-porcelain.ts';

const OID_A = '5626abf0f72e58d7a153368ba57db4c673c0e171';
const OID_B = '3367afdbbf91e638efe983616377c60477cc6612';

/** Captured from real git 2.50.1, 2026-08-06. Records are NUL-*terminated*,
 * and the rename's original path is a NUL field of its own. */
const REAL_STATUS = `${[
  `1 .M N... 100644 100644 100644 ${OID_A} ${OID_A} src/a.ts`,
  `2 R. N... 100644 100644 100644 ${OID_B} ${OID_B} R100 src/new name.ts`,
  'src/old name.ts',
  '? .gitignore',
  '? src/new.ts',
].join('\0')}\0`;

suite('the porcelain v2 -z parser reads what git actually wrote', () => {
  it('finds exactly the four entries, and does not invent a fifth from the rename', () => {
    const entries = parseStatusPorcelainV2(REAL_STATUS);

    expect(entries.map((entry) => entry.path)).toEqual([
      'src/a.ts',
      'src/new name.ts',
      '.gitignore',
      'src/new.ts',
    ]);
  });

  it('keeps a path containing a space whole', () => {
    const entries = parseStatusPorcelainV2(REAL_STATUS);

    expect(entries[1]).toEqual({
      kind: 'renamed',
      xy: 'R.',
      path: 'src/new name.ts',
      origPath: 'src/old name.ts',
    });
  });

  it('reads the modified tracked file with its XY code and no origPath', () => {
    expect(parseStatusPorcelainV2(REAL_STATUS)[0]).toEqual({
      kind: 'changed',
      xy: '.M',
      path: 'src/a.ts',
      origPath: null,
    });
  });

  it('reads an untracked file, which carries no XY code at all', () => {
    expect(parseStatusPorcelainV2(REAL_STATUS)[3]).toEqual({
      kind: 'untracked',
      xy: null,
      path: 'src/new.ts',
      origPath: null,
    });
  });

  it('an empty stream is a clean worktree, not a parse failure', () => {
    expect(parseStatusPorcelainV2('')).toEqual([]);
    expect(parseStatusPorcelainV2('\0')).toEqual([]);
    expect(isDirty(parseStatusPorcelainV2(''))).toBe(false);
    expect(isDirty(parseStatusPorcelainV2(REAL_STATUS))).toBe(true);
  });
});

suite('the record shapes porcelain v2 defines, one at a time', () => {
  it('reads an unmerged entry, whose path sits one field later than an ordinary one', () => {
    const record = `u UU N... 100644 100644 100644 100644 ${OID_A} ${OID_A} ${OID_B} src/conflicted file.ts\0`;

    expect(parseStatusPorcelainV2(record)).toEqual([
      { kind: 'unmerged', xy: 'UU', path: 'src/conflicted file.ts', origPath: null },
    ]);
  });

  it('reads an ignored entry, which only appears when --ignored was asked for', () => {
    expect(parseStatusPorcelainV2('! node_modules/\0')).toEqual([
      { kind: 'ignored', xy: null, path: 'node_modules/', origPath: null },
    ]);
  });

  it('reads a copy the same way as a rename, because both carry an original path', () => {
    const record = `2 C. N... 100644 100644 100644 ${OID_A} ${OID_A} C75 dst.ts\0src.ts\0`;

    expect(parseStatusPorcelainV2(record)).toEqual([
      { kind: 'renamed', xy: 'C.', path: 'dst.ts', origPath: 'src.ts' },
    ]);
  });

  it('skips the `# branch.*` headers --branch adds, rather than reporting them as files', () => {
    const stream = `# branch.oid ${OID_A}\0# branch.head main\0? new.ts\0`;

    expect(parseStatusPorcelainV2(stream)).toEqual([
      { kind: 'untracked', xy: null, path: 'new.ts', origPath: null },
    ]);
  });

  it('skips a record shape this build has never heard of, rather than throwing', () => {
    // Total, for the same reason ./worktree-porcelain.ts is: a daemon that
    // refuses to salvage because git grew a record is worse than a field it
    // does not show.
    expect(parseStatusPorcelainV2('z something new\0? new.ts\0')).toEqual([
      { kind: 'untracked', xy: null, path: 'new.ts', origPath: null },
    ]);
  });

  it('survives a trailing newline a layer appended, which execa can leave behind', () => {
    expect(parseStatusPorcelainV2('? src/new.ts\0\n')).toEqual([
      { kind: 'untracked', xy: null, path: 'src/new.ts', origPath: null },
    ]);
  });
});
