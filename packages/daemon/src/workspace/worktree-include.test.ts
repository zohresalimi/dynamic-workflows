/**
 * KAR-07.5 test 1 — the `.worktreeinclude` decision, over the S19 table
 * (docs/09-workspace-and-safety.md §5.1 Layer 1).
 *
 * The decision has **two** conditions, not one, and the red this file exists
 * for is an implementation that checks either alone:
 *
 * - pattern only → `config/secrets.json` is tracked, so copying it puts a
 *   second, diverging copy of a committed file in the worktree.
 * - gitignored only → every gitignored file gets copied, `node_modules/`
 *   included, which is the disk blow-up §5.3 exists to warn about.
 *
 * The pattern half is delegated to real git (`ls-files --exclude-from`), so
 * gitignore syntax — anchoring, `**`, `!` negation, last-match-wins — is
 * git's own implementation rather than a second one written here that agrees
 * with it on the four cases someone thought to test. What is *not* delegable
 * is the conjunction, and that is what this table pins.
 *
 * Verifies: EPIC-07-S19 · AC1
 */
import { expect, it, describe as suite } from 'vitest';
import {
  GITIGNORED_AMONG_ARGS,
  INCLUDE_MATCH_ARGS_TRACKED,
  INCLUDE_MATCH_ARGS_UNTRACKED,
  type IncludeCandidate,
  includedFiles,
  WORKTREE_INCLUDE_FILE,
} from './worktree-include.ts';

const candidate = (
  path: string,
  flags: Partial<Omit<IncludeCandidate, 'path'>>,
): IncludeCandidate => ({
  path,
  matchesPattern: false,
  gitignored: false,
  tracked: false,
  ...flags,
});

suite('only files that match a pattern AND are gitignored are copied (AC1)', () => {
  const table: ReadonlyArray<{
    readonly file: string;
    readonly flags: Partial<Omit<IncludeCandidate, 'path'>>;
    readonly copied: boolean;
    readonly why: string;
  }> = [
    {
      file: '.env',
      flags: { matchesPattern: true, gitignored: true },
      copied: true,
      why: 'matches a pattern and is gitignored',
    },
    {
      file: '.env.local',
      flags: { gitignored: true },
      copied: false,
      why: 'gitignored but matches no pattern',
    },
    {
      file: 'config/secrets.json',
      flags: { matchesPattern: true, tracked: true },
      copied: false,
      why: 'matches a pattern but is tracked',
    },
    {
      // The row that catches a matcher checking only the pattern half. Nothing
      // in the other four rows does: they all fail the pattern test as well.
      file: 'local-notes.txt',
      flags: { matchesPattern: true },
      copied: false,
      why: 'matches a pattern but git does not ignore it, so it is not config git is hiding',
    },
    {
      file: '.env.production',
      flags: { gitignored: true },
      copied: false,
      why: 'excluded by the "!" negation, so git reports no pattern match',
    },
    {
      file: 'node_modules/left-pad/index.js',
      flags: { gitignored: true },
      copied: false,
      why: 'not a .worktreeinclude pattern',
    },
  ];

  for (const { file, flags, copied, why } of table) {
    it(`${file} is ${copied ? 'copied' : 'absent'} — ${why}`, () => {
      expect(includedFiles([candidate(file, flags)])).toEqual(copied ? [file] : []);
    });
  }

  it('keeps a tracked file out even when it is also gitignored', () => {
    // `.gitignore` does not un-track a file git already has in the index, and a
    // repository that ignores a path it also tracks is common enough (a
    // committed `.env.example` under an `.env*` rule) that the conjunction has
    // to survive it.
    const both = candidate('.env.example', {
      matchesPattern: true,
      gitignored: true,
      tracked: true,
    });

    expect(includedFiles([both])).toEqual([]);
  });

  it('returns the copies in a stable, sorted order', () => {
    const paths = ['config/secrets.json', '.env', 'a/b/.env'].map((path) =>
      candidate(path, { matchesPattern: true, gitignored: true }),
    );

    expect(includedFiles(paths)).toEqual(['.env', 'a/b/.env', 'config/secrets.json']);
  });

  it('copies nothing at all when there are no candidates', () => {
    expect(includedFiles([])).toEqual([]);
  });
});

suite('the git invocations that produce the candidates', () => {
  it("uses Claude Code's filename verbatim", () => {
    // §5.1: "Adopt Claude Code's .worktreeinclude convention verbatim". A
    // DeFlow-specific filename would be a new concept for every user who
    // already has one of these.
    expect(WORKTREE_INCLUDE_FILE).toBe('.worktreeinclude');
  });

  it('asks git for pattern matches with -z, and with only the include file as the exclude source', () => {
    const includePath = '/repo/.worktreeinclude';

    // --exclude-standard is deliberately absent: adding it would union
    // .gitignore into the pattern half and collapse the two conditions into
    // one, which is exactly the red the table above guards.
    expect(INCLUDE_MATCH_ARGS_UNTRACKED(includePath)).toEqual([
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      `--exclude-from=${includePath}`,
    ]);
    expect(INCLUDE_MATCH_ARGS_TRACKED(includePath)).toEqual([
      'ls-files',
      '-z',
      '--cached',
      '--ignored',
      `--exclude-from=${includePath}`,
    ]);
  });

  it('asks the gitignored half only about the paths the patterns matched, literally', () => {
    // `:(literal)` because a pathspec is a glob by default, and a real
    // `.worktreeinclude` naming `config/[dev].env` would otherwise be asked
    // about as a character class and answered "not ignored".
    expect(GITIGNORED_AMONG_ARGS(['.env', 'config/[dev].env'])).toEqual([
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ':(literal).env',
      ':(literal)config/[dev].env',
    ]);
  });
});
